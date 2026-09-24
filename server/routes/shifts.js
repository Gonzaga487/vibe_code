import { Router } from 'express';
import { z } from 'zod';
import { DateTime } from 'luxon';
import { asyncHandler, getPagination, money, nonNegativeMoney, paginated, parseId } from '../lib/http.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { validate } from '../middleware/validate.js';
import { recordAudit } from '../services/audit.js';
import { getDateRange, getSettings } from '../services/settings.js';

const openSchema = z.object({
  openingCashKsh: z.number().finite().nonnegative().default(0),
  openingMpesaKsh: z.number().finite().nonnegative().default(0),
}).strict();

const closeSchema = z.object({
  countedCashKsh: z.number().finite().nonnegative(),
  countedMpesaKsh: z.number().finite().nonnegative(),
  closingCashKsh: z.number().finite().nonnegative().optional(),
  closingMpesaKsh: z.number().finite().nonnegative().optional(),
  notes: z.string().trim().max(1000).optional(),
}).strict().superRefine((value, context) => {
  if (value.closingCashKsh !== undefined && Math.round(value.closingCashKsh * 100) !== Math.round(value.countedCashKsh * 100)) {
    context.addIssue({ code: 'custom', path: ['closingCashKsh'], message: 'closingCashKsh must match countedCashKsh' });
  }
  if (value.closingMpesaKsh !== undefined && Math.round(value.closingMpesaKsh * 100) !== Math.round(value.countedMpesaKsh * 100)) {
    context.addIssue({ code: 'custom', path: ['closingMpesaKsh'], message: 'closingMpesaKsh must match countedMpesaKsh' });
  }
});

const listSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  status: z.enum(['open', 'closed', 'Open', 'Closed']).transform((value) => value.toLowerCase()).optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  userId: z.coerce.number().int().positive().optional(),
}).strict().refine((value) => !value.from || !value.to || value.from <= value.to, 'from cannot be after to');

const shiftSelect = `
  SELECT s.*, u.username, u.full_name,
    COALESCE((SELECT SUM(sa.cash_cents) FROM sales sa WHERE sa.shift_id = s.id), 0) AS sales_cash_cents,
    COALESCE((SELECT SUM(sa.mpesa_cents) FROM sales sa WHERE sa.shift_id = s.id), 0) AS sales_mpesa_cents,
    COALESCE((SELECT SUM(sa.amount_cents) FROM sales sa WHERE sa.shift_id = s.id), 0) AS sales_total_cents,
    COALESCE((SELECT SUM(sa.litres) FROM sales sa WHERE sa.shift_id = s.id), 0) AS litres,
    COALESCE((SELECT SUM(e.amount_cents) FROM expenses e WHERE e.shift_id = s.id AND e.payment_method = 'cash'), 0) AS expense_cash_cents,
    COALESCE((SELECT SUM(e.amount_cents) FROM expenses e WHERE e.shift_id = s.id AND e.payment_method = 'mpesa'), 0) AS expense_mpesa_cents,
    COALESCE((SELECT COUNT(*) FROM sales sa WHERE sa.shift_id = s.id), 0) AS sale_count,
    COALESCE((SELECT COUNT(*) FROM expenses e WHERE e.shift_id = s.id), 0) AS expense_count
  FROM shifts s
  JOIN users u ON u.id = s.user_id
`;

function parseReconciliation(value) {
  if (!value) return null;
  try { return JSON.parse(value); } catch { return null; }
}

