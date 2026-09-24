import { Hono } from 'hono';
import { auditForContext } from './audit';
import { assertOperationCreated, first, operationStatement } from './db';
import { conflict, forbidden, notFound } from './errors';
import { money, paginated, pagination, parseJsonBody, positiveId, randomId } from './http';
import { getDateRange, dateKey } from './date';
import { getSettings } from './settings';
import { serializeShift } from './serializers';
import { parseQuery, shiftCloseSchema, shiftOpenSchema, shiftsListSchema } from './validators';
import { nonNegativeMoney } from './http';
import type { AppEnv, AppContext, AuthUser, DbRow } from './types';

export const SHIFT_SELECT = `
  SELECT s.*, u.username, u.full_name,
    COALESCE((SELECT SUM(sa.cash_cents) FROM sales sa WHERE sa.shift_id = s.id), 0) AS sales_cash_cents,
    COALESCE((SELECT SUM(sa.mpesa_cents) FROM sales sa WHERE sa.shift_id = s.id), 0) AS sales_mpesa_cents,
    COALESCE((SELECT SUM(sa.amount_cents) FROM sales sa WHERE sa.shift_id = s.id), 0) AS sales_total_cents,
    COALESCE((SELECT SUM(sa.litres) FROM sales sa WHERE sa.litres IS NOT NULL), 0) AS litres,
    COALESCE((SELECT SUM(e.amount_cents) FROM expenses e WHERE e.shift_id = s.id AND e.payment_method = 'cash'), 0) AS expense_cash_cents,
    COALESCE((SELECT SUM(e.amount_cents) FROM expenses e WHERE e.shift_id = s.id AND e.payment_method = 'mpesa'), 0) AS expense_mpesa_cents,
    COALESCE((SELECT COUNT(*) FROM sales sa WHERE sa.shift_id = s.id), 0) AS sale_count,
    COALESCE((SELECT COUNT(*) FROM expenses e WHERE e.shift_id = s.id), 0) AS expense_count
  FROM shifts s
  JOIN users u ON u.id = s.user_id
`;

export async function getOpenShift(db: D1Database, userId: number): Promise<DbRow | null> {
  return first(db, `${SHIFT_SELECT} WHERE s.user_id = ? AND s.status = 'open'`, userId);
}

export async function getShift(db: D1Database, id: number): Promise<DbRow | null> {
  return first(db, `${SHIFT_SELECT} WHERE s.id = ?`, id);
}

export function assertShiftOwner(row: DbRow | null, user: AuthUser): DbRow {
  if (!row) throw notFound('Shift was not found');
  const attendantId = Number(row.attendant_id ?? row.user_id);
  if (user.role !== 'admin' && (Number(row.user_id) !== user.id || attendantId !== user.id)) {
    throw forbidden('You can only access your own shifts');
  }
  return row;
}

