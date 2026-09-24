import { Hono } from 'hono';
import { auditForContext } from './audit';
import { getDateRange } from './date';
import { assertOperationCreated, first, operationStatement } from './db';
import { badRequest, forbidden, notFound } from './errors';
import {
  MAX_MONEY_CENTS,
  escapeLike,
  paginated,
  pagination,
  parseJsonBody,
  positiveId,
  positiveMoney,
  randomId,
  roundLitres,
  toCents,
} from './http';
import { serializeSale } from './serializers';
import { getSettings } from './settings';
import { getOpenShift, recalculateShiftStatement } from './shifts';
import { parseQuery, saleSchema, salesListSchema } from './validators';
import type { AppEnv, AppContext, DbRow, FuelRow, PumpRow } from './types';

const SALE_SELECT = `
  SELECT sa.*, u.username, u.full_name, COALESCE(sa.fuel_type, f.fuel_type) AS fuel_type
  FROM sales sa
  JOIN users u ON u.id = sa.user_id
  LEFT JOIN fuel_management f ON f.id = sa.fuel_id
`;

function enteredAmount(body: {
  amountKsh?: number;
  paymentMethod: 'cash' | 'mpesa' | 'mixed';
  cashAmountKsh?: number;
  mpesaAmountKsh?: number;
}): number | null {
  if (body.amountKsh !== undefined) return positiveMoney(body.amountKsh, 'amountKsh');
  if (body.paymentMethod === 'mixed') return toCents(body.cashAmountKsh, 'cashAmountKsh') + toCents(body.mpesaAmountKsh, 'mpesaAmountKsh');
  if (body.paymentMethod === 'cash' && body.cashAmountKsh !== undefined) return toCents(body.cashAmountKsh, 'cashAmountKsh');
  if (body.paymentMethod === 'mpesa' && body.mpesaAmountKsh !== undefined) return toCents(body.mpesaAmountKsh, 'mpesaAmountKsh');
  return null;
}

function splitPayment(body: Parameters<typeof enteredAmount>[0], totalCents: number): { cash: number; mpesa: number } {
  if (body.paymentMethod === 'cash') {
    if (body.mpesaAmountKsh !== undefined && toCents(body.mpesaAmountKsh) !== 0) throw badRequest('An M-Pesa amount cannot be supplied with a cash payment');
    return { cash: totalCents, mpesa: 0 };
  }
  if (body.paymentMethod === 'mpesa') {
    if (body.cashAmountKsh !== undefined && toCents(body.cashAmountKsh) !== 0) throw badRequest('A cash amount cannot be supplied with an M-Pesa payment');
    return { cash: 0, mpesa: totalCents };
  }
  const cash = toCents(body.cashAmountKsh, 'cashAmountKsh');
  const mpesa = toCents(body.mpesaAmountKsh, 'mpesaAmountKsh');
  if (cash <= 0 || mpesa <= 0 || cash + mpesa !== totalCents) {
    throw badRequest('Mixed payment amounts must both be positive and add up to the sale amount');
  }
  return { cash, mpesa };
}

