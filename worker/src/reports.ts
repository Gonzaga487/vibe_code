import { Hono } from 'hono';
import { auditForContext } from './audit';
import { dateDifferenceDays, dateKey, enumerateDates, getDateRange, monthRange, previousMonth } from './date';
import { badRequest } from './errors';
import { csv, money, toCents } from './http';
import { getSettings } from './settings';
import { csvQuerySchema, monthlyQuerySchema, parseQuery, reportQuerySchema } from './validators';
import type { AppEnv, AppContext, DbRow, FuelType } from './types';

interface ReportFilters { userId?: number; fuelId?: number }
interface DailyAccumulator {
  date: string; saleCount: number; recordedCents: number; meterCents: number; cogsCents: number;
  expenseCents: number; cashCents: number; mpesaCents: number; litres: number;
}

function percentageChange(current: number, previous: number): number | null {
  if (previous === 0) return null;
  return Math.round(((current - previous) / Math.abs(previous)) * 10000) / 100;
}

function reportKey(date: string, fuelId: number | null, fuelType: string | null): string {
  return `${date}|${fuelId ?? 'ALL'}|${fuelType ?? 'UNASSIGNED'}`;
}

function fuelKey(row: DbRow): string {
  return String(row.fuel_id ?? row.fuel_type ?? 'UNASSIGNED');
}

