import { Router } from 'express';
import { z } from 'zod';
import { DateTime } from 'luxon';
import { csvCell, money, toCents } from '../lib/http.js';
import { validate } from '../middleware/validate.js';
import { recordAudit } from '../services/audit.js';
import { getDateRange, getSettings } from '../services/settings.js';

const reportQuerySchema = z.object({
  from: z.iso.date(),
  to: z.iso.date(),
  userId: z.coerce.number().int().positive().optional(),
  fuelId: z.coerce.number().int().positive().optional(),
}).strict().superRefine((value, context) => {
  if (value.from > value.to) {
    context.addIssue({ code: 'custom', path: ['to'], message: 'to cannot be before from' });
    return;
  }
  const days = DateTime.fromISO(value.to).diff(DateTime.fromISO(value.from), 'days').days;
  if (days > 366) context.addIssue({ code: 'custom', path: ['to'], message: 'Date range cannot exceed 367 days' });
});

const monthlySchema = z.object({
  year: z.coerce.number().int().min(2020).max(new Date().getUTCFullYear()),
  month: z.coerce.number().int().min(1).max(12),
}).strict();

const csvQuerySchema = z.object({
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
}).strict().refine((value) => !value.from || !value.to || value.from <= value.to, 'from cannot be after to');

function percentageChange(current, previous) {
  if (previous === 0) return null;
  return Math.round(((current - previous) / Math.abs(previous)) * 10000) / 100;
}

function keyFor(date, fuelId, fuelType) {
  return `${date}|${fuelId ?? 'ALL'}|${fuelType ?? 'UNASSIGNED'}`;
}

function fuelKeyFor(map, row) {
  return row.fuel_id ?? row.fuel_type ?? 'UNASSIGNED';
}

function addTo(map, key, field, value) {
  const item = map.get(key) || { id: null, type: 'UNASSIGNED', litres: 0, formalCents: 0, recordedCents: 0, cogsCents: 0 };
  if (rowKeyId(item, key)) item.id = rowKeyId(item, key);
  item[field] = (item[field] || 0) + value;
  map.set(key, item);
}

function rowKeyId(item, key) {
  const parts = key.split('|');
  const id = parts[1];
  return id && id !== 'ALL' ? Number(id) : null;
}

function dateKeys(from, to) {
  const dates = [];
  let cursor = DateTime.fromISO(from);
  const end = DateTime.fromISO(to);
  while (cursor <= end) {
    dates.push(cursor.toISODate());
    cursor = cursor.plus({ days: 1 });
  }
  return dates;
}