export function serializeShift(row) {
  const expectedCash = row.opening_float_cents + row.sales_cash_cents - row.expense_cash_cents;
  const expectedMpesa = row.opening_float_mpesa_cents + row.sales_mpesa_cents - row.expense_mpesa_cents;
  const hasCounted = row.counted_cash_cents !== null && row.counted_mpesa_cents !== null;
  const cashDifference = hasCounted ? row.counted_cash_cents - expectedCash : null;
  const mpesaDifference = hasCounted ? row.counted_mpesa_cents - expectedMpesa : null;
  const attendantId = row.attendant_id ?? row.user_id;

  return {
    id: row.id,
    attendantId,
    user: { id: attendantId, username: row.username, fullName: row.full_name },
    status: row.status,
    statusLabel: row.status_label || (row.status === 'open' ? 'Open' : 'Closed'),
    openedAt: row.opened_at,
    closedAt: row.closed_at,
    openingCashKsh: money(row.opening_float_cents),
    openingMpesaKsh: money(row.opening_float_mpesa_cents),
    closingCashKsh: row.counted_cash_cents === null ? null : money(row.counted_cash_cents),
    closingMpesaKsh: row.counted_mpesa_cents === null ? null : money(row.counted_mpesa_cents),
    expectedCashKsh: money(expectedCash),
    expectedMpesaKsh: money(expectedMpesa),
    openingFloat: { cashKsh: money(row.opening_float_cents), mpesaKsh: money(row.opening_float_mpesa_cents) },
    expected: { cashKsh: money(expectedCash), mpesaKsh: money(expectedMpesa) },
    counted: row.counted_cash_cents === null ? null : {
      cashKsh: money(row.counted_cash_cents),
      mpesaKsh: money(row.counted_mpesa_cents),
    },
    discrepancy: hasCounted ? {
      cashKsh: money(cashDifference),
      mpesaKsh: money(mpesaDifference),
      totalKsh: money(cashDifference + mpesaDifference),
    } : null,
    summary: {
      saleCount: row.sale_count,
      expenseCount: row.expense_count,
      litres: row.litres,
      sales: {
        totalKsh: money(row.sales_total_cents),
        cashKsh: money(row.sales_cash_cents),
        mpesaKsh: money(row.sales_mpesa_cents),
      },
      expenses: {
        totalKsh: money(row.expense_cash_cents + row.expense_mpesa_cents),
        cashKsh: money(row.expense_cash_cents),
        mpesaKsh: money(row.expense_mpesa_cents),
      },
    },
    closingNotes: row.closing_notes,
    reconciliation: row.user_role === 'admin' ? parseReconciliation(row.reconciliation_json) : undefined,
  };
}

export function getOpenShift(db, userId, tx = db) {
  return tx.prepare(`${shiftSelect} WHERE s.user_id = ? AND s.status = 'open'`).get(userId);
}

export function assertShiftOwner(row, user) {
  if (!row) throw notFound('Shift was not found');
  if (user.role !== 'admin' && (row.user_id !== user.id || (row.attendant_id ?? row.user_id) !== user.id)) throw forbidden('You can only access your own shifts');
  return row;
}

export function recalculateShiftStoredTotals(db, shiftId, tx = db) {
  const row = tx.prepare(`${shiftSelect} WHERE s.id = ?`).get(shiftId);
  if (!row) return null;
  const expectedCash = row.opening_float_cents + row.sales_cash_cents - row.expense_cash_cents;
  const expectedMpesa = row.opening_float_mpesa_cents + row.sales_mpesa_cents - row.expense_mpesa_cents;
  const countedCash = row.counted_cash_cents;
  const countedMpesa = row.counted_mpesa_cents;
  const cashDifference = countedCash === null ? null : countedCash - expectedCash;
  const mpesaDifference = countedMpesa === null ? null : countedMpesa - expectedMpesa;
  tx.prepare(`
    UPDATE shifts
    SET expected_cash_cents = ?, expected_mpesa_cents = ?,
        expected_cash = ?, expected_mpesa = ?,
        cash_difference_cents = ?, mpesa_difference_cents = ?, total_difference_cents = ?,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ?
  `).run(
    expectedCash,
    expectedMpesa,
    expectedCash / 100.0,
    expectedMpesa / 100.0,
    cashDifference,
    mpesaDifference,
    cashDifference === null || mpesaDifference === null ? null : cashDifference + mpesaDifference,
    shiftId,
  );
  return tx.prepare(`${shiftSelect} WHERE s.id = ?`).get(shiftId);
}

