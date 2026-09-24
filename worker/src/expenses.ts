import { Hono } from 'hono';
import { auditForContext } from './audit';
import { dateKey, todayInTimezone } from './date';
import { assertOperationCreated, first, operationStatement } from './db';
import { badRequest, forbidden, notFound } from './errors';
import { paginated, pagination, parseJsonBody, positiveId, positiveMoney, randomId } from './http';
import { getSettings } from './settings';
import { serializeExpense } from './serializers';
import { getOpenShift, recalculateShiftStatement } from './shifts';
import { expenseCreateSchema, expensePatchSchema, expensesListSchema, parseQuery } from './validators';
import type { AppEnv, AppContext, AuthUser, DbRow } from './types';

async function scopedExpense(db: D1Database, id: number, actor: AuthUser): Promise<DbRow> {
  const row = await first(db, `
    SELECT e.*, u.username, u.full_name FROM expenses e JOIN users u ON u.id = e.user_id WHERE e.id = ?
  `, id);
  if (!row) throw notFound('Expense was not found');
  if (actor.role !== 'admin' && Number(row.user_id) !== actor.id) throw forbidden('You can only access your own expenses');
  return row;
}

async function resolveShift(db: D1Database, actor: AuthUser, shiftId: number | null | undefined, requireOpen = true): Promise<DbRow | null> {
  if (shiftId !== undefined && shiftId !== null) {
    const shift = await first(db, 'SELECT * FROM shifts WHERE id = ?', shiftId);
    if (!shift) throw notFound('Shift was not found');
    if (actor.role !== 'admin' && Number(shift.user_id) !== actor.id) throw forbidden('You can only access your own shift');
    if (actor.role !== 'admin' && requireOpen && shift.status !== 'open') throw badRequest('Attendant expenses must be created against an open shift');
    return shift;
  }
  if (actor.role === 'admin') return null;
  const shift = await getOpenShift(db, actor.id);
  if (!shift) throw badRequest('An open shift is required before recording an expense');
  return shift;
}

async function validateExpenseDate(
  db: D1Database,
  actor: AuthUser,
  date: string,
  shift: DbRow | null,
): Promise<string> {
  const settings = await getSettings(db);
  if (date > todayInTimezone(settings.timezone)) throw badRequest('expenseDate cannot be in the future');
  if (shift && date < dateKey(String(shift.opened_at), settings.timezone)) throw badRequest('expenseDate cannot be before the related shift opened');
  if (actor.role !== 'admin' && !shift) throw badRequest('Attendants must link an expense to their own open shift');
  return date;
}