export function salesRouter(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.post('/', async (c) => {
    const actor = c.get('auth');
    const body = await parseJsonBody(c, saleSchema);
    const shift = await getOpenShift(c.env.DB, actor.id);
    if (!shift) throw badRequest('An open shift is required before recording a sale');

    const pump = body.pumpId === undefined ? null : await first<PumpRow>(c.env.DB, `
      SELECT p.*, f.fuel_type FROM pumps p JOIN fuel_management f ON f.id = p.fuel_id
      WHERE p.id = ? AND p.is_active = 1 AND f.is_active = 1
    `, body.pumpId);
    if (body.pumpId !== undefined && !pump) throw notFound('Pump was not found');
    const fuelId = body.fuelId ?? pump?.fuel_id;
    const fuel = fuelId === undefined ? null : await first<FuelRow>(c.env.DB, 'SELECT * FROM fuel_management WHERE id = ? AND is_active = 1', fuelId);
    if (fuelId !== undefined && !fuel) throw notFound('Fuel type was not found');
    if (pump && fuel && pump.fuel_id !== fuel.id) throw badRequest('The selected pump does not belong to the selected fuel type');
    if (body.mode === 'detailed' && (!fuel || !pump)) throw badRequest('Detailed sales require an active configured fuel and pump');
    if (body.unitPriceKsh !== undefined && actor.role !== 'admin') throw forbidden('Only an administrator may override a selling price');

    const unitPrice = body.unitPriceKsh === undefined ? fuel?.selling_price_cents ?? null : positiveMoney(body.unitPriceKsh, 'unitPriceKsh');
    const litres = body.litres === undefined ? null : roundLitres(body.litres);
    let totalCents = enteredAmount(body);
    if (totalCents === null) {
      if (litres === null || unitPrice === null) throw badRequest('amountKsh is required when litres or unit price is unavailable');
      totalCents = Math.round(litres * unitPrice);
    }
    if (!Number.isSafeInteger(totalCents) || totalCents <= 0 || totalCents > MAX_MONEY_CENTS) {
      throw badRequest('Sale amount is outside the supported range');
    }
    const payment = splitPayment(body, totalCents);
    const soldAt = body.soldAt ? new Date(body.soldAt).toISOString() : new Date().toISOString();
    if (Date.parse(soldAt) < Date.parse(String(shift.opened_at))) throw badRequest('Sale timestamp cannot be before the shift opened');
    const id = randomId();
    const now = new Date().toISOString();
    const operation = operationStatement({
      db: c.env.DB,
      kind: 'sale_create',
      entityTable: 'sales',
      entityId: id,
      requestId: c.get('requestId'),
      guard: { shiftId: Number(shift.id), userId: actor.id },
      conditionSql: 'EXISTS (SELECT 1 FROM shifts WHERE id = ? AND status = \'open\')',
      conditionBindings: [shift.id],
      entityCondition: false,
    });
    const recalculate = recalculateShiftStatement(Number(shift.id), operation.id);
    const audit = auditForContext(c, {
      category: 'sale', event: body.mode === 'quick' ? 'sale.quick_created' : 'sale.detailed_created', operationId: operation.id,
      metadata: { saleId: id, shiftId: Number(shift.id), amountKsh: totalCents / 100, mode: body.mode },
    });
    await c.env.DB.batch([
      c.env.DB.prepare(operation.sql).bind(...operation.bindings),
      c.env.DB.prepare(`
        INSERT INTO sales (
          id, shift_id, user_id, fuel_id, fuel_type, litres, unit_price_cents, unit_cost_cents,
          amount_cents, amount, total_cents, cash_cents, mpesa_cents, payment_method, mode, pump_id,
          customer_name, notes, sold_at, timestamp, created_at, updated_at
        )
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM api_operations WHERE id = ?)
      `).bind(
        id, shift.id, actor.id, fuel?.id ?? null, fuel?.fuel_type ?? null, litres, unitPrice,
        fuel?.weighted_average_cost_cents ?? null, totalCents, totalCents / 100, totalCents,
        payment.cash, payment.mpesa, body.paymentMethod, body.mode, pump?.id ?? null,
        body.customerName || null, body.notes || null, soldAt, soldAt, now, now, operation.id,
      ),
      c.env.DB.prepare(recalculate.sql).bind(...recalculate.bindings),
      c.env.DB.prepare(audit.sql).bind(...audit.bindings),
    ]);
    await assertOperationCreated(c.env.DB, operation.id);
    const row = await first<DbRow>(c.env.DB, `${SALE_SELECT} WHERE sa.id = ?`, id);
    if (!row) throw notFound('Sale was not found');
    return c.json({ sale: serializeSale(row, actor.role) }, 201);
  });

  app.get('/', async (c) => {
    const actor = c.get('auth');
    const filters = parseQuery(c, salesListSchema);
    const page = pagination(filters.page, filters.pageSize);
    const where: string[] = [];
    const bindings: Array<string | number> = [];
    if (filters.from || filters.to) {
      const settings = await getSettings(c.env.DB);
      const range = getDateRange(filters.from || '0001-01-01', filters.to || '9999-12-31', settings.timezone);
      where.push('sa.sold_at >= ?', 'sa.sold_at <= ?');
      bindings.push(range.startUtc, range.endUtc);
    }
    if (actor.role !== 'admin') { where.push('sa.user_id = ?'); bindings.push(actor.id); }
    else if (filters.userId) { where.push('sa.user_id = ?'); bindings.push(filters.userId); }
    if (filters.shiftId) { where.push('sa.shift_id = ?'); bindings.push(filters.shiftId); }
    if (filters.fuelId) { where.push('sa.fuel_id = ?'); bindings.push(filters.fuelId); }
    if (filters.fuelType) { where.push('sa.fuel_type = ?'); bindings.push(filters.fuelType); }
    if (filters.pumpId) { where.push('sa.pump_id = ?'); bindings.push(filters.pumpId); }
    if (filters.mode) { where.push('sa.mode = ?'); bindings.push(filters.mode); }
    if (filters.paymentMethod) { where.push('sa.payment_method = ?'); bindings.push(filters.paymentMethod); }
    if (filters.search) {
      where.push("(CAST(sa.id AS TEXT) LIKE ? ESCAPE '\\' OR sa.customer_name LIKE ? ESCAPE '\\' OR sa.notes LIKE ? ESCAPE '\\')");
      const term = `%${escapeLike(filters.search)}%`;
      bindings.push(term, term, term);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const rows = await c.env.DB.prepare(`${SALE_SELECT} ${clause} ORDER BY sa.sold_at DESC, sa.id DESC LIMIT ? OFFSET ?`)
      .bind(...bindings, page.pageSize, page.offset).all<DbRow>();
    const count = await first<{ count: number }>(c.env.DB, `SELECT COUNT(*) AS count FROM sales sa ${clause}`, ...bindings);
    return c.json(paginated(rows.results, Number(count?.count || 0), page, (row) => serializeSale(row, actor.role)));
  });

  app.delete('/:id', async (c) => {
    if (c.get('auth').role !== 'admin') throw forbidden('Administrator access is required');
    const id = positiveId(c.req.param('id'));
    const sale = await first<DbRow>(c.env.DB, 'SELECT * FROM sales WHERE id = ?', id);
    if (!sale) throw notFound('Sale was not found');
    const operation = operationStatement({
      db: c.env.DB, kind: 'sale_delete', entityTable: 'sales', entityId: id, requestId: c.get('requestId'),
      guard: { saleId: id },
      conditionSql: 'id = ?',
      conditionBindings: [id],
    });
    const recalculate = recalculateShiftStatement(Number(sale.shift_id), operation.id);
    const audit = auditForContext(c, {
      category: 'sale', event: 'sale.deleted', operationId: operation.id,
      metadata: { saleId: id, shiftId: Number(sale.shift_id), amountKsh: Number(sale.amount_cents) / 100 },
    });
    await c.env.DB.batch([
      c.env.DB.prepare(operation.sql).bind(...operation.bindings),
      c.env.DB.prepare('DELETE FROM sales WHERE id = ? AND EXISTS (SELECT 1 FROM api_operations WHERE id = ?)').bind(id, operation.id),
      c.env.DB.prepare(recalculate.sql).bind(...recalculate.bindings),
      c.env.DB.prepare(audit.sql).bind(...audit.bindings),
    ]);
    await assertOperationCreated(c.env.DB, operation.id);
    return c.json({ deleted: true, id });
  });

  return app;
}
