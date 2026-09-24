import { Router } from 'express';
import { z } from 'zod';
import { DateTime } from 'luxon';
import { getPagination, money, paginated, parseId, positiveMoney } from '../lib/http.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { validate } from '../middleware/validate.js';
import { recordAudit } from '../services/audit.js';
import { getSettings } from '../services/settings.js';
import { getOpenShift, recalculateShiftStoredTotals } from './shifts.js';

const createSchema = z.object({
  shiftId: z.coerce.number().int().positive().safe().optional(),
  category: z.enum(['FUEL', 'UTILITIES', 'SALARY', 'MAINTENANCE', 'TRANSPORT', 'OTHER']),
  description: z.string().trim().min(2).max(500),
  amountKsh: z.number().finite().positive(),
  paymentMethod: z.enum(['cash', 'mpesa']),
  expenseDate: z.iso.date().optional(),
  notes: z.string().trim().max(1000).optional(),
}).strict();

const patchSchema = createSchema.partial().refine((value) => Object.keys(value).length > 0, 'At least one field is required');

const listSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  shiftId: z.coerce.number().int().positive().optional(),
  userId: z.coerce.number().int().positive().optional(),
  category: z.enum(['FUEL', 'UTILITIES', 'SALARY', 'MAINTENANCE', 'TRANSPORT', 'OTHER']).optional(),
}).strict().refine((value) => !value.from || !value.to || value.from <= value.to, 'from cannot be after to');