function buildReconciliation(db, shift) {
  const settings = getSettings(db);
  const from = DateTime.fromISO(shift.opened_at).setZone(settings.timezone).toISODate();
  const to = DateTime.fromISO(shift.closed_at || new Date().toISOString()).setZone(settings.timezone).toISODate();
  const range = getDateRange(db, from, to);
  const recorded = db.prepare('SELECT COALESCE(SUM(cash_cents), 0) AS cash, COALESCE(SUM(mpesa_cents), 0) AS mpesa FROM sales WHERE shift_id = ?').get(shift.id);
  const meters = db.prepare(`
    SELECT
      COALESCE((SELECT SUM(reconciliation_value_cents) FROM sales_readings WHERE "date" >= ? AND "date" <= ?), 0) AS sales_cents,
      COALESCE((SELECT COUNT(*) FROM sales_readings WHERE "date" >= ? AND "date" <= ?), 0) AS sales_reading_count,
      COALESCE((SELECT SUM(consumption) FROM pump_readings WHERE "date" >= ? AND "date" <= ?), 0) AS pump_litres,
      COALESCE((SELECT COUNT(*) FROM pump_readings WHERE "date" >= ? AND "date" <= ?), 0) AS pump_reading_count
  `).get(from, to, from, to, from, to, from, to);
  const salesKsh = meters.sales_cents ?? 0;
  const recordedTotal = (recorded.cash || 0) + (recorded.mpesa || 0);
  return {
    recordedCashKsh: money(recorded.cash || 0),
    recordedMpesaKsh: money(recorded.mpesa || 0),
    recordedTotalKsh: money(recordedTotal),
    salesMeterKsh: money(salesKsh),
    salesMeterVarianceKsh: money(salesKsh - recordedTotal),
    pumpLitres: meters.pump_litres || 0,
    salesReadingCount: meters.sales_reading_count || 0,
    pumpReadingCount: meters.pump_reading_count || 0,
    dataStatus: meters.sales_reading_count ? (meters.pump_reading_count ? 'available' : 'partial') : 'noSalesMeterReadings',
    timezone: settings.timezone,
    range: { from, to },
  };
}