export function expensesRouter(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.get('/', async (c) => {
    const actor = c.get('auth');
    const filters = parseQuery(c, expensesListSchema);
    const page = pagination(filters.page, filters.pageSize);
    const where: string[] = [];
    const bindings: Array<string | number> = [];
    if (actor.role !== 'admin') { where.push('e.user_id = ?'); bindings.push(actor.id); }
    else if (filters.userId) { where.push('e.user_id = ?'); bindings.push(filters.userId); }
    if (filters.from) { where.push('e.expense_date >= ?'); bindings.push(filters.from); }
    if (filters.to) { where.push('e.expense_date <= ?'); bindings.push(filters.to); }
    if (filters.shiftId) { where.push('e.shift_id = ?'); bindings.push(filters.shiftId); }
    if (filters.category) { where.push('e.category = ?'); bindings.push(filters.category); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const rows = await c.env.DB.prepare(`
      SELECT e.*, u.username, u.full_name FROM expenses e JOIN users u ON u.id = e.user_id
      ${clause} ORDER BY e.timestamp DESC, e.id DESC LIMIT ? OFFSET ?
    `).bind(...bindings, page.pageSize, page.offset).all<DbRow>();
    const count = await first<{ count: number }>(c.env.DB, `SELECT COUNT(*) AS count FROM expenses e ${clause}`, ...bindings);
    return c.json(paginated(rows.results, Number(count?.count || 0), page, serializeExpense));
  });

  app.get('/:id', async (c) => c.json({ expense: serializeExpense(await scopedExpense(c.env.DB, positiveId(c.req.param('id')), c.get('auth'))) }));

  app.post('/', async (c) => {
    const actor = c.get('auth');
    const body = await parseJsonBody(c, expenseCreateSchema);
    const shift = await resolveShift(c.env.DB, actor, body.shiftId);
    const settings = await getSettings(c.env.DB);
    const date = await validateExpenseDate(c.env.DB, actor, body.expenseDate || todayInTimezone(settings.timezone), shift);
    const cents = positiveMoney(body.amountKsh);
    const id = randomId();
    const timestamp = new Date().toISOString();
    const operation = operationStatement({
      db: c.env.DB, kind: 'expense_create', entityTable: 'expenses', entityId: id, requestId: c.get('requestId'),
      guard: { shiftId: shift?.id ?? null, amountCents: cents },
      conditionSql: shift ? 'EXISTS (SELECT 1 FROM shifts WHERE id = ? AND status = \'open\')' : '1 = 1',
      conditionBindings: shift ? [shift.id] : [],
      entityCondition: false,
    });
    const audit = auditForContext(c, {
      category: 'expense', event: 'expense.created', operationId: operation.id,
      metadata: { expenseId: id, shiftId: shift?.id ?? null, amountKsh: cents / 100 },
    });
    const statements = [
      c.env.DB.prepare(operation.sql).bind(...operation.bindings),
      c.env.DB.prepare(`
        INSERT INTO expenses
          (id, shift_id, user_id, category, description, amount_cents, amount, payment_method, expense_date, notes, timestamp, created_at, updated_at)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM api_operations WHERE id = ?)
      `).bind(id, shift?.id ?? null, actor.id, body.category, body.description, cents, cents / 100, body.paymentMethod, date, body.notes || null, timestamp, timestamp, timestamp, operation.id),
    ];
    if (shift) {
      const recalculate = recalculateShiftStatement(Number(shift.id), operation.id);
      statements.push(c.env.DB.prepare(recalculate.sql).bind(...recalculate.bindings));
    }
    statements.push(c.env.DB.prepare(audit.sql).bind(...audit.bindings));
    await c.env.DB.batch(statements);
    await assertOperationCreated(c.env.DB, operation.id);
    return c.json({ expense: serializeExpense(await scopedExpense(c.env.DB, id, actor)) }, 201);
  });

  app.patch('/:id', async (c) => {
    const id = positiveId(c.req.param('id'));
    const actor = c.get('auth');
    const body = await parseJsonBody(c, expensePatchSchema);
    const current = await scopedExpense(c.env.DB, id, actor);
    const nextShiftId = body.shiftId === undefined ? (current.shift_id === null ? null : Number(current.shift_id)) : body.shiftId;
    const nextShift = await resolveShift(c.env.DB, actor, nextShiftId, false);
    const settings = await getSettings(c.env.DB);
    const nextDate = body.expenseDate || String(current.expense_date);
    await validateExpenseDate(c.env.DB, actor, nextDate, nextShift);
    const cents = body.amountKsh === undefined ? Number(current.amount_cents) : positiveMoney(body.amountKsh);
    const timestamp = new Date().toISOString();
    const operation = operationStatement({
      db: c.env.DB, kind: 'expense_update', entityTable: 'expenses', entityId: id, requestId: c.get('requestId'),
      guard: { fields: Object.keys(body) }, conditionSql: 'id = ? AND updated_at = ?', conditionBindings: [id, String(current.updated_at)],
    });
    const audit = auditForContext(c, {
      category: 'expense', event: 'expense.updated', operationId: operation.id,
      metadata: { expenseId: id, fields: Object.keys(body) },
    });
    const statements = [
      c.env.DB.prepare(operation.sql).bind(...operation.bindings),
      c.env.DB.prepare(`
        UPDATE expenses SET shift_id = ?, category = ?, description = ?, amount_cents = ?, amount = ?, payment_method = ?,
          expense_date = ?, notes = ?, timestamp = ?, updated_at = ?
        WHERE id = ? AND EXISTS (SELECT 1 FROM api_operations WHERE id = ?)
      `).bind(nextShift?.id ?? null, body.category ?? current.category, body.description ?? current.description,
        cents, cents / 100, body.paymentMethod ?? current.payment_method, nextDate,
        body.notes === undefined ? current.notes : (body.notes || null), timestamp, timestamp, id, operation.id),
    ];
    if (current.shift_id !== null) {
      const recalculate = recalculateShiftStatement(Number(current.shift_id), operation.id);
      statements.push(c.env.DB.prepare(recalculate.sql).bind(...recalculate.bindings));
    }
    if (nextShift && Number(nextShift.id) !== Number(current.shift_id)) {
      const recalculate = recalculateShiftStatement(Number(nextShift.id), operation.id);
      statements.push(c.env.DB.prepare(recalculate.sql).bind(...recalculate.bindings));
    }
    statements.push(c.env.DB.prepare(audit.sql).bind(...audit.bindings));
    await c.env.DB.batch(statements);
    await assertOperationCreated(c.env.DB, operation.id);
    return c.json({ expense: serializeExpense(await scopedExpense(c.env.DB, id, actor)) });
  });

  app.delete('/:id', async (c) => {
    const id = positiveId(c.req.param('id'));
    const actor = c.get('auth');
    const current = await scopedExpense(c.env.DB, id, actor);
    const operation = operationStatement({
      db: c.env.DB, kind: 'expense_delete', entityTable: 'expenses', entityId: id, requestId: c.get('requestId'),
      guard: { expenseId: id }, conditionSql: 'id = ? AND updated_at = ?', conditionBindings: [id, String(current.updated_at)],
    });
    const audit = auditForContext(c, {
      category: 'expense', event: 'expense.deleted', operationId: operation.id,
      metadata: { expenseId: id, shiftId: current.shift_id, amountKsh: Number(current.amount_cents) / 100 },
    });
    const statements = [
      c.env.DB.prepare(operation.sql).bind(...operation.bindings),
      c.env.DB.prepare('DELETE FROM expenses WHERE id = ? AND EXISTS (SELECT 1 FROM api_operations WHERE id = ?)').bind(id, operation.id),
    ];
    if (current.shift_id !== null) {
      const recalculate = recalculateShiftStatement(Number(current.shift_id), operation.id);
      statements.push(c.env.DB.prepare(recalculate.sql).bind(...recalculate.bindings));
    }
    statements.push(c.env.DB.prepare(audit.sql).bind(...audit.bindings));
    await c.env.DB.batch(statements);
    await assertOperationCreated(c.env.DB, operation.id);
    return c.json({ deleted: true, id });
  });
  return app;
}