function serializeExpense(row) {
  return {
    id: row.id,
    shiftId: row.shift_id,
    user: { id: row.user_id, username: row.username, fullName: row.full_name },
    category: row.category,
    description: row.description,
    amountKsh: money(row.amount_cents),
    amount: row.amount,
    paymentMethod: row.payment_method,
    expenseDate: row.expense_date,
    timestamp: row.timestamp,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function getScoped(db, id, actor) {
  const row = db.prepare(`
    SELECT e.*, u.username, u.full_name
    FROM expenses e JOIN users u ON u.id = e.user_id
    WHERE e.id = ?
  `).get(id);
  if (!row) throw notFound('Expense was not found');
  if (actor.role !== 'admin' && row.user_id !== actor.id) throw forbidden('You can only access your own expenses');
  return row;
}

function validateExpenseDate(db, actor, date, shift) {
  const timezone = getSettings(db).timezone;
  const today = DateTime.now().setZone(timezone).toISODate();
  if (date > today) throw badRequest('expenseDate cannot be in the future');
  if (shift) {
    const openedDate = DateTime.fromISO(shift.opened_at).setZone(timezone).toISODate();
    if (date < openedDate) throw badRequest('expenseDate cannot be before the related shift opened');
  }
  if (actor.role !== 'admin' && !shift) throw badRequest('Attendants must link an expense to their own open shift');
  if (actor.role !== 'admin' && shift.user_id !== actor.id) throw forbidden('You can only link expenses to your own shift');
  return date;
}

function resolveShift(db, actor, shiftId, { requireOpenForAttendant = true } = {}) {
  if (shiftId !== undefined) {
    const shift = db.prepare('SELECT * FROM shifts WHERE id = ?').get(shiftId);
    if (!shift) throw notFound('Shift was not found');
    if (actor.role !== 'admin' && shift.user_id !== actor.id) throw forbidden('You can only access your own shift');
    if (actor.role !== 'admin' && requireOpenForAttendant && shift.status !== 'open') throw badRequest('Attendant expenses must be created against an open shift');
    return shift;
  }
  if (actor.role === 'admin') return null;
  const shift = getOpenShift(db, actor.id);
  if (!shift) throw badRequest('An open shift is required before recording an expense');
  return shift;
}

export function createExpensesRouter({ db }) {
  const router = Router();

  router.get('/', validate(listSchema, 'query'), (req, res) => {
    const actor = req.auth.user;
    const filters = req.validatedQuery;
    const pagination = getPagination(filters);
    const where = [];
    const params = [];
    if (actor.role !== 'admin') {
      where.push('e.user_id = ?');
      params.push(actor.id);
    } else if (filters.userId) {
      where.push('e.user_id = ?');
      params.push(filters.userId);
    }
    if (filters.from) { where.push('e.expense_date >= ?'); params.push(filters.from); }
    if (filters.to) { where.push('e.expense_date <= ?'); params.push(filters.to); }
    if (filters.shiftId) { where.push('e.shift_id = ?'); params.push(filters.shiftId); }
    if (filters.category) { where.push('e.category = ?'); params.push(filters.category); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const rows = db.prepare(`
      SELECT e.*, u.username, u.full_name
      FROM expenses e JOIN users u ON u.id = e.user_id
      ${clause} ORDER BY e.timestamp DESC, e.id DESC LIMIT ? OFFSET ?
    `).all(...params, pagination.pageSize, pagination.offset);
    const total = db.prepare(`SELECT COUNT(*) AS count FROM expenses e ${clause}`).get(...params).count;
    res.json(paginated(rows, total, pagination, serializeExpense));
  });

  router.get('/:id', (req, res) => {
    res.json({ expense: serializeExpense(getScoped(db, parseId(req.params.id), req.auth.user)) });
  });

  router.post('/', validate(createSchema), (req, res) => {
    const actor = req.auth.user;
    const shift = resolveShift(db, actor, req.body.shiftId);
    const timezone = getSettings(db).timezone;
    const expenseDate = validateExpenseDate(db, actor, req.body.expenseDate || DateTime.now().setZone(timezone).toISODate(), shift);
    const amountCents = positiveMoney(req.body.amountKsh);
    const id = db.transaction(() => {
      const result = db.prepare(`
        INSERT INTO expenses
          (shift_id, user_id, category, description, amount_cents, amount, payment_method, expense_date, notes, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        shift?.id ?? null,
        actor.id,
        req.body.category,
        req.body.description,
        amountCents,
        amountCents / 100.0,
        req.body.paymentMethod,
        expenseDate,
        req.body.notes || null,
        new Date().toISOString(),
      );
      const expenseId = Number(result.lastInsertRowid);
      recordAudit(db, { req, category: 'expense', event: 'expense.created', metadata: { expenseId, shiftId: shift?.id ?? null, amountKsh: req.body.amountKsh } });
      return expenseId;
    })();
    res.status(201).json({ expense: serializeExpense(getScoped(db, id, actor)) });
  });

  router.patch('/:id', validate(patchSchema), (req, res) => {
    const id = parseId(req.params.id);
    const current = getScoped(db, id, req.auth.user);
    const actor = req.auth.user;
    const nextShiftId = req.body.shiftId === undefined ? current.shift_id : req.body.shiftId;
    const nextShift = nextShiftId === null ? null : resolveShift(db, actor, nextShiftId, { requireOpenForAttendant: false });
    const timezone = getSettings(db).timezone;
    const nextDate = req.body.expenseDate || current.expense_date;
    validateExpenseDate(db, actor, nextDate, nextShift);
    const nextAmountCents = req.body.amountKsh === undefined ? current.amount_cents : positiveMoney(req.body.amountKsh);
    db.transaction(() => {
      db.prepare(`
        UPDATE expenses
        SET shift_id = ?, category = ?, description = ?, amount_cents = ?, amount = ?, payment_method = ?,
            expense_date = ?, notes = ?, timestamp = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ?
      `).run(
        nextShift?.id ?? null,
        req.body.category ?? current.category,
        req.body.description ?? current.description,
        nextAmountCents,
        nextAmountCents / 100.0,
        req.body.paymentMethod ?? current.payment_method,
        nextDate,
        req.body.notes === undefined ? current.notes : (req.body.notes || null),
        new Date().toISOString(),
        id,
      );
      if (current.shift_id) recalculateShiftStoredTotals(db, current.shift_id);
      if (nextShift?.id && nextShift.id !== current.shift_id) recalculateShiftStoredTotals(db, nextShift.id);
      recordAudit(db, { req, category: 'expense', event: 'expense.updated', metadata: { expenseId: id, fields: Object.keys(req.body) } });
    })();
    res.json({ expense: serializeExpense(getScoped(db, id, actor)) });
  });

  router.delete('/:id', (req, res) => {
    const id = parseId(req.params.id);
    const current = getScoped(db, id, req.auth.user);
    db.transaction(() => {
      db.prepare('DELETE FROM expenses WHERE id = ?').run(id);
      if (current.shift_id) recalculateShiftStoredTotals(db, current.shift_id);
      recordAudit(db, { req, category: 'expense', event: 'expense.deleted', metadata: { expenseId: id, shiftId: current.shift_id, amountKsh: current.amount_cents / 100 } });
    })();
    res.json({ deleted: true, id });
  });

  return router;
}