export function buildSummary(db, from, to, filters = {}) {
  const settings = getSettings(db);
  const range = getDateRange(db, from, to);
  const zone = settings.timezone;
  const salesWhere = ['s.sold_at >= ?', 's.sold_at <= ?'];
  const salesParams = [range.startUtc, range.endUtc];
  if (filters.userId) { salesWhere.push('s.user_id = ?'); salesParams.push(filters.userId); }
  if (filters.fuelId) { salesWhere.push('s.fuel_id = ?'); salesParams.push(filters.fuelId); }
  const sales = db.prepare(`
    SELECT s.id, s.sold_at, s.user_id, s.fuel_id, s.fuel_type, s.mode, s.litres,
           s.amount_cents, s.cash_cents, s.mpesa_cents, s.payment_method
    FROM sales s
    WHERE ${salesWhere.join(' AND ')}
    ORDER BY s.sold_at
  `).all(...salesParams);

  const meterWhere = ['r."date" >= ?', 'r."date" <= ?'];
  const meterParams = [from, to];
  if (filters.fuelId) { meterWhere.push('r.fuel_id = ?'); meterParams.push(filters.fuelId); }
  const salesMeters = db.prepare(`
    SELECT r."date", r.fuel_id, r.fuel_type, r.reconciliation_value_cents
    FROM sales_readings r WHERE ${meterWhere.join(' AND ')}
  `).all(...meterParams);
  const pumpMeters = db.prepare(`
    SELECT r."date", r.fuel_id, r.fuel_type, r.consumption
    FROM pump_readings r WHERE ${meterWhere.join(' AND ')}
  `).all(...meterParams);
  const cogsRows = db.prepare(`
    SELECT r."date", r.fuel_id, r.fuel_type,
      CAST(COALESCE(SUM(a.quantity * a.unit_cost_cents), 0) AS INTEGER) AS cogs_cents
    FROM pump_readings r
    JOIN inventory_movements m ON m.source_type = 'pump_reading'
      AND m.source_id = r.id AND m.reversed_at IS NULL AND m.signed_quantity < 0
    JOIN inventory_allocations a ON a.movement_id = m.id
    WHERE ${meterWhere.join(' AND ')}
    GROUP BY r."date", r.fuel_id, r.fuel_type
  `).all(...meterParams);
  const expenses = db.prepare(`
    SELECT e.expense_date, e.amount_cents
    FROM expenses e WHERE e.expense_date >= ? AND e.expense_date <= ?
    ${filters.userId ? 'AND e.user_id = ?' : ''}
  `).all(...(filters.userId ? [from, to, filters.userId] : [from, to]));
  const shifts = db.prepare(`
    SELECT s.closed_at, s.total_difference_cents
    FROM shifts s
    WHERE s.status = 'closed' AND s.closed_at >= ? AND s.closed_at <= ?
    ${filters.userId ? 'AND s.user_id = ?' : ''}
  `).all(...(filters.userId ? [range.startUtc, range.endUtc, filters.userId] : [range.startUtc, range.endUtc]));

  const daily = new Map(dateKeys(from, to).map((date) => [date, {
    date,
    saleCount: 0,
    recordedCents: 0,
    meterCents: 0,
    cogsCents: 0,
    expenseCents: 0,
    cashCents: 0,
    mpesaCents: 0,
    litres: 0,
  }]));
  const meterByKey = new Map();
  const recordedKeys = new Set();
  const fuelMap = new Map();
  for (const row of salesMeters) meterByKey.set(keyFor(row.date, row.fuel_id, row.fuel_type), (meterByKey.get(keyFor(row.date, row.fuel_id, row.fuel_type)) || 0) + row.reconciliation_value_cents);
  for (const row of sales) {
    const date = DateTime.fromISO(row.sold_at).setZone(zone).toISODate();
    const day = daily.get(date);
    if (!day) continue;
    const key = keyFor(date, row.fuel_id, row.fuel_type);
    recordedKeys.add(key);
    day.saleCount += 1;
    day.recordedCents += row.amount_cents;
    day.cashCents += row.cash_cents;
    day.mpesaCents += row.mpesa_cents;
    if (row.litres !== null) day.litres += row.litres;
    const fuelKey = fuelKeyFor(null, row);
    const fuel = fuelMap.get(fuelKey) || { id: row.fuel_id, type: row.fuel_type || 'UNASSIGNED', formalCents: 0, recordedCents: 0, cogsCents: 0, litres: 0 };
    fuel.recordedCents += row.amount_cents;
    if (row.litres !== null) fuel.litres += row.litres;
    fuelMap.set(fuelKey, fuel);
  }
  for (const row of salesMeters) {
    const day = daily.get(row.date);
    if (!day) continue;
    day.meterCents += row.reconciliation_value_cents;
    const fuelKey = fuelKeyFor(null, row);
    const fuel = fuelMap.get(fuelKey) || { id: row.fuel_id, type: row.fuel_type || 'UNASSIGNED', formalCents: 0, recordedCents: 0, cogsCents: 0, litres: 0 };
    fuel.formalCents += row.reconciliation_value_cents;
    fuelMap.set(fuelKey, fuel);
  }
  for (const row of pumpMeters) {
    const day = daily.get(row.date);
    if (!day) continue;
    day.litres += row.consumption;
    const fuelKey = fuelKeyFor(null, row);
    const fuel = fuelMap.get(fuelKey) || { id: row.fuel_id, type: row.fuel_type || 'UNASSIGNED', formalCents: 0, recordedCents: 0, cogsCents: 0, litres: 0 };
    fuel.litres += row.consumption;
    fuelMap.set(fuelKey, fuel);
  }
  for (const row of cogsRows) {
    const day = daily.get(row.date);
    if (day) day.cogsCents += row.cogs_cents;
    const fuelKey = fuelKeyFor(null, row);
    const fuel = fuelMap.get(fuelKey) || { id: row.fuel_id, type: row.fuel_type || 'UNASSIGNED', formalCents: 0, recordedCents: 0, cogsCents: 0, litres: 0 };
    fuel.cogsCents += row.cogs_cents;
    fuelMap.set(fuelKey, fuel);
  }
  for (const row of expenses) {
    const day = daily.get(row.expense_date);
    if (day) day.expenseCents += row.amount_cents;
  }
  const gapByDate = new Map();
  for (const row of shifts) {
    if (row.total_difference_cents === null) continue;
    const date = DateTime.fromISO(row.closed_at).setZone(zone).toISODate();
    const gap = gapByDate.get(date) || { signedCents: 0, absoluteCents: 0 };
    gap.signedCents += row.total_difference_cents;
    gap.absoluteCents += Math.abs(row.total_difference_cents);
    gapByDate.set(date, gap);
  }
  let signedGap = 0;
  let absoluteGap = 0;
  const dailyTrend = [...daily.values()].map((day) => {
    const gap = gapByDate.get(day.date) || { signedCents: 0, absoluteCents: 0 };
    signedGap += gap.signedCents;
    absoluteGap += gap.absoluteCents;
    const grossCents = day.meterCents - day.cogsCents;
    const rankingCents = meterByKey.size ? day.meterCents : day.recordedCents;
    return {
      date: day.date,
      saleCount: day.saleCount,
      litres: Math.round(day.litres * 1000) / 1000,
      salesKsh: money(day.meterCents),
      formalRevenueKsh: money(day.meterCents),
      recordedSaleRevenueKsh: money(day.recordedCents),
      revenueVarianceKsh: money(day.meterCents - day.recordedCents),
      rankingRevenueKsh: money(rankingCents),
      cogsKsh: money(day.cogsCents),
      grossProfitKsh: money(grossCents),
      grossMarginPercent: day.meterCents > 0 ? Math.round((grossCents / day.meterCents) * 10000) / 100 : null,
      expensesKsh: money(day.expenseCents),
      netKsh: money(grossCents - day.expenseCents),
      cumulativeSignedShiftGapKsh: money(signedGap),
      cumulativeAbsoluteShiftGapKsh: money(absoluteGap),
    };
  });

  const totals = [...daily.values()].reduce((sum, day) => ({
    saleCount: sum.saleCount + day.saleCount,
    recordedCents: sum.recordedCents + day.recordedCents,
    meterCents: sum.meterCents + day.meterCents,
    cogsCents: sum.cogsCents + day.cogsCents,
    expenseCents: sum.expenseCents + day.expenseCents,
    cashCents: sum.cashCents + day.cashCents,
    mpesaCents: sum.mpesaCents + day.mpesaCents,
    litres: sum.litres + day.litres,
  }), { saleCount: 0, recordedCents: 0, meterCents: 0, cogsCents: 0, expenseCents: 0, cashCents: 0, mpesaCents: 0, litres: 0 });
  const coveredKeys = [...recordedKeys].filter((key) => meterByKey.has(key)).length;
  const coverageRatio = recordedKeys.size ? coveredKeys / recordedKeys.size : (salesMeters.length ? 1 : 0);
  const dataStatus = !salesMeters.length ? 'noSalesMeterReadings' : coverageRatio < 1 ? 'partial' : 'complete';
  const grossCents = totals.meterCents - totals.cogsCents;
  const fuels = [...fuelMap.values()].map((fuel) => ({
    id: fuel.id,
    type: fuel.type,
    litres: Math.round(fuel.litres * 1000) / 1000,
    salesKsh: money(fuel.formalCents),
    formalRevenueKsh: money(fuel.formalCents),
    recordedSaleRevenueKsh: money(fuel.recordedCents),
    revenueVarianceKsh: money(fuel.formalCents - fuel.recordedCents),
    cogsKsh: money(fuel.cogsCents),
    grossProfitKsh: money(fuel.formalCents - fuel.cogsCents),
    grossMarginPercent: fuel.formalCents > 0 ? Math.round(((fuel.formalCents - fuel.cogsCents) / fuel.formalCents) * 10000) / 100 : null,
  }));
  return {
    period: { from, to, timezone: zone },
    filters: { userId: filters.userId || null, fuelId: filters.fuelId || null },
    currency: 'KSh',
    dataStatus,
    coverage: { recordedGroups: recordedKeys.size, coveredGroups: coveredKeys, ratio: Math.round(coverageRatio * 10000) / 100 },
    totals: {
      saleCount: totals.saleCount,
      litres: Math.round(totals.litres * 1000) / 1000,
      salesKsh: money(totals.meterCents),
      formalRevenueKsh: money(totals.meterCents),
      recordedSaleRevenueKsh: money(totals.recordedCents),
      revenueVarianceKsh: money(totals.meterCents - totals.recordedCents),
      cogsKsh: money(totals.cogsCents),
      grossProfitKsh: money(grossCents),
      grossMarginPercent: totals.meterCents > 0 ? Math.round((grossCents / totals.meterCents) * 10000) / 100 : null,
      expensesKsh: money(totals.expenseCents),
      netKsh: money(grossCents - totals.expenseCents),
    },
    paymentSplit: { cashKsh: money(totals.cashCents), mpesaKsh: money(totals.mpesaCents) },
    fuels,
    shiftGaps: { signedKsh: money(signedGap), absoluteKsh: money(absoluteGap) },
    dailyTrend,
  };
}

