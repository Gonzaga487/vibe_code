import { Router } from 'express';
import { z } from 'zod';
import { DateTime } from 'luxon';
import { MAX_MONEY_CENTS, asyncHandler, getPagination, money, paginated, parseId, positiveMoney, roundLitres, toCents } from '../lib/http.js';
import { badRequest, forbidden, notFound } from '../lib/errors.js';
import { validate } from '../middleware/validate.js';
import { requireAdmin } from '../middleware/auth.js';
import { recordAudit } from '../services/audit.js';
import { getFuelOrThrow, getPumpOrThrow } from '../services/inventory.js';
import { getDateRange, getSettings } from '../services/settings.js';
import { getOpenShift, recalculateShiftStoredTotals } from './shifts.js';

const litresSchema = z.number().finite().positive().max(100000).refine(
  (value) => Math.abs(value * 1000 - Math.round(value * 1000)) < 0.000001,
  'litres supports at most 3 decimal places',
);
const amountSchema = z.number().finite().positive().max(MAX_MONEY_CENTS / 100);
const optionalMoneySchema = z.number().finite().nonnegative().max(MAX_MONEY_CENTS / 100).optional();

const saleSchema = z.object({
  mode: z.enum(['quick', 'detailed']),
  paymentMethod: z.enum(['cash', 'mpesa', 'mixed']),
  amountKsh: amountSchema.optional(),
  fuelId: z.coerce.number().int().positive().safe().optional(),
  pumpId: z.coerce.number().int().positive().safe().optional(),
  litres: litresSchema.optional(),
  cashAmountKsh: optionalMoneySchema,
  mpesaAmountKsh: optionalMoneySchema,
  unitPriceKsh: z.number().finite().positive().max(MAX_MONEY_CENTS / 100).optional(),
  customerName: z.string().trim().min(1).max(120).optional(),
  notes: z.string().trim().max(1000).optional(),
  soldAt: z.iso.datetime({ offset: true }).optional(),
}).strict().superRefine((value, context) => {
  if (value.mode === 'detailed' && value.pumpId === undefined) {
    context.addIssue({ code: 'custom', path: ['pumpId'], message: 'Detailed sales require a configured pump or meter ID' });
  }
  if (value.mode === 'detailed' && value.fuelId === undefined && value.pumpId === undefined) {
    context.addIssue({ code: 'custom', path: ['fuelId'], message: 'Detailed sales require a configured fuel type' });
  }
  if (value.paymentMethod === 'mixed' && (value.cashAmountKsh === undefined || value.mpesaAmountKsh === undefined)) {
    context.addIssue({ code: 'custom', path: ['cashAmountKsh'], message: 'Mixed payments require both cash and M-Pesa amounts' });
  }
  if (value.amountKsh === undefined && value.cashAmountKsh === undefined && value.mpesaAmountKsh === undefined && value.litres === undefined) {
    context.addIssue({ code: 'custom', path: ['amountKsh'], message: 'An amount or legacy litres value is required' });
  }
  if (value.soldAt) {
    const soldAt = DateTime.fromISO(value.soldAt);
    if (!soldAt.isValid || soldAt > DateTime.utc()) {
      context.addIssue({ code: 'custom', path: ['soldAt'], message: 'soldAt must be a valid timestamp that is not in the future' });
    }
  }
});

const listSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  shiftId: z.coerce.number().int().positive().optional(),
  userId: z.coerce.number().int().positive().optional(),
  fuelId: z.coerce.number().int().positive().optional(),
  fuelType: z.enum(['PETROL', 'DIESEL']).optional(),
  pumpId: z.coerce.number().int().positive().optional(),
  mode: z.enum(['quick', 'detailed']).optional(),
  paymentMethod: z.enum(['cash', 'mpesa', 'mixed']).optional(),
  search: z.string().trim().max(120).optional(),
}).strict().refine((value) => !value.from || !value.to || value.from <= value.to, 'from cannot be after to');

const saleSelect = `
  SELECT sa.*, u.username, u.full_name,
    COALESCE(sa.fuel_type, f.fuel_type) AS fuel_type
  FROM sales sa
  JOIN users u ON u.id = sa.user_id
  LEFT JOIN fuel_management f ON f.id = sa.fuel_id
`;