export async function buildReport(db: D1Database, from: string, to: string, filters: ReportFilters = {}) {
  const settings = await getSettings(db);
  const range = getDateRange(from, to, settings.timezone);
  const salesWhere = ['s.sold_at >= ?', 's.sold_at <= ?'];
  const salesBindings: Array<string | number> = [range.startUtc, range.endUtc];
  if (filters.userId) { salesWhere.push('s.user_id = ?'); salesBindings.push(filters.userId); }
  if (filters.fuelId) { salesWhere.push('s.fuel_id = ?'); salesBindings.push(filters.fuelId); }
  const sales = await db.prepare(`
    SELECT s.id, s.sold_at, s.user_id, s.fuel_id, s.fuel_type, s.mode, s.litres,
      s.amount_cents, s.cash_cents, s.mpesa_cents, s.payment_method
    FROM sales s WHERE ${salesWhere.join(' AND ')} ORDER BY s.sold_at
  `).bind(...salesBindings).all<DbRow>();

  const meterWhere = ['r."date" >= ?', 'r."date" <= ?'];
  const meterBindings: Array<string | number> = [from, to];
  if (filters.fuelId) { meterWhere.push('r.fuel_id = ?'); meterBindings.push(filters.fuelId); }
  const salesMeters = await db.prepare(`SELECT r."date", r.fuel_id, r.fuel_type, r.reconciliation_value_cents FROM sales_readings r WHERE ${meterWhere.join(' AND ')}`).bind(...meterBindings).all<DbRow>();
  const pumpMeters = await db.prepare(`SELECT r."date", r.fuel_id, r.fuel_type, r.consumption FROM pump_readings r WHERE ${meterWhere.join(' AND ')}`).bind(...meterBindings).all<DbRow>();
  const cogsRows = await db.prepare(`
    SELECT r."date", r.fuel_id, r.fuel_type, CAST(COALESCE(SUM(a.quantity * a.unit_cost_cents), 0) AS INTEGER) AS cogs_cents
    FROM pump_readings r
    JOIN inventory_movements m ON m.source_type = 'pump_reading' AND m.source_id = r.id AND m.reversed_at IS NULL AND m.signed_quantity < 0
    JOIN inventory_allocations a ON a.movement_id = m.id
    WHERE ${meterWhere.join(' AND ')}
    GROUP BY r."date", r.fuel_id, r.fuel_type
  `).bind(...meterBindings).all<DbRow>();
  const expenseBindings: Array<string | number> = [from, to];
  let expenseSql = 'SELECT expense_date, amount_cents FROM expenses WHERE expense_date >= ? AND expense_date <= ?';
  if (filters.userId) { expenseSql += ' AND user_id = ?'; expenseBindings.push(filters.userId); }
  const expenses = await db.prepare(expenseSql).bind(...expenseBindings).all<DbRow>();
  const shiftBindings: Array<string | number> = [range.startUtc, range.endUtc];
  let shiftSql = "SELECT closed_at, total_difference_cents FROM shifts WHERE status = 'closed' AND closed_at >= ? AND closed_at <= ?";
  if (filters.userId) { shiftSql += ' AND user_id = ?'; shiftBindings.push(filters.userId); }
  const shifts = await db.prepare(shiftSql).bind(...shiftBindings).all<DbRow>();

  const daily = new Map<string, DailyAccumulator>(enumerateDates(from, to).map((date) => [date, {
    date, saleCount: 0, recordedCents: 0, meterCents: 0, cogsCents: 0, expenseCents: 0,
    cashCents: 0, mpesaCents: 0, litres: 0,
  }]));
  const meterByKey = new Map<string, number>();
  const recordedKeys = new Set<string>();
  interface FuelAccumulator { id: number | null; type: FuelType | 'UNASSIGNED'; formalCents: number; recordedCents: number; cogsCents: number; litres: number }
  const fuels = new Map<string, FuelAccumulator>();
  const fuelFor = (row: DbRow): FuelAccumulator => {
    const key = fuelKey(row);
    const value = fuels.get(key) || {
      id: row.fuel_id === null || row.fuel_id === undefined ? null : Number(row.fuel_id),
      type: (row.fuel_type || 'UNASSIGNED') as FuelType | 'UNASSIGNED',
      formalCents: 0, recordedCents: 0, cogsCents: 0, litres: 0,
    };
    fuels.set(key, value);
    return value;
  };
  for (const row of salesMeters.results) {
    meterByKey.set(reportKey(String(row.date), Number(row.fuel_id), String(row.fuel_type)), (meterByKey.get(reportKey(String(row.date), Number(row.fuel_id), String(row.fuel_type))) || 0) + Number(row.reconciliation_value_cents));
  }
  for (const row of sales.results) {
    const date = dateKey(String(row.sold_at), settings.timezone);
    const day = daily.get(date);
    if (!day) continue;
    const key = reportKey(date, row.fuel_id === null ? null : Number(row.fuel_id), row.fuel_type ? String(row.fuel_type) : null);
    recordedKeys.add(key);
    day.saleCount += 1;
    day.recordedCents += Number(row.amount_cents);
    day.cashCents += Number(row.cash_cents);
    day.mpesaCents += Number(row.mpesa_cents);
    if (row.litres !== null) day.litres += Number(row.litres);
    const fuel = fuelFor(row);
    fuel.recordedCents += Number(row.amount_cents);
    if (row.litres !== null) fuel.litres += Number(row.litres);
  }
  for (const row of salesMeters.results) {
    const day = daily.get(String(row.date));
    if (!day) continue;
    day.meterCents += Number(row.reconciliation_value_cents);
    fuelFor(row).formalCents += Number(row.reconciliation_value_cents);
  }
  for (const row of pumpMeters.results) {
    const day = daily.get(String(row.date));
    if (!day) continue;
    day.litres += Number(row.consumption);
    fuelFor(row).litres += Number(row.consumption);
  }
  for (const row of cogsRows.results) {
    const day = daily.get(String(row.date));
    if (day) day.cogsCents += Number(row.cogs_cents);
    fuelFor(row).cogsCents += Number(row.cogs_cents);
  }
  for (const row of expenses.results) {
    const day = daily.get(String(row.expense_date));
    if (day) day.expenseCents += Number(row.amount_cents);
  }

  const gapByDate = new Map<string, { signedCents: number; absoluteCents: number }>();
  for (const row of shifts.results) {
    if (row.total_difference_cents === null) continue;
    const date = dateKey(String(row.closed_at), settings.timezone);
    const gap = gapByDate.get(date) || { signedCents: 0, absoluteCents: 0 };
    gap.signedCents += Number(row.total_difference_cents);
    gap.absoluteCents += Math.abs(Number(row.total_difference_cents));
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
      date: day.date, saleCount: day.saleCount, litres: Math.round(day.litres * 1000) / 1000,
      salesKsh: money(day.meterCents), formalRevenueKsh: money(day.meterCents),
      recordedSaleRevenueKsh: money(day.recordedCents), revenueVarianceKsh: money(day.meterCents - day.recordedCents),
      rankingRevenueKsh: money(rankingCents), cogsKsh: money(day.cogsCents), grossProfitKsh: money(grossCents),
      grossMarginPercent: day.meterCents > 0 ? Math.round((grossCents / day.meterCents) * 10000) / 100 : null,
      expensesKsh: money(day.expenseCents), netKsh: money(grossCents - day.expenseCents),
      cumulativeSignedShiftGapKsh: money(signedGap), cumulativeAbsoluteShiftGapKsh: money(absoluteGap),
    };
  });
  const totals = [...daily.values()].reduce((sum, day) => ({
    saleCount: sum.saleCount + day.saleCount, recordedCents: sum.recordedCents + day.recordedCents,
    meterCents: sum.meterCents + day.meterCents, cogsCents: sum.cogsCents + day.cogsCents,
    expenseCents: sum.expenseCents + day.expenseCents, cashCents: sum.cashCents + day.cashCents,
    mpesaCents: sum.mpesaCents + day.mpesaCents, litres: sum.litres + day.litres,
  }), { saleCount: 0, recordedCents: 0, meterCents: 0, cogsCents: 0, expenseCents: 0, cashCents: 0, mpesaCents: 0, litres: 0 });
  const coveredKeys = [...recordedKeys].filter((key) => meterByKey.has(key)).length;
  const coverageRatio = recordedKeys.size ? coveredKeys / recordedKeys.size : (salesMeters.results.length ? 1 : 0);
  const grossCents = totals.meterCents - totals.cogsCents;
  return {
    period: { from, to, timezone: settings.timezone },
    filters: { userId: filters.userId || null, fuelId: filters.fuelId || null },
    currency: 'KSh' as const,
    dataStatus: !salesMeters.results.length ? 'noSalesMeterReadings' : coverageRatio < 1 ? 'partial' : 'complete',
    coverage: { recordedGroups: recordedKeys.size, coveredGroups: coveredKeys, ratio: Math.round(coverageRatio * 10000) / 100 },
    totals: {
      saleCount: totals.saleCount, litres: Math.round(totals.litres * 1000) / 1000,
      salesKsh: money(totals.meterCents), formalRevenueKsh: money(totals.meterCents),
      recordedSaleRevenueKsh: money(totals.recordedCents), revenueVarianceKsh: money(totals.meterCents - totals.recordedCents),
      cogsKsh: money(totals.cogsCents), grossProfitKsh: money(grossCents),
      grossMarginPercent: totals.meterCents > 0 ? Math.round((grossCents / totals.meterCents) * 10000) / 100 : null,
      expensesKsh: money(totals.expenseCents), netKsh: money(grossCents - totals.expenseCents),
    },
    paymentSplit: { cashKsh: money(totals.cashCents), mpesaKsh: money(totals.mpesaCents) },
    fuels: [...fuels.values()].map((fuel) => ({
      id: fuel.id, type: fuel.type, litres: Math.round(fuel.litres * 1000) / 1000,
      salesKsh: money(fuel.formalCents), formalRevenueKsh: money(fuel.formalCents),
      recordedSaleRevenueKsh: money(fuel.recordedCents), revenueVarianceKsh: money(fuel.formalCents - fuel.recordedCents),
      cogsKsh: money(fuel.cogsCents), grossProfitKsh: money(fuel.formalCents - fuel.cogsCents),
      grossMarginPercent: fuel.formalCents > 0 ? Math.round(((fuel.formalCents - fuel.cogsCents) / fuel.formalCents) * 10000) / 100 : null,
    })),
    shiftGaps: { signedKsh: money(signedGap), absoluteKsh: money(absoluteGap) },
    dailyTrend,
  };
}