export function createReportsRouter({ db }) {
  const router = Router();

  router.get('/', validate(reportQuerySchema, 'query'), (req, res) => {
    const report = buildSummary(db, req.validatedQuery.from, req.validatedQuery.to, req.validatedQuery);
    recordAudit(db, { req, category: 'admin', event: 'admin.report_viewed', metadata: { from: report.period.from, to: report.period.to, filters: report.filters } });
    res.json({ report });
  });

  router.get('/monthly', validate(monthlySchema, 'query'), (req, res) => {
    const { year, month } = req.validatedQuery;
    const zone = getSettings(db).timezone;
    const start = DateTime.fromObject({ year, month, day: 1 }, { zone });
    const end = start.endOf('month');
    const previousStart = start.minus({ days: 1 }).startOf('month');
    const current = buildSummary(db, start.toISODate(), end.toISODate());
    const previous = buildSummary(db, previousStart.toISODate(), previousStart.endOf('month').toISODate());
    const candidates = current.dailyTrend.filter((day) => day.saleCount > 0 || day.expensesKsh !== 0 || day.cogsKsh !== 0);
    const best = candidates.reduce((result, day) => !result || day.rankingRevenueKsh > result.rankingRevenueKsh ? day : result, null);
    const worst = candidates.reduce((result, day) => !result || day.rankingRevenueKsh < result.rankingRevenueKsh ? day : result, null);
    const currentCents = (key) => key === 'litres' ? Math.round(current.totals.litres * 1000) : toCents(current.totals[key]);
    const previousCents = (key) => key === 'litres' ? Math.round(previous.totals.litres * 1000) : toCents(previous.totals[key]);
    const delta = (key) => ({ absoluteKsh: money(currentCents(key) - previousCents(key)), percent: percentageChange(currentCents(key), previousCents(key)) });
    recordAudit(db, { req, category: 'admin', event: 'admin.monthly_report_viewed', metadata: { year, month } });
    res.json({
      report: {
        year,
        month,
        previousPeriod: { year: previousStart.year, month: previousStart.month },
        currency: 'KSh',
        dataStatus: current.dataStatus,
        coverage: current.coverage,
        totals: current.totals,
        paymentSplit: current.paymentSplit,
        monthOverMonth: {
          revenue: delta('formalRevenueKsh'),
          recordedRevenue: delta('recordedSaleRevenueKsh'),
          cogs: delta('cogsKsh'),
          grossProfit: delta('grossProfitKsh'),
          expenses: delta('expensesKsh'),
          net: delta('netKsh'),
          litres: { absolute: Math.round((current.totals.litres - previous.totals.litres) * 1000) / 1000, percent: percentageChange(currentCents('litres'), previousCents('litres')) },
        },
        bestDay: best && { date: best.date, revenueKsh: best.rankingRevenueKsh, netKsh: best.netKsh },
        worstDay: worst && { date: worst.date, revenueKsh: worst.rankingRevenueKsh, netKsh: worst.netKsh },
        shiftGaps: current.shiftGaps,
        fuels: current.fuels,
        dailyTrend: current.dailyTrend,
      },
    });
  });

  router.get('/export.csv', validate(csvQuerySchema, 'query'), (req, res) => {
    const { from, to } = req.validatedQuery;
    const rows = [];
    const add = (recordType, id, date, timestamp, userId, username, shiftId, fuelId, fuelType, litres, amountKsh, costKsh, paymentMethod, status, details) => rows.push([recordType, id, date, timestamp, userId, username, shiftId, fuelId, fuelType, litres, amountKsh, costKsh, paymentMethod, status, details]);
    const dateFilter = (column) => {
      const clauses = [];
      const params = [];
      if (from) { clauses.push(`date(${column}) >= ?`); params.push(from); }
      if (to) { clauses.push(`date(${column}) <= ?`); params.push(to); }
      return { sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
    };
    for (const row of db.prepare('SELECT id, username, full_name, role, is_active, created_at FROM users ORDER BY id').all()) add('user', row.id, null, row.created_at, row.id, row.username, null, null, null, null, null, null, null, row.is_active ? 'active' : 'inactive', { fullName: row.full_name, role: row.role });
    for (const row of db.prepare('SELECT * FROM fuel_management ORDER BY id').all()) add('fuel', row.id, null, row.created_at, null, null, null, row.id, row.fuel_type, row.stock_litres, null, row.price_per_litre, null, row.is_active ? 'active' : 'inactive', { tankCapacityLitres: row.tank_capacity_litres });
    for (const row of db.prepare('SELECT p.*, f.fuel_type FROM pumps p JOIN fuel_management f ON f.id = p.fuel_id ORDER BY p.id').all()) add('pump', row.id, null, row.created_at, null, null, null, row.fuel_id, row.fuel_type, null, null, null, null, row.is_active ? 'active' : 'inactive', { pumpCode: row.pump_code });
    let filter = dateFilter('s.opened_at');
    for (const row of db.prepare(`SELECT s.*, u.username FROM shifts s JOIN users u ON u.id = s.user_id ${filter.sql} ORDER BY s.id`).all(...filter.params)) add('shift', row.id, row.opened_at.slice(0, 10), row.opened_at, row.attendant_id, row.username, row.id, null, null, null, row.opening_cash, row.opening_mpesa, null, row.status, { closedAt: row.closed_at, expectedCashKsh: row.expected_cash, expectedMpesaKsh: row.expected_mpesa, closingCashKsh: row.closing_cash, closingMpesaKsh: row.closing_mpesa, discrepancyKsh: row.total_difference_cents / 100 });
    filter = dateFilter('s.sold_at');
    for (const row of db.prepare(`SELECT s.*, u.username FROM sales s JOIN users u ON u.id = s.user_id ${filter.sql} ORDER BY s.id`).all(...filter.params)) add('sale', row.id, row.sold_at.slice(0, 10), row.sold_at, row.user_id, row.username, row.shift_id, row.fuel_id, row.fuel_type, row.litres, row.amount_cents / 100, row.unit_cost_cents === null ? null : row.unit_cost_cents / 100, row.payment_method, row.mode, { pumpId: row.pump_id, unitPriceKsh: row.unit_price_cents === null ? null : row.unit_price_cents / 100, cashKsh: row.cash_cents / 100, mpesaKsh: row.mpesa_cents / 100, customerName: row.customer_name, notes: row.notes });
    filter = dateFilter('r."date"');
    for (const row of db.prepare(`SELECT r.*, u.username, f.fuel_type FROM pump_readings r JOIN users u ON u.id = r.user_id JOIN fuel_management f ON f.id = r.fuel_id ${filter.sql} ORDER BY r.id`).all(...filter.params)) add('pump_reading', row.id, row.date, row.created_at, row.user_id, row.username, null, row.fuel_id, row.fuel_type, row.consumption, row.reconciliation_value_cents / 100, null, null, null, { openingLitres: row.opening_litres, closingLitres: row.closing_litres, previousClosingLitres: row.prev_closing_litres, stockBeforeLitres: row.stock_before, stockAfterLitres: row.stock_after, meterReference: row.meter_reference, notes: row.notes });
    filter = dateFilter('r."date"');
    for (const row of db.prepare(`SELECT r.*, u.username, f.fuel_type FROM sales_readings r JOIN users u ON u.id = r.user_id JOIN fuel_management f ON f.id = r.fuel_id ${filter.sql} ORDER BY r.id`).all(...filter.params)) add('sales_reading', row.id, row.date, row.created_at, row.user_id, row.username, null, row.fuel_id, row.fuel_type, null, row.reconciliation_value_cents / 100, null, null, null, { openingKsh: row.opening_ksh, closingKsh: row.closing_ksh, previousClosingKsh: row.prev_closing_ksh, meterReference: row.meter_reference, notes: row.notes });
    filter = dateFilter('e.expense_date');
    for (const row of db.prepare(`SELECT e.*, u.username FROM expenses e JOIN users u ON u.id = e.user_id ${filter.sql} ORDER BY e.id`).all(...filter.params)) add('expense', row.id, row.expense_date, row.timestamp, row.user_id, row.username, row.shift_id, null, null, null, row.amount_cents / 100, null, row.payment_method, null, { category: row.category, description: row.description, notes: row.notes });
    filter = dateFilter('r.timestamp');
    for (const row of db.prepare(`SELECT r.*, u.username FROM restocks r JOIN users u ON u.id = r.created_by ${filter.sql} ORDER BY r.id`).all(...filter.params)) add('restock', row.id, row.timestamp.slice(0, 10), row.timestamp, row.created_by, row.username, null, row.fuel_id, row.fuel_type, row.litres_added, row.total_cost_cents / 100, row.cost_per_litre, null, null, { supplier: row.supplier, reference: row.reference, stockBeforeLitres: row.stock_before, stockAfterLitres: row.stock_after, notes: row.notes });
    filter = dateFilter('a.timestamp');
    for (const row of db.prepare(`SELECT a.*, u.username FROM stock_adjustments a JOIN users u ON u.id = a.created_by ${filter.sql} ORDER BY a.id`).all(...filter.params)) add('stock_adjustment', row.id, row.timestamp.slice(0, 10), row.timestamp, row.created_by, row.username, null, row.fuel_id, row.fuel_type, row.quantity, null, row.unit_cost_cents === null ? null : row.unit_cost_cents / 100, null, null, { reason: row.reason, oldStock: row.old_stock, newStock: row.new_stock, notes: row.notes });
    filter = dateFilter('m.created_at');
    for (const row of db.prepare(`SELECT m.*, u.username, f.fuel_type FROM inventory_movements m JOIN users u ON u.id = m.created_by JOIN fuel_management f ON f.id = m.fuel_id ${filter.sql} ORDER BY m.id`).all(...filter.params)) add('inventory_movement', row.id, row.created_at.slice(0, 10), row.created_at, row.created_by, row.username, null, row.fuel_id, row.fuel_type, row.signed_quantity, null, row.signed_cost_cents / 100, null, row.reversed_at ? 'reversed' : 'posted', { sourceType: row.source_type, sourceId: row.source_id, stockBeforeLitres: row.stock_before, stockAfterLitres: row.stock_after });

    const header = ['recordType', 'id', 'date', 'timestamp', 'userId', 'username', 'shiftId', 'fuelId', 'fuelType', 'litres', 'amountKsh', 'unitCostKsh', 'paymentMethod', 'status', 'details'];
    const csv = `\uFEFF${header.map(csvCell).join(',')}\n${rows.map((row) => row.map(csvCell).join(',')).join('\n')}\n`;
    recordAudit(db, { req, category: 'admin', event: 'admin.operational_csv_exported', metadata: { from: from || null, to: to || null, rowCount: rows.length } });
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="zenenergies-operational-${from || 'all'}-to-${to || 'all'}.csv"`);
    res.send(csv);
  });

  return router;
}