export function serializeSale(row, role) {
  const response = {
    id: row.id,
    shiftId: row.shift_id,
    user: { id: row.user_id, username: row.username, fullName: row.full_name },
    mode: row.mode,
    amountKsh: money(row.amount_cents),
    totalKsh: money(row.total_cents),
    payment: {
      method: row.payment_method,
      cashKsh: money(row.cash_cents),
      mpesaKsh: money(row.mpesa_cents),
    },
    fuel: row.fuel_id ? { id: row.fuel_id, type: row.fuel_type } : null,
    pumpId: row.pump_id,
    litres: row.litres,
    customerName: row.customer_name,
    notes: row.notes,
    soldAt: row.sold_at,
    timestamp: row.timestamp,
    createdAt: row.created_at,
  };
  if (role === 'admin') {
    response.unitPriceKsh = row.unit_price_cents === null ? null : money(row.unit_price_cents);
    response.unitCostKsh = row.unit_cost_cents === null ? null : money(row.unit_cost_cents);
  }
  return response;
}

function enteredAmountCents(body) {
  if (body.amountKsh !== undefined) return positiveMoney(body.amountKsh, 'amountKsh');
  if (body.paymentMethod === 'mixed') {
    return toCents(body.cashAmountKsh, 'cashAmountKsh') + toCents(body.mpesaAmountKsh, 'mpesaAmountKsh');
  }
  if (body.paymentMethod === 'cash' && body.cashAmountKsh !== undefined) return toCents(body.cashAmountKsh, 'cashAmountKsh');
  if (body.paymentMethod === 'mpesa' && body.mpesaAmountKsh !== undefined) return toCents(body.mpesaAmountKsh, 'mpesaAmountKsh');
  return null;
}

function validateSplitAmounts(body, totalCents) {
  if (body.paymentMethod === 'cash') {
    if (body.mpesaAmountKsh !== undefined && toCents(body.mpesaAmountKsh) !== 0) throw badRequest('An M-Pesa amount cannot be supplied with a cash payment');
    return { cashCents: totalCents, mpesaCents: 0 };
  }
  if (body.paymentMethod === 'mpesa') {
    if (body.cashAmountKsh !== undefined && toCents(body.cashAmountKsh) !== 0) throw badRequest('A cash amount cannot be supplied with an M-Pesa payment');
    return { cashCents: 0, mpesaCents: totalCents };
  }
  const cashCents = toCents(body.cashAmountKsh, 'cashAmountKsh');
  const mpesaCents = toCents(body.mpesaAmountKsh, 'mpesaAmountKsh');
  if (cashCents <= 0 || mpesaCents <= 0 || cashCents + mpesaCents !== totalCents) {
    throw badRequest('Mixed payment amounts must both be positive and add up to the sale amount');
  }
  return { cashCents, mpesaCents };
}