export function reportsRouter(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.get('/', async (c) => {
    const query = parseQuery(c, reportQuerySchema);
    if (dateDifferenceDays(query.from, query.to) > 366) throw badRequest('Date range cannot exceed 367 days');
    const report = await buildReport(c.env.DB, query.from, query.to, query);
    const audit = auditForContext(c, { category: 'admin', event: 'admin.report_viewed', metadata: { from: report.period.from, to: report.period.to, filters: report.filters } });
    await c.env.DB.prepare(audit.sql).bind(...audit.bindings).run();
    return c.json({ report });
  });

  app.get('/monthly', async (c) => {
    const { year, month } = parseQuery(c, monthlyQuerySchema);
    const settings = await getSettings(c.env.DB);
    const currentRange = monthRange(year, month, settings.timezone);
    const previous = previousMonth(year, month);
    const previousRange = monthRange(previous.year, previous.month, settings.timezone);
    const current = await buildReport(c.env.DB, currentRange.from, currentRange.to);
    const prior = await buildReport(c.env.DB, previousRange.from, previousRange.to);
    const candidates = current.dailyTrend.filter((day) => day.saleCount > 0 || day.expensesKsh !== 0 || day.cogsKsh !== 0);
    const best = candidates.reduce((result, day) => !result || Number(day.rankingRevenueKsh) > Number(result.rankingRevenueKsh) ? day : result, null as typeof candidates[number] | null);
    const worst = candidates.reduce((result, day) => !result || Number(day.rankingRevenueKsh) < Number(result.rankingRevenueKsh) ? day : result, null as typeof candidates[number] | null);
    const currentCents = (key: 'litres' | 'formalRevenueKsh' | 'recordedSaleRevenueKsh' | 'cogsKsh' | 'grossProfitKsh' | 'expensesKsh' | 'netKsh') =>
      key === 'litres' ? Math.round(Number(current.totals.litres) * 1000) : toCents(current.totals[key]);
    const previousCents = (key: Parameters<typeof currentCents>[0]) =>
      key === 'litres' ? Math.round(Number(prior.totals.litres) * 1000) : toCents(prior.totals[key]);
    const delta = (key: Parameters<typeof currentCents>[0]) => ({ absoluteKsh: money(currentCents(key) - previousCents(key)), percent: percentageChange(currentCents(key), previousCents(key)) });
    const audit = auditForContext(c, { category: 'admin', event: 'admin.monthly_report_viewed', metadata: { year, month } });
    await c.env.DB.prepare(audit.sql).bind(...audit.bindings).run();
    return c.json({ report: {
      year, month, previousPeriod: previous, currency: 'KSh', dataStatus: current.dataStatus, coverage: current.coverage,
      totals: current.totals, paymentSplit: current.paymentSplit,
      monthOverMonth: {
        revenue: delta('formalRevenueKsh'), recordedRevenue: delta('recordedSaleRevenueKsh'), cogs: delta('cogsKsh'),
        grossProfit: delta('grossProfitKsh'), expenses: delta('expensesKsh'), net: delta('netKsh'),
        litres: { absolute: Math.round((Number(current.totals.litres) - Number(prior.totals.litres)) * 1000) / 1000, percent: percentageChange(currentCents('litres'), previousCents('litres')) },
      },
      bestDay: best ? { date: best.date, revenueKsh: best.rankingRevenueKsh, netKsh: best.netKsh } : null,
      worstDay: worst ? { date: worst.date, revenueKsh: worst.rankingRevenueKsh, netKsh: worst.netKsh } : null,
      shiftGaps: current.shiftGaps, fuels: current.fuels, dailyTrend: current.dailyTrend,
    } });
  });

  app.get('/export.csv', async (c) => {
    const { from, to } = parseQuery(c, csvQuerySchema);
    const rows: unknown[][] = [];
    const add = (...row: unknown[]) => rows.push(row);
    const filter = (column: string) => {
      const clauses: string[] = []; const params: string[] = [];
      if (from) { clauses.push(`date(${column}) >= ?`); params.push(from); }
      if (to) { clauses.push(`date(${column}) <= ?`); params.push(to); }
      return { sql: clauses.length ? `WHERE ${clauses.join(' AND ')}` : '', params };
    };
    for (const row of (await c.env.DB.prepare('SELECT id, username, full_name, role, is_active, created_at FROM users ORDER BY id').all<DbRow>()).results) add('user', row.id, null, row.created_at, row.id, row.username, null, null, null, null, null, null, null, row.is_active ? 'active' : 'inactive', { fullName: row.full_name, role: row.role });
    for (const row of (await c.env.DB.prepare('SELECT * FROM fuel_management ORDER BY id').all<DbRow>()).results) add('fuel', row.id, null, row.created_at, null, null, null, row.id, row.fuel_type, row.stock_litres, null, row.price_per_litre, null, row.is_active ? 'active' : 'inactive', { tankCapacityLitres: row.tank_capacity_litres });
    for (const row of (await c.env.DB.prepare('SELECT p.*, f.fuel_type FROM pumps p JOIN fuel_management f ON f.id = p.fuel_id ORDER BY p.id').all<DbRow>()).results) add('pump', row.id, null, row.created_at, null, null, null, row.fuel_id, row.fuel_type, null, null, null, null, row.is_active ? 'active' : 'inactive', { pumpCode: row.pump_code });
    let selected = filter('s.opened_at');
    for (const row of (await c.env.DB.prepare(`SELECT s.*, u.username FROM shifts s JOIN users u ON u.id = s.user_id ${selected.sql} ORDER BY s.id`).bind(...selected.params).all<DbRow>()).results) add('shift', row.id, String(row.opened_at).slice(0, 10), row.opened_at, row.attendant_id, row.username, row.id, null, null, null, row.opening_cash, row.opening_mpesa, null, row.status, { closedAt: row.closed_at, expectedCashKsh: row.expected_cash, expectedMpesaKsh: row.expected_mpesa, closingCashKsh: row.closing_cash, closingMpesaKsh: row.closing_mpesa, discrepancyKsh: row.total_difference_cents === null ? null : Number(row.total_difference_cents) / 100 });
    selected = filter('s.sold_at');
    for (const row of (await c.env.DB.prepare(`SELECT s.*, u.username FROM sales s JOIN users u ON u.id = s.user_id ${selected.sql} ORDER BY s.id`).bind(...selected.params).all<DbRow>()).results) add('sale', row.id, String(row.sold_at).slice(0, 10), row.sold_at, row.user_id, row.username, row.shift_id, row.fuel_id, row.fuel_type, row.litres, Number(row.amount_cents) / 100, row.unit_cost_cents === null ? null : Number(row.unit_cost_cents) / 100, row.payment_method, row.mode, { pumpId: row.pump_id, unitPriceKsh: row.unit_price_cents === null ? null : Number(row.unit_price_cents) / 100, cashKsh: Number(row.cash_cents) / 100, mpesaKsh: Number(row.mpesa_cents) / 100, customerName: row.customer_name, notes: row.notes });
    selected = filter('r."date"');
    for (const row of (await c.env.DB.prepare(`SELECT r.*, u.username FROM pump_readings r JOIN users u ON u.id = r.user_id ${selected.sql} ORDER BY r.id`).bind(...selected.params).all<DbRow>()).results) add('pump_reading', row.id, row.date, row.created_at, row.user_id, row.username, null, row.fuel_id, row.fuel_type, row.consumption, Number(row.reconciliation_value_cents) / 100, null, null, null, { openingLitres: row.opening_litres, closingLitres: row.closing_litres, previousClosingLitres: row.prev_closing_litres, stockBeforeLitres: row.stock_before, stockAfterLitres: row.stock_after, meterReference: row.meter_reference, notes: row.notes });
    for (const row of (await c.env.DB.prepare(`SELECT r.*, u.username FROM sales_readings r JOIN users u ON u.id = r.user_id ${selected.sql} ORDER BY r.id`).bind(...selected.params).all<DbRow>()).results) add('sales_reading', row.id, row.date, row.created_at, row.user_id, row.username, null, row.fuel_id, row.fuel_type, null, Number(row.reconciliation_value_cents) / 100, null, null, null, { openingKsh: row.opening_ksh, closingKsh: row.closing_ksh, previousClosingKsh: row.prev_closing_ksh, meterReference: row.meter_reference, notes: row.notes });
    selected = filter('e.expense_date');
    for (const row of (await c.env.DB.prepare(`SELECT e.*, u.username FROM expenses e JOIN users u ON u.id = e.user_id ${selected.sql} ORDER BY e.id`).bind(...selected.params).all<DbRow>()).results) add('expense', row.id, row.expense_date, row.timestamp, row.user_id, row.username, row.shift_id, null, null, null, Number(row.amount_cents) / 100, null, row.payment_method, null, { category: row.category, description: row.description, notes: row.notes });
    selected = filter('r.timestamp');
    for (const row of (await c.env.DB.prepare(`SELECT r.*, u.username FROM restocks r JOIN users u ON u.id = r.created_by ${selected.sql} ORDER BY r.id`).bind(...selected.params).all<DbRow>()).results) add('restock', row.id, String(row.timestamp).slice(0, 10), row.timestamp, row.created_by, row.username, null, row.fuel_id, row.fuel_type, row.litres_added, Number(row.total_cost_cents) / 100, row.cost_per_litre, null, null, { supplier: row.supplier, reference: row.reference, stockBeforeLitres: row.stock_before, stockAfterLitres: row.stock_after, notes: row.notes });
    selected = filter('a.timestamp');
    for (const row of (await c.env.DB.prepare(`SELECT a.*, u.username FROM stock_adjustments a JOIN users u ON u.id = a.created_by ${selected.sql} ORDER BY a.id`).bind(...selected.params).all<DbRow>()).results) add('stock_adjustment', row.id, String(row.timestamp).slice(0, 10), row.timestamp, row.created_by, row.username, null, row.fuel_id, row.fuel_type, row.quantity, null, row.unit_cost_cents === null ? null : Number(row.unit_cost_cents) / 100, null, null, { reason: row.reason, oldStock: row.old_stock, newStock: row.new_stock, notes: row.notes });
    selected = filter('m.created_at');
    for (const row of (await c.env.DB.prepare(`SELECT m.*, u.username, f.fuel_type FROM inventory_movements m JOIN users u ON u.id = m.created_by JOIN fuel_management f ON f.id = m.fuel_id ${selected.sql} ORDER BY m.id`).bind(...selected.params).all<DbRow>()).results) add('inventory_movement', row.id, String(row.created_at).slice(0, 10), row.created_at, row.created_by, row.username, null, row.fuel_id, row.fuel_type, row.signed_quantity, null, Number(row.signed_cost_cents) / 100, null, row.reversed_at ? 'reversed' : 'posted', { sourceType: row.source_type, sourceId: row.source_id, stockBeforeLitres: row.stock_before, stockAfterLitres: row.stock_after });
    const header = ['recordType', 'id', 'date', 'timestamp', 'userId', 'username', 'shiftId', 'fuelId', 'fuelType', 'litres', 'amountKsh', 'unitCostKsh', 'paymentMethod', 'status', 'details'];
    const audit = auditForContext(c, { category: 'admin', event: 'admin.operational_csv_exported', metadata: { from: from || null, to: to || null, rowCount: rows.length } });
    await c.env.DB.prepare(audit.sql).bind(...audit.bindings).run();
    return new Response(csv([header, ...rows]), {
      headers: {
        'content-type': 'text/csv; charset=utf-8',
        'content-disposition': `attachment; filename="zenenergies-operational-${from || 'all'}-to-${to || 'all'}.csv"`,
      },
    });
  });
  return app;
}