export function createShiftsRouter({ db }) {
  const router = Router();

  router.get('/open', (req, res) => {
    const shift = getOpenShift(db, req.auth.user.id);
    if (shift) shift.user_role = req.auth.user.role;
    res.json({ shift: shift ? serializeShift(shift) : null });
  });

  router.get('/mine', validate(listSchema, 'query'), (req, res) => {
    const pagination = getPagination(req.validatedQuery);
    const where = ['s.user_id = ?'];
    const params = [req.auth.user.id];
    if (req.validatedQuery.status) { where.push('s.status = ?'); params.push(req.validatedQuery.status); }
    if (req.validatedQuery.from) { where.push('date(s.opened_at) >= ?'); params.push(req.validatedQuery.from); }
    if (req.validatedQuery.to) { where.push('date(s.opened_at) <= ?'); params.push(req.validatedQuery.to); }
    const clause = `WHERE ${where.join(' AND ')}`;
    const rows = db.prepare(`${shiftSelect} ${clause} ORDER BY s.opened_at DESC LIMIT ? OFFSET ?`).all(...params, pagination.pageSize, pagination.offset);
    const total = db.prepare(`SELECT COUNT(*) AS count FROM shifts s ${clause}`).get(...params).count;
    res.json(paginated(rows.map((row) => ({ ...row, user_role: req.auth.user.role })), total, pagination, serializeShift));
  });

  router.get('/history', validate(listSchema, 'query'), (req, res) => {
    const actor = req.auth.user;
    const pagination = getPagination(req.validatedQuery);
    const where = [];
    const params = [];
    if (actor.role !== 'admin') {
      where.push('s.user_id = ?');
      params.push(actor.id);
    } else if (req.validatedQuery.userId) {
      where.push('s.user_id = ?');
      params.push(req.validatedQuery.userId);
    }
    if (req.validatedQuery.status) { where.push('s.status = ?'); params.push(req.validatedQuery.status); }
    if (req.validatedQuery.from) { where.push('date(s.opened_at) >= ?'); params.push(req.validatedQuery.from); }
    if (req.validatedQuery.to) { where.push('date(s.opened_at) <= ?'); params.push(req.validatedQuery.to); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const rows = db.prepare(`${shiftSelect} ${clause} ORDER BY s.opened_at DESC LIMIT ? OFFSET ?`).all(...params, pagination.pageSize, pagination.offset);
    const total = db.prepare(`SELECT COUNT(*) AS count FROM shifts s ${clause}`).get(...params).count;
    res.json(paginated(rows.map((row) => ({ ...row, user_role: actor.role })), total, pagination, serializeShift));
  });

  router.post('/open', validate(openSchema), (req, res) => {
    const actor = req.auth.user;
    if (getOpenShift(db, actor.id)) throw conflict('You already have an open shift');
    const now = DateTime.utc().toISO();
    const openingCash = nonNegativeMoney(req.body.openingCashKsh);
    const openingMpesa = nonNegativeMoney(req.body.openingMpesaKsh);
    const id = db.transaction(() => {
      if (getOpenShift(db, actor.id)) throw conflict('You already have an open shift');
      const result = db.prepare(`
        INSERT INTO shifts (
          user_id, attendant_id, status, status_label, opened_at, opening_float_cents, opening_float_mpesa_cents,
          opening_cash, opening_mpesa, expected_cash_cents, expected_mpesa_cents, expected_cash, expected_mpesa,
          created_at, updated_at
        ) VALUES (?, ?, 'open', 'Open', ?, ?, ?, ?, ?, 0, 0, 0, 0, ?, ?)
      `).run(actor.id, actor.id, now, openingCash, openingMpesa, openingCash / 100.0, openingMpesa / 100.0, now, now);
      const shiftId = Number(result.lastInsertRowid);
      recordAudit(db, { req, category: 'shift', event: 'shift.opened', metadata: { shiftId, attendantId: actor.id } });
      return shiftId;
    })();
    const row = db.prepare(`${shiftSelect} WHERE s.id = ?`).get(id);
    row.user_role = actor.role;
    res.status(201).json({ shift: serializeShift(row) });
  });

  router.get('/:id', (req, res) => {
    const row = assertShiftOwner(db.prepare(`${shiftSelect} WHERE s.id = ?`).get(parseId(req.params.id)), req.auth.user);
    row.user_role = req.auth.user.role;
    res.json({ shift: serializeShift(row) });
  });

  router.post('/:id/close', validate(closeSchema), asyncHandler((req, res) => {
    const id = parseId(req.params.id);
    const row = assertShiftOwner(db.prepare(`${shiftSelect} WHERE s.id = ?`).get(id), req.auth.user);
    if (row.status !== 'open') throw conflict('Shift is already closed');
    const countedCash = nonNegativeMoney(req.body.countedCashKsh, 'countedCashKsh');
    const countedMpesa = nonNegativeMoney(req.body.countedMpesaKsh, 'countedMpesaKsh');
    const closed = db.transaction(() => {
      const closedAt = DateTime.utc().toISO();
      const changed = db.prepare(`
        UPDATE shifts
        SET status = 'closed', status_label = 'Closed', closed_at = ?,
            counted_cash_cents = ?, counted_mpesa_cents = ?,
            closing_cash = ?, closing_mpesa = ?, closing_notes = ?,
            updated_at = ?
        WHERE id = ? AND status = 'open'
      `).run(closedAt, countedCash, countedMpesa, countedCash / 100.0, countedMpesa / 100.0, req.body.notes || null, closedAt, id);
      if (changed.changes !== 1) throw conflict('Shift is already closed');
      const reconciliation = buildReconciliation(db, { ...row, closed_at: closedAt });
      db.prepare('UPDATE shifts SET reconciliation_json = ? WHERE id = ?').run(JSON.stringify(reconciliation), id);
      const refreshed = recalculateShiftStoredTotals(db, id);
      recordAudit(db, {
        req,
        category: 'shift',
        event: 'shift.closed',
        metadata: {
          shiftId: id,
          expectedCashKsh: refreshed.expected_cash_cents / 100,
          expectedMpesaKsh: refreshed.expected_mpesa_cents / 100,
          totalDiscrepancyKsh: refreshed.total_difference_cents / 100,
          reconciliation,
        },
      });
      return refreshed;
    })();
    closed.user_role = req.auth.user.role;
    res.json({ shift: serializeShift(closed), summary: serializeShift(closed).summary });
  }));

  return router;
}