export function recalculateShiftStatement(shiftId: number, operationId?: string) {
  const guard = operationId ? `AND EXISTS (SELECT 1 FROM api_operations WHERE id = ?)` : '';
  return {
    sql: `
      UPDATE shifts SET
        expected_cash_cents = opening_float_cents
          + COALESCE((SELECT SUM(cash_cents) FROM sales WHERE shift_id = ?), 0)
          - COALESCE((SELECT SUM(amount_cents) FROM expenses WHERE shift_id = ? AND payment_method = 'cash'), 0),
        expected_mpesa_cents = opening_float_mpesa_cents
          + COALESCE((SELECT SUM(mpesa_cents) FROM sales WHERE shift_id = ?), 0)
          - COALESCE((SELECT SUM(amount_cents) FROM expenses WHERE shift_id = ? AND payment_method = 'mpesa'), 0),
        expected_cash = (opening_float_cents
          + COALESCE((SELECT SUM(cash_cents) FROM sales WHERE shift_id = ?), 0)
          - COALESCE((SELECT SUM(amount_cents) FROM expenses WHERE shift_id = ? AND payment_method = 'cash'), 0)) / 100.0,
        expected_mpesa = (opening_float_mpesa_cents
          + COALESCE((SELECT SUM(mpesa_cents) FROM sales WHERE shift_id = ?), 0)
          - COALESCE((SELECT SUM(amount_cents) FROM expenses WHERE shift_id = ? AND payment_method = 'mpesa'), 0)) / 100.0,
        cash_difference_cents = CASE
          WHEN counted_cash_cents IS NULL THEN NULL
          ELSE counted_cash_cents - (opening_float_cents
            + COALESCE((SELECT SUM(cash_cents) FROM sales WHERE shift_id = ?), 0)
            - COALESCE((SELECT SUM(amount_cents) FROM expenses WHERE shift_id = ? AND payment_method = 'cash'), 0))
        END,
        mpesa_difference_cents = CASE
          WHEN counted_mpesa_cents IS NULL THEN NULL
          ELSE counted_mpesa_cents - (opening_float_mpesa_cents
            + COALESCE((SELECT SUM(mpesa_cents) FROM sales WHERE shift_id = ?), 0)
            - COALESCE((SELECT SUM(amount_cents) FROM expenses WHERE shift_id = ? AND payment_method = 'mpesa'), 0))
        END,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
      WHERE id = ?${guard}
    `,
    bindings: [shiftId, shiftId, shiftId, shiftId, shiftId, shiftId, shiftId, shiftId, shiftId, shiftId, shiftId, shiftId, shiftId, ...(operationId ? [operationId] : [])],
  };
}

export async function recalculateShift(db: D1Database, shiftId: number): Promise<void> {
  const statement = recalculateShiftStatement(shiftId);
  await db.prepare(statement.sql).bind(...statement.bindings).run();
}

async function buildReconciliation(db: D1Database, shift: DbRow, closedAt: string) {
  const settings = await getSettings(db);
  const from = dateKey(String(shift.opened_at), settings.timezone);
  const to = dateKey(closedAt, settings.timezone);
  const range = getDateRange(from, to, settings.timezone);
  const recorded = await first<DbRow>(db, `
    SELECT COALESCE(SUM(cash_cents), 0) AS cash, COALESCE(SUM(mpesa_cents), 0) AS mpesa
    FROM sales WHERE shift_id = ?
  `, shift.id);
  const meters = (await first<DbRow>(db, `
    SELECT
      COALESCE((SELECT SUM(reconciliation_value_cents) FROM sales_readings WHERE "date" >= ? AND "date" <= ?), 0) AS sales_cents,
      COALESCE((SELECT COUNT(*) FROM sales_readings WHERE "date" >= ? AND "date" <= ?), 0) AS sales_reading_count,
      COALESCE((SELECT SUM(consumption) FROM pump_readings WHERE "date" >= ? AND "date" <= ?), 0) AS pump_litres,
      COALESCE((SELECT COUNT(*) FROM pump_readings WHERE "date" >= ? AND "date" <= ?), 0) AS pump_reading_count
  `, from, to, from, to, from, to, from, to)) || {};
  const salesCents = Number(meters.sales_cents || 0);
  const recordedCash = Number(recorded?.cash || 0);
  const recordedMpesa = Number(recorded?.mpesa || 0);
  const salesReadingCount = Number(meters.sales_reading_count || 0);
  const pumpReadingCount = Number(meters.pump_reading_count || 0);
  return {
    recordedCashKsh: money(recordedCash),
    recordedMpesaKsh: money(recordedMpesa),
    recordedTotalKsh: money(recordedCash + recordedMpesa),
    salesMeterKsh: money(salesCents),
    salesMeterVarianceKsh: money(salesCents - recordedCash - recordedMpesa),
    pumpLitres: Number(meters.pump_litres || 0),
    salesReadingCount,
    pumpReadingCount,
    dataStatus: salesReadingCount ? (pumpReadingCount ? 'available' : 'partial') : 'noSalesMeterReadings',
    timezone: settings.timezone,
    range: { from, to },
  };
}