export function createSalesRouter({ db }) {
  const router = Router();

  router.post('/', validate(saleSchema), (req, res) => {
    const actor = req.auth.user;
    const body = req.body;
    const shift = getOpenShift(db, actor.id);
    if (!shift) throw badRequest('An open shift is required before recording a sale');

    let fuel = null;
    let pump = null;
    if (body.pumpId !== undefined) pump = getPumpOrThrow(db, body.pumpId, { active: true });
    if (body.fuelId !== undefined) fuel = getFuelOrThrow(db, body.fuelId, { active: true });
    if (pump && fuel && pump.fuel_id !== fuel.id) throw badRequest('The selected pump does not belong to the selected fuel type');
    if (!fuel && pump) fuel = getFuelOrThrow(db, pump.fuel_id, { active: true });
    if (body.mode === 'detailed' && (!fuel || !pump)) throw badRequest('Detailed sales require an active configured fuel and pump');

    if (body.unitPriceKsh !== undefined && actor.role !== 'admin') {
      throw forbidden('Only an administrator may override a selling price');
    }
    const unitPriceCents = body.unitPriceKsh === undefined
      ? fuel?.selling_price_cents ?? null
      : positiveMoney(body.unitPriceKsh, 'unitPriceKsh');
    const litres = body.litres === undefined ? null : roundLitres(body.litres);
    let totalCents = enteredAmountCents(body);
    if (totalCents === null) {
      if (litres === null || unitPriceCents === null) throw badRequest('amountKsh is required when litres or unit price is unavailable');
      totalCents = Math.round(litres * unitPriceCents);
    }
    if (!Number.isSafeInteger(totalCents) || totalCents <= 0 || totalCents > MAX_MONEY_CENTS) {
      throw badRequest('Sale amount is outside the supported range');
    }
    const { cashCents, mpesaCents } = validateSplitAmounts(body, totalCents);
    const soldAt = body.soldAt ? DateTime.fromISO(body.soldAt).toUTC().toISO() : DateTime.utc().toISO();
    if (DateTime.fromISO(soldAt) < DateTime.fromISO(shift.opened_at)) {
      throw badRequest('Sale timestamp cannot be before the shift opened');
    }
    const fuelType = fuel?.fuel_type ?? null;
    const legacy = body.amountKsh === undefined;
    const id = db.transaction(() => {
      const currentShift = getOpenShift(db, actor.id);
      if (!currentShift) throw badRequest('An open shift is required before recording a sale');
      const result = db.prepare(`
        INSERT INTO sales (
          shift_id, user_id, fuel_id, fuel_type, litres, unit_price_cents, unit_cost_cents,
          amount_cents, amount, total_cents, cash_cents, mpesa_cents, payment_method, mode, pump_id,
          customer_name, notes, sold_at, timestamp
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        currentShift.id,
        actor.id,
        fuel?.id ?? null,
        fuelType,
        litres,
        unitPriceCents,
        fuel?.weighted_average_cost_cents ?? null,
        totalCents,
        totalCents / 100.0,
        totalCents,
        cashCents,
        mpesaCents,
        body.paymentMethod,
        body.mode,
        pump?.id ?? null,
        body.customerName || null,
        body.notes || null,
        soldAt,
        soldAt,
      );
      const saleId = Number(result.lastInsertRowid);
      recordAudit(db, {
        req,
        category: 'sale',
        event: body.mode === 'quick' ? 'sale.quick_created' : 'sale.detailed_created',
        metadata: { saleId, shiftId: currentShift.id, amountKsh: totalCents / 100, mode: body.mode, legacy },
      });
      return saleId;
    })();
    const row = db.prepare(`${saleSelect} WHERE sa.id = ?`).get(id);
    res.status(201).json({ sale: serializeSale(row, actor.role) });
  });

  router.get('/', validate(listSchema, 'query'), (req, res) => {
    const actor = req.auth.user;
    const filters = req.validatedQuery;
    const pagination = getPagination(filters);
    const where = [];
    const params = [];
    if (filters.from || filters.to) {
      const settings = getSettings(db);
      const from = filters.from || '0001-01-01';
      const to = filters.to || '9999-12-31';
      const range = getDateRange(db, from, to);
      where.push('sa.sold_at >= ?', 'sa.sold_at <= ?');
      params.push(range.startUtc, range.endUtc);
      void settings;
    }
    if (actor.role !== 'admin') {
      where.push('sa.user_id = ?');
      params.push(actor.id);
    } else if (filters.userId) {
      where.push('sa.user_id = ?');
      params.push(filters.userId);
    }
    if (filters.shiftId) { where.push('sa.shift_id = ?'); params.push(filters.shiftId); }
    if (filters.fuelId) { where.push('sa.fuel_id = ?'); params.push(filters.fuelId); }
    if (filters.fuelType) { where.push('sa.fuel_type = ?'); params.push(filters.fuelType); }
    if (filters.pumpId) { where.push('sa.pump_id = ?'); params.push(filters.pumpId); }
    if (filters.mode) { where.push('sa.mode = ?'); params.push(filters.mode); }
    if (filters.paymentMethod) { where.push('sa.payment_method = ?'); params.push(filters.paymentMethod); }
    if (filters.search) {
      where.push("(CAST(sa.id AS TEXT) LIKE ? ESCAPE '\\' OR sa.customer_name LIKE ? ESCAPE '\\' OR sa.notes LIKE ? ESCAPE '\\')");
      const term = `%${filters.search.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`;
      params.push(term, term, term);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const rows = db.prepare(`${saleSelect} ${clause} ORDER BY sa.sold_at DESC, sa.id DESC LIMIT ? OFFSET ?`).all(...params, pagination.pageSize, pagination.offset);
    const countParams = params.slice(0, where.length);
    const total = db.prepare(`SELECT COUNT(*) AS count FROM sales sa ${clause}`).get(...countParams).count;
    res.json(paginated(rows, total, pagination, (row) => serializeSale(row, actor.role)));
  });

  router.delete('/:id', requireAdmin, (req, res) => {
    const id = parseId(req.params.id);
    const sale = db.prepare('SELECT * FROM sales WHERE id = ?').get(id);
    if (!sale) throw notFound('Sale was not found');
    db.transaction(() => {
      db.prepare('DELETE FROM sales WHERE id = ?').run(id);
      recalculateShiftStoredTotals(db, sale.shift_id);
      recordAudit(db, {
        req,
        category: 'sale',
        event: 'sale.deleted',
        metadata: { saleId: id, shiftId: sale.shift_id, amountKsh: sale.amount_cents / 100 },
      });
    })();
    res.json({ deleted: true, id });
  });

  return router;
}