export function shiftsRouter(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/open', async (c) => {
    const row = await getOpenShift(c.env.DB, c.get('auth').id);
    return c.json({ shift: row ? serializeShift(row, c.get('auth').role) : null });
  });

  app.get('/mine', async (c) => {
    const query = parseQuery(c, shiftsListSchema);
    const page = pagination(query.page, query.pageSize);
    const where = ['s.user_id = ?'];
    const bindings: Array<string | number> = [c.get('auth').id];
    if (query.status) { where.push('s.status = ?'); bindings.push(query.status); }
    if (query.from) { where.push('date(s.opened_at) >= ?'); bindings.push(query.from); }
    if (query.to) { where.push('date(s.opened_at) <= ?'); bindings.push(query.to); }
    const clause = `WHERE ${where.join(' AND ')}`;
    const rows = await c.env.DB.prepare(`${SHIFT_SELECT} ${clause} ORDER BY s.opened_at DESC LIMIT ? OFFSET ?`)
      .bind(...bindings, page.pageSize, page.offset).all<DbRow>();
    const count = await first<{ count: number }>(c.env.DB, `SELECT COUNT(*) AS count FROM shifts s ${clause}`, ...bindings);
    return c.json(paginated(rows.results, Number(count?.count || 0), page, (row) => serializeShift(row, c.get('auth').role)));
  });

  app.get('/history', async (c) => {
    const actor = c.get('auth');
    const query = parseQuery(c, shiftsListSchema);
    const page = pagination(query.page, query.pageSize);
    const where: string[] = [];
    const bindings: Array<string | number> = [];
    if (actor.role !== 'admin') { where.push('s.user_id = ?'); bindings.push(actor.id); }
    else if (query.userId) { where.push('s.user_id = ?'); bindings.push(query.userId); }
    if (query.status) { where.push('s.status = ?'); bindings.push(query.status); }
    if (query.from) { where.push('date(s.opened_at) >= ?'); bindings.push(query.from); }
    if (query.to) { where.push('date(s.opened_at) <= ?'); bindings.push(query.to); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const rows = await c.env.DB.prepare(`${SHIFT_SELECT} ${clause} ORDER BY s.opened_at DESC LIMIT ? OFFSET ?`)
      .bind(...bindings, page.pageSize, page.offset).all<DbRow>();
    const count = await first<{ count: number }>(c.env.DB, `SELECT COUNT(*) AS count FROM shifts s ${clause}`, ...bindings);
    return c.json(paginated(rows.results, Number(count?.count || 0), page, (row) => serializeShift(row, actor.role)));
  });

  app.post('/open', async (c) => {
    const body = await parseJsonBody(c, shiftOpenSchema);
    const actor = c.get('auth');
    if (await getOpenShift(c.env.DB, actor.id)) throw conflict('You already have an open shift');
    const openingCash = nonNegativeMoney(body.openingCashKsh, 'openingCashKsh');
    const openingMpesa = nonNegativeMoney(body.openingMpesaKsh, 'openingMpesaKsh');
    const id = randomId();
    const now = new Date().toISOString();
    const operation = operationStatement({
      db: c.env.DB,
      kind: 'shift_open',
      entityTable: 'shifts',
      entityId: id,
      requestId: c.get('requestId'),
      guard: { userId: actor.id, openingCash, openingMpesa },
      conditionSql: 'NOT EXISTS (SELECT 1 FROM shifts WHERE user_id = ? AND status = \'open\')',
      conditionBindings: [actor.id],
      entityCondition: false,
    });
    const audit = auditForContext(c, {
      category: 'shift', event: 'shift.opened', metadata: { shiftId: id, attendantId: actor.id }, operationId: operation.id,
    });
    const statements = [
      c.env.DB.prepare(operation.sql).bind(...operation.bindings),
      c.env.DB.prepare(`
        INSERT INTO shifts (
          id, user_id, attendant_id, status, status_label, opened_at,
          opening_float_cents, opening_float_mpesa_cents, opening_cash, opening_mpesa,
          expected_cash_cents, expected_mpesa_cents, expected_cash, expected_mpesa, created_at, updated_at
        )
        SELECT ?, ?, ?, 'open', 'Open', ?, ?, ?, ?, ?, 0, 0, 0, 0, ?, ?
        WHERE EXISTS (SELECT 1 FROM api_operations WHERE id = ?)
      `).bind(id, actor.id, actor.id, now, openingCash, openingMpesa, openingCash / 100, openingMpesa / 100, now, now, operation.id),
      c.env.DB.prepare(audit.sql).bind(...audit.bindings),
    ];
    await c.env.DB.batch(statements);
    await assertOperationCreated(c.env.DB, operation.id);
    const row = await getShift(c.env.DB, id);
    if (!row) throw conflict('Shift could not be opened; retry the request');
    return c.json({ shift: serializeShift(row, actor.role) }, 201);
  });

  app.get('/:id', async (c) => {
    const row = assertShiftOwner(await getShift(c.env.DB, positiveId(c.req.param('id'))), c.get('auth'));
    return c.json({ shift: serializeShift(row, c.get('auth').role) });
  });

  app.post('/:id/close', async (c) => {
    const id = positiveId(c.req.param('id'));
    const actor = c.get('auth');
    const row = assertShiftOwner(await getShift(c.env.DB, id), actor);
    if (row.status !== 'open') throw conflict('Shift is already closed');
    const body = await parseJsonBody(c, shiftCloseSchema);
    const countedCash = nonNegativeMoney(body.countedCashKsh, 'countedCashKsh');
    const countedMpesa = nonNegativeMoney(body.countedMpesaKsh, 'countedMpesaKsh');
    const closedAt = new Date().toISOString();
    const reconciliation = await buildReconciliation(c.env.DB, row, closedAt);
    const operation = operationStatement({
      db: c.env.DB,
      kind: 'shift_close',
      entityTable: 'shifts',
      entityId: id,
      requestId: c.get('requestId'),
      guard: { status: 'open', updatedAt: row.updated_at },
      conditionSql: 'id = ? AND status = \'open\' AND updated_at = ?',
      conditionBindings: [id, String(row.updated_at)],
    });
    const recalculate = recalculateShiftStatement(id, operation.id);
    const audit = auditForContext(c, {
      category: 'shift', event: 'shift.closed', operationId: operation.id,
      metadata: { shiftId: id, reconciliation },
    });
    await c.env.DB.batch([
      c.env.DB.prepare(operation.sql).bind(...operation.bindings),
      c.env.DB.prepare(`
        UPDATE shifts SET
          status = 'closed', status_label = 'Closed', closed_at = ?,
          counted_cash_cents = ?, counted_mpesa_cents = ?, closing_cash = ?, closing_mpesa = ?,
          reconciliation_json = ?, closing_notes = ?, updated_at = ?
        WHERE id = ? AND status = 'open' AND EXISTS (SELECT 1 FROM api_operations WHERE id = ?)
      `).bind(closedAt, countedCash, countedMpesa, countedCash / 100, countedMpesa / 100, JSON.stringify(reconciliation), body.notes || null, closedAt, id, operation.id),
      c.env.DB.prepare(recalculate.sql).bind(...recalculate.bindings),
      c.env.DB.prepare(audit.sql).bind(...audit.bindings),
    ]);
    await assertOperationCreated(c.env.DB, operation.id);
    const closed = await getShift(c.env.DB, id);
    if (!closed) throw notFound('Shift was not found');
    const serialized = serializeShift(closed, actor.role);
    return c.json({ shift: serialized, summary: serialized.summary });
  });

  return app;
}
