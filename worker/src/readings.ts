import { Hono } from 'hono';
import { auditForContext } from './audit';
import { todayInTimezone } from './date';
import { assertOperationCreated, first, operationStatement } from './db';
import { badRequest, conflict, forbidden, notFound } from './errors';
import { paginated, pagination, parseJsonBody, positiveId, randomId, roundKsh, roundLitres } from './http';
import { assertCapacity, EPSILON, planConsumption, stockConsumptionStatements, weightedAverageStatement } from './inventory';
import type { LotRow } from './inventory';
import { getSettings } from './settings';
import { serializeReading } from './serializers';
import { getFuel, lowStockAlerts } from './fuel';
import { parseQuery, readingBackdateSchema, readingCreateSchema, readingPatchSchema, readingsListSchema } from './validators';
import type { AppEnv, AppContext, DbRow, FuelRow } from './types';
import type { z } from 'zod';

type ReadingKind = 'pump' | 'sales';
type ReadingInput = z.infer<typeof readingCreateSchema>;
interface AllocationRow extends DbRow { id: number; lot_id: number; quantity: number; unit_cost_cents: number }

function readingSelect(table: string): string {
  return `
    SELECT r.*, u.username, u.full_name, COALESCE(r.fuel_type, f.fuel_type) AS fuel_type
    FROM ${table} r JOIN users u ON u.id = r.user_id JOIN fuel_management f ON f.id = r.fuel_id
  `;
}

async function resolveFuel(db: D1Database, body: Partial<ReadingInput>, current: DbRow | null): Promise<FuelRow> {
  if (body.fuelType && body.fuelId !== undefined) {
    const fuel = await getFuel(db, body.fuelId, true);
    if (fuel.fuel_type !== body.fuelType) throw badRequest('fuelType does not match fuelId');
    return fuel;
  }
  if (body.fuelType) {
    const fuel = await first<FuelRow>(db, 'SELECT * FROM fuel_management WHERE fuel_type = ? AND is_active = 1', body.fuelType);
    if (!fuel) throw notFound('Fuel type was not found');
    return fuel;
  }
  if (body.fuelId !== undefined) return getFuel(db, body.fuelId, true);
  if (current) return getFuel(db, Number(current.fuel_id), true);
  throw badRequest('A fuel type is required');
}

async function prepareReading(
  db: D1Database,
  table: string,
  kind: ReadingKind,
  body: Partial<ReadingInput>,
  current: DbRow | null,
): Promise<{
  fuel: FuelRow;
  date: string;
  opening: number;
  closing: number;
  previous: number;
  consumption: number;
  meterReference: string;
  notes: string | null;
}> {
  const fuel = await resolveFuel(db, body, current);
  const date = body.date || body.readingDate || String(current?.date || current?.reading_date || '');
  if (!date) throw badRequest('A reading date is required');
  const settings = await getSettings(db);
  if (date > todayInTimezone(settings.timezone)) throw badRequest('reading date cannot be in the future');
  const isPump = kind === 'pump';
  const openingInput = isPump
    ? (body.openingLitres ?? body.openingReading ?? current?.opening_litres)
    : body.openingKsh;
  const closingInput = isPump
    ? (body.closingLitres ?? body.closingReading ?? current?.closing_litres)
    : (body.closingKsh ?? body.closingReading ?? current?.closing_ksh);
  const previousInput = isPump
    ? (body.prevClosingLitres ?? body.previousClosing ?? current?.prev_closing_litres)
    : (body.prevClosingKsh ?? body.previousClosing ?? current?.prev_closing_ksh);
  if (openingInput === undefined || openingInput === null) throw badRequest(isPump ? 'openingLitres is required' : 'openingKsh is required');
  if (closingInput === undefined || closingInput === null) throw badRequest(isPump ? 'closingLitres is required' : 'closingKsh is required');
  let previous = previousInput;
  if (previous === undefined || previous === null) {
    const prior = current
      ? await first<DbRow>(db, `SELECT closing_reading FROM ${table} WHERE fuel_id = ? AND reading_date < ? AND id != ? ORDER BY reading_date DESC, id DESC LIMIT 1`, fuel.id, date, current.id)
      : await first<DbRow>(db, `SELECT closing_reading FROM ${table} WHERE fuel_id = ? AND reading_date < ? ORDER BY reading_date DESC, id DESC LIMIT 1`, fuel.id, date);
    previous = prior?.closing_reading;
  }
  if (previous === undefined || previous === null) throw badRequest(isPump ? 'prevClosingLitres is required' : 'prevClosingKsh is required');
  const round = isPump ? roundLitres : roundKsh;
  const opening = round(Number(openingInput));
  const closing = round(Number(closingInput));
  previous = round(Number(previous));
  if (closing < previous) throw badRequest(isPump ? 'closingLitres cannot be lower than prevClosingLitres' : 'closingKsh cannot be lower than prevClosingKsh');
  return {
    fuel,
    date,
    opening,
    closing,
    previous,
    consumption: round(closing - previous),
    meterReference: body.meterReference || String(current?.meter_reference || `${fuel.fuel_type} METER`),
    notes: body.notes === undefined ? (current?.notes === undefined || current?.notes === null ? null : String(current.notes)) : (body.notes || null),
  };
}

function readingInsertSql(table: string, kind: ReadingKind) {
  return `
    INSERT INTO ${table} (
      id, fuel_id, user_id, reading_date, previous_closing, closing_reading, consumption,
      reconciliation_price_cents, meter_reference, notes, "date", fuel_type,
      opening_litres, closing_litres, prev_closing_litres, opening_ksh, closing_ksh, prev_closing_ksh,
      reconciliation_value_cents, stock_before, stock_after, created_at, updated_at
    )
    SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
    WHERE EXISTS (SELECT 1 FROM api_operations WHERE id = ?)
  `;
}

function readingInsertBindings(options: {
  id: number;
  actorId: number;
  prepared: Awaited<ReturnType<typeof prepareReading>>;
  kind: ReadingKind;
  stockBefore: number | null;
  stockAfter: number | null;
  operationId: string;
}): Array<string | number | null> {
  const p = options.prepared;
  const reconciliation = options.kind === 'pump'
    ? Math.round(p.consumption * p.fuel.selling_price_cents)
    : Math.round(p.consumption * 100);
  const pump = options.kind === 'pump';
  return [
    options.id, p.fuel.id, options.actorId, p.date, p.previous, p.closing, p.consumption,
    p.fuel.selling_price_cents, p.meterReference, p.notes, p.date, p.fuel.fuel_type,
    pump ? p.opening : 0, pump ? p.closing : 0, pump ? p.previous : 0,
    pump ? 0 : p.opening, pump ? 0 : p.closing, pump ? 0 : p.previous,
    reconciliation, options.stockBefore, options.stockAfter, new Date().toISOString(), new Date().toISOString(), options.operationId,
  ];
}

async function scopedReading(db: D1Database, table: string, id: number, userId: number, role: string): Promise<DbRow> {
  const row = await first(db, `${readingSelect(table)} WHERE r.id = ?`, id);
  if (!row) throw notFound('Reading was not found');
  if (role !== 'admin' && Number(row.user_id) !== userId) throw forbidden('You can only access your own meter readings');
  return row;
}

function reverseConsumptionStatements(options: {
  db: D1Database;
  original: DbRow;
  allocations: AllocationRow[];
  actorId: number;
  sourceType: 'pump_reading';
  sourceId: number;
  operationId: string;
  currentStockBefore: number;
}) {
  const originalFuelId = Number(options.original.fuel_id);
  const stockBefore = options.currentStockBefore;
  const stockAfter = roundLitres(stockBefore + Math.abs(Number(options.original.signed_quantity)));
  const reversalId = randomId();
  const now = new Date().toISOString();
  const statements = [
    options.db.prepare(`UPDATE fuel_management SET quantity = ?, stock_litres = ?, updated_at = ? WHERE id = ? AND EXISTS (SELECT 1 FROM api_operations WHERE id = ?)`).bind(stockAfter, stockAfter, now, originalFuelId, options.operationId),
  ];
  for (const allocation of options.allocations) {
    statements.push(options.db.prepare(`UPDATE inventory_lots SET remaining_quantity = remaining_quantity + ? WHERE id = ? AND remaining_quantity + ? <= original_quantity AND EXISTS (SELECT 1 FROM api_operations WHERE id = ?)`).bind(Number(allocation.quantity), Number(allocation.lot_id), Number(allocation.quantity), options.operationId));
  }
  statements.push(
    options.db.prepare(`
      INSERT INTO inventory_movements
        (id, fuel_id, source_type, source_id, signed_quantity, signed_cost_cents, stock_before, stock_after, created_by, created_at, reversal_movement_id)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM api_operations WHERE id = ?)
    `).bind(reversalId, originalFuelId, options.sourceType, options.sourceId, Math.abs(Number(options.original.signed_quantity)), Math.abs(Number(options.original.signed_cost_cents)), stockBefore, stockAfter, options.actorId, now, options.original.id, options.operationId),
    options.db.prepare(`UPDATE inventory_movements SET reversed_at = ?, reversal_movement_id = ? WHERE id = ? AND reversed_at IS NULL AND EXISTS (SELECT 1 FROM api_operations WHERE id = ?)`).bind(now, reversalId, options.original.id, options.operationId),
    options.db.prepare(weightedAverageStatement(originalFuelId, options.operationId).sql).bind(...weightedAverageStatement(originalFuelId, options.operationId).bindings),
  );
  return { statements, stockAfter };
}

export function readingsRouter(kind: ReadingKind): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const table = kind === 'pump' ? 'pump_readings' : 'sales_readings';
  const sourceType = 'pump_reading' as const;

  app.get('/', async (c) => {
    const actor = c.get('auth');
    const filters = parseQuery(c, readingsListSchema);
    const page = pagination(filters.page, filters.pageSize);
    const where: string[] = [];
    const bindings: Array<string | number> = [];
    if (actor.role !== 'admin') { where.push('r.user_id = ?'); bindings.push(actor.id); }
    else if (filters.userId) { where.push('r.user_id = ?'); bindings.push(filters.userId); }
    if (filters.fuelId) { where.push('r.fuel_id = ?'); bindings.push(filters.fuelId); }
    if (filters.from) { where.push('r."date" >= ?'); bindings.push(filters.from); }
    if (filters.to) { where.push('r."date" <= ?'); bindings.push(filters.to); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const rows = await c.env.DB.prepare(`${readingSelect(table)} ${clause} ORDER BY r.date DESC, r.id DESC LIMIT ? OFFSET ?`).bind(...bindings, page.pageSize, page.offset).all<DbRow>();
    const count = await first<{ count: number }>(c.env.DB, `SELECT COUNT(*) AS count FROM ${table} r ${clause}`, ...bindings);
    return c.json(paginated(rows.results, Number(count?.count || 0), page, (row) => serializeReading(row, actor.role, kind)));
  });

  app.post('/', async (c) => {
    const actor = c.get('auth');
    const body = await parseJsonBody(c, readingCreateSchema);
    const prepared = await prepareReading(c.env.DB, table, kind, body, null);
    const id = randomId();
    let plan: ReturnType<typeof planConsumption> | null = null;
    let balances: Array<{ lotId: number; remainingAfter: number }> = [];
    let lots: LotRow[] = [];
    if (kind === 'pump' && prepared.consumption > 0) {
      lots = (await c.env.DB.prepare('SELECT * FROM inventory_lots WHERE fuel_id = ? AND remaining_quantity > 0 ORDER BY id').bind(prepared.fuel.id).all<LotRow>()).results;
      plan = planConsumption(prepared.fuel, prepared.consumption, lots, randomId());
      balances = lots.map((lot) => ({
        lotId: lot.id,
        remainingAfter: roundLitres(lot.remaining_quantity - (plan?.allocations.find((item) => item.lotId === lot.id)?.quantity || 0)),
      }));
    }
    const condition = kind === 'pump' && prepared.consumption > 0
      ? 'NOT EXISTS (SELECT 1 FROM pump_readings WHERE reading_date = ? AND fuel_id = ?) AND EXISTS (SELECT 1 FROM fuel_management WHERE id = ? AND is_active = 1 AND ABS(quantity - ?) < ? AND quantity + ? >= 0)'
      : `NOT EXISTS (SELECT 1 FROM ${table} WHERE reading_date = ? AND fuel_id = ?) AND EXISTS (SELECT 1 FROM fuel_management WHERE id = ? AND is_active = 1)`;
    const conditionBindings: Array<string | number> = kind === 'pump' && prepared.consumption > 0
      ? [prepared.date, prepared.fuel.id, prepared.fuel.id, prepared.fuel.quantity, EPSILON, prepared.consumption]
      : [prepared.date, prepared.fuel.id, prepared.fuel.id];
    const operation = operationStatement({
      db: c.env.DB, kind: `${kind}_reading_create`, entityTable: table, entityId: id, requestId: c.get('requestId'),
      guard: { fuelId: prepared.fuel.id, date: prepared.date, consumption: prepared.consumption },
      conditionSql: condition,
      conditionBindings,
      entityCondition: false,
    });
    const audit = auditForContext(c, {
      category: 'reading', event: kind === 'pump' ? 'reading.pump_created' : 'reading.sales_meter_created', operationId: operation.id,
      metadata: { readingId: id, fuelId: prepared.fuel.id, date: prepared.date, consumption: prepared.consumption },
    });
    const statements = [
      c.env.DB.prepare(operation.sql).bind(...operation.bindings),
      c.env.DB.prepare(readingInsertSql(table, kind)).bind(...readingInsertBindings({
        id, actorId: actor.id, prepared, kind,
        stockBefore: kind === 'pump' && prepared.consumption > 0 ? plan?.stockBefore ?? null : null,
        stockAfter: kind === 'pump' && prepared.consumption > 0 ? plan?.stockAfter ?? null : null,
        operationId: operation.id,
      })),
    ];
    if (kind === 'pump' && prepared.consumption > 0 && plan) {
      statements.push(...stockConsumptionStatements({
        operationId: operation.id, fuelId: prepared.fuel.id, quantity: prepared.consumption,
        sourceType, sourceId: id, actorId: actor.id, plan, lotBalances: balances,
      }).map((statement) => c.env.DB.prepare(statement.sql).bind(...statement.bindings)));
    }
    statements.push(c.env.DB.prepare(audit.sql).bind(...audit.bindings));
    await c.env.DB.batch(statements);
    await assertOperationCreated(c.env.DB, operation.id);
    const row = await first<DbRow>(c.env.DB, `${readingSelect(table)} WHERE r.id = ?`, id);
    if (!row) throw notFound('Reading was not found');
    return c.json({ reading: serializeReading(row, actor.role, kind), lowStockAlerts: actor.role === 'admin' ? await lowStockAlerts(c.env.DB) : [] }, 201);
  });

  const update = async (c: AppContext) => {
    const actor = c.get('auth');
    const id = positiveId(c.req.param('id'));
    const isBackdate = new URL(c.req.url).pathname.endsWith('/backdate');
    const body = await parseJsonBody(c, isBackdate ? readingBackdateSchema : readingPatchSchema);
    const current = await scopedReading(c.env.DB, table, id, actor.id, actor.role);
    const currentFuel = kind === 'pump' ? await getFuel(c.env.DB, Number(current.fuel_id)) : null;
    const currentStockBefore = currentFuel?.quantity ?? 0;
    const prepared = await prepareReading(c.env.DB, table, kind, body, current);
    const currentOpening = kind === 'pump' ? Number(current.opening_litres) : Number(current.opening_ksh);
    const currentClosing = kind === 'pump' ? Number(current.closing_litres) : Number(current.closing_ksh);
    const currentPrevious = kind === 'pump' ? Number(current.prev_closing_litres) : Number(current.prev_closing_ksh);
    const measurementChanged = prepared.fuel.id !== Number(current.fuel_id) || prepared.date !== current.date
      || prepared.opening !== currentOpening || prepared.closing !== currentClosing || prepared.previous !== currentPrevious;
    const original = kind === 'pump' ? await first<DbRow>(c.env.DB, `SELECT * FROM inventory_movements WHERE source_type = 'pump_reading' AND source_id = ? AND signed_quantity < 0 AND reversed_at IS NULL ORDER BY id DESC LIMIT 1`, id) : null;
    if (kind === 'pump' && measurementChanged && Number(current.consumption) > 0 && !original) {
      throw conflict('The original pump inventory movement is missing; reconcile stock before editing this reading');
    }
    const allocations = original
      ? (await c.env.DB.prepare('SELECT * FROM inventory_allocations WHERE movement_id = ?').bind(original.id).all<AllocationRow>()).results
      : [];
    if (original && currentFuel) assertCapacity(currentFuel, roundLitres(currentStockBefore + Math.abs(Number(original.signed_quantity))));
    if (original && allocations.length === 0) throw conflict('The original pump inventory allocation is missing; reconcile stock before editing this reading');
    const allocationStates = original ? await Promise.all(allocations.map(async (allocation) => {
      const lot = await first<DbRow>(c.env.DB, 'SELECT remaining_quantity FROM inventory_lots WHERE id = ?', allocation.lot_id);
      return { lotId: allocation.lot_id, remaining: lot?.remaining_quantity === null || lot?.remaining_quantity === undefined ? null : Number(lot.remaining_quantity) };
    })) : [];
    let plan: ReturnType<typeof planConsumption> | null = null;
    let balances: Array<{ lotId: number; remainingAfter: number }> = [];
    if (kind === 'pump' && measurementChanged && prepared.consumption > 0) {
      const lots = (await c.env.DB.prepare('SELECT * FROM inventory_lots WHERE fuel_id = ? AND remaining_quantity > 0 ORDER BY id').bind(prepared.fuel.id).all<LotRow>()).results;
      const sameFuelAsOriginal = Boolean(original && prepared.fuel.id === Number(original.fuel_id));
      const startingQuantity = prepared.fuel.id === Number(current.fuel_id)
        ? currentStockBefore + (sameFuelAsOriginal ? Math.abs(Number(original?.signed_quantity)) : 0)
        : prepared.fuel.quantity;
      const startingFuel = { ...prepared.fuel, quantity: startingQuantity };
      plan = planConsumption(startingFuel, prepared.consumption, lots, randomId());
      balances = lots.map((lot) => {
        const restored = sameFuelAsOriginal ? (allocations.find((item) => item.lot_id === lot.id)?.quantity || 0) : 0;
        const consumed = plan?.allocations.find((item) => item.lotId === lot.id)?.quantity || 0;
        return { lotId: lot.id, remainingAfter: roundLitres(lot.remaining_quantity + restored - consumed) };
      });
    }
    let condition = 'id = ? AND updated_at = ?';
    const conditionBindings: Array<string | number> = [id, String(current.updated_at)];
    if (measurementChanged && currentFuel) {
      condition += ' AND EXISTS (SELECT 1 FROM fuel_management WHERE id = ? AND ABS(quantity - ?) < ?)';
      conditionBindings.push(currentFuel.id, currentStockBefore, EPSILON);
      if (prepared.fuel.id !== currentFuel.id) {
        condition += ' AND EXISTS (SELECT 1 FROM fuel_management WHERE id = ? AND ABS(quantity - ?) < ?)';
        conditionBindings.push(prepared.fuel.id, prepared.fuel.quantity, EPSILON);
      }
      for (const state of allocationStates) {
        if (state.remaining === null) {
          condition += ' AND NOT EXISTS (SELECT 1 FROM inventory_lots WHERE id = ?)';
          conditionBindings.push(state.lotId);
        } else {
          condition += ' AND EXISTS (SELECT 1 FROM inventory_lots WHERE id = ? AND ABS(remaining_quantity - ?) < ?)';
          conditionBindings.push(state.lotId, state.remaining, EPSILON);
        }
      }
    }
    const operation = operationStatement({
      db: c.env.DB, kind: `${kind}_reading_update`, entityTable: table, entityId: id, requestId: c.get('requestId'),
      guard: { fields: Object.keys(body), measurementChanged }, conditionSql: condition, conditionBindings,
    });
    const reconciliation = kind === 'pump' ? Math.round(prepared.consumption * prepared.fuel.selling_price_cents) : Math.round(prepared.consumption * 100);
    const audit = auditForContext(c, {
      category: 'reading', event: kind === 'pump' ? 'reading.pump_updated' : 'reading.sales_meter_updated', operationId: operation.id,
      metadata: { readingId: id, fields: Object.keys(body), consumption: prepared.consumption },
    });
    const statements = [c.env.DB.prepare(operation.sql).bind(...operation.bindings)];
    let stockAfterForReading: number | null = measurementChanged ? null : (current.stock_after === null ? null : Number(current.stock_after));
    if (kind === 'pump' && measurementChanged && original) {
      const reversed = reverseConsumptionStatements({
        db: c.env.DB, original, allocations, actorId: actor.id, sourceType, sourceId: id, operationId: operation.id,
        currentStockBefore,
      });
      statements.push(...reversed.statements);
      stockAfterForReading = reversed.stockAfter;
    }
    statements.push(c.env.DB.prepare(`
      UPDATE ${table} SET fuel_id = ?, reading_date = ?, previous_closing = ?, closing_reading = ?, consumption = ?,
        reconciliation_price_cents = ?, meter_reference = ?, notes = ?, stock_before = ?, stock_after = ?,
        "date" = ?, fuel_type = ?, opening_litres = ?, closing_litres = ?, prev_closing_litres = ?,
        opening_ksh = ?, closing_ksh = ?, prev_closing_ksh = ?, reconciliation_value_cents = ?, updated_at = ?
      WHERE id = ? AND EXISTS (SELECT 1 FROM api_operations WHERE id = ?)
    `).bind(
      prepared.fuel.id, prepared.date, prepared.previous, prepared.closing, prepared.consumption,
      prepared.fuel.selling_price_cents, prepared.meterReference, prepared.notes,
      kind === 'pump' && measurementChanged ? (plan?.stockBefore ?? (original ? currentStockBefore : null)) : current.stock_before,
      kind === 'pump' && measurementChanged ? plan?.stockAfter ?? stockAfterForReading : current.stock_after,
      prepared.date, prepared.fuel.fuel_type,
      kind === 'pump' ? prepared.opening : 0, kind === 'pump' ? prepared.closing : 0, kind === 'pump' ? prepared.previous : 0,
      kind === 'pump' ? 0 : prepared.opening, kind === 'pump' ? 0 : prepared.closing, kind === 'pump' ? 0 : prepared.previous,
      reconciliation, new Date().toISOString(), id, operation.id,
    ));
    if (kind === 'pump' && measurementChanged && prepared.consumption > 0 && plan) {
      const consumption = stockConsumptionStatements({
        operationId: operation.id, fuelId: prepared.fuel.id, quantity: prepared.consumption,
        sourceType, sourceId: id, actorId: actor.id, plan, lotBalances: balances,
      });
      statements.push(...consumption.map((statement) => c.env.DB.prepare(statement.sql).bind(...statement.bindings)));
      stockAfterForReading = plan.stockAfter;
      // Keep the reading's persisted stock impact synchronized with the final movement.
      statements.push(c.env.DB.prepare(`UPDATE pump_readings SET stock_before = ?, stock_after = ? WHERE id = ? AND EXISTS (SELECT 1 FROM api_operations WHERE id = ?)`).bind(plan.stockBefore, plan.stockAfter, id, operation.id));
    }
    statements.push(c.env.DB.prepare(audit.sql).bind(...audit.bindings));
    await c.env.DB.batch(statements);
    await assertOperationCreated(c.env.DB, operation.id);
    const row = await first<DbRow>(c.env.DB, `${readingSelect(table)} WHERE r.id = ?`, id);
    if (!row) throw notFound('Reading was not found');
    return c.json({ reading: serializeReading(row, actor.role, kind), lowStockAlerts: actor.role === 'admin' ? await lowStockAlerts(c.env.DB) : [] });
  };

  app.patch('/:id', update);
  app.post('/:id/backdate', update);

  app.delete('/:id', async (c) => {
    const actor = c.get('auth');
    const id = positiveId(c.req.param('id'));
    const current = await scopedReading(c.env.DB, table, id, actor.id, actor.role);
    const currentFuel = kind === 'pump' ? await getFuel(c.env.DB, Number(current.fuel_id)) : null;
    const currentStockBefore = currentFuel?.quantity ?? 0;
    const original = kind === 'pump'
      ? await first<DbRow>(c.env.DB, `SELECT * FROM inventory_movements WHERE source_type = 'pump_reading' AND source_id = ? AND signed_quantity < 0 AND reversed_at IS NULL ORDER BY id DESC LIMIT 1`, id)
      : null;
    if (kind === 'pump' && Number(current.consumption) > 0 && !original) throw conflict('The original pump inventory movement is missing; reconcile stock before deleting this reading');
    const allocations = original ? (await c.env.DB.prepare('SELECT * FROM inventory_allocations WHERE movement_id = ?').bind(original.id).all<AllocationRow>()).results : [];
    if (original && currentFuel) assertCapacity(currentFuel, roundLitres(currentStockBefore + Math.abs(Number(original.signed_quantity))));
    if (original && allocations.length === 0) throw conflict('The original pump inventory allocation is missing; reconcile stock before deleting this reading');
    const allocationStates = original ? await Promise.all(allocations.map(async (allocation) => {
      const lot = await first<DbRow>(c.env.DB, 'SELECT remaining_quantity FROM inventory_lots WHERE id = ?', allocation.lot_id);
      return { lotId: allocation.lot_id, remaining: lot?.remaining_quantity === null || lot?.remaining_quantity === undefined ? null : Number(lot.remaining_quantity) };
    })) : [];
    let condition = 'id = ? AND updated_at = ?';
    const conditionBindings: Array<string | number> = [id, String(current.updated_at)];
    if (currentFuel) {
      condition += ' AND EXISTS (SELECT 1 FROM fuel_management WHERE id = ? AND ABS(quantity - ?) < ?)';
      conditionBindings.push(currentFuel.id, currentStockBefore, EPSILON);
      for (const state of allocationStates) {
        if (state.remaining === null) {
          condition += ' AND NOT EXISTS (SELECT 1 FROM inventory_lots WHERE id = ?)';
          conditionBindings.push(state.lotId);
        } else {
          condition += ' AND EXISTS (SELECT 1 FROM inventory_lots WHERE id = ? AND ABS(remaining_quantity - ?) < ?)';
          conditionBindings.push(state.lotId, state.remaining, EPSILON);
        }
      }
    }
    const operation = operationStatement({
      db: c.env.DB, kind: `${kind}_reading_delete`, entityTable: table, entityId: id, requestId: c.get('requestId'),
      guard: { readingId: id }, conditionSql: condition, conditionBindings,
    });
    const audit = auditForContext(c, {
      category: 'reading', event: kind === 'pump' ? 'reading.pump_deleted' : 'reading.sales_meter_deleted', operationId: operation.id,
      metadata: { readingId: id, fuelId: Number(current.fuel_id), date: current.date },
    });
    const statements = [c.env.DB.prepare(operation.sql).bind(...operation.bindings)];
    if (kind === 'pump' && original) {
      statements.push(...reverseConsumptionStatements({
        db: c.env.DB, original, allocations, actorId: actor.id, sourceType, sourceId: id, operationId: operation.id,
        currentStockBefore,
      }).statements);
    }
    statements.push(
      c.env.DB.prepare(`DELETE FROM ${table} WHERE id = ? AND EXISTS (SELECT 1 FROM api_operations WHERE id = ?)`).bind(id, operation.id),
      c.env.DB.prepare(audit.sql).bind(...audit.bindings),
    );
    await c.env.DB.batch(statements);
    await assertOperationCreated(c.env.DB, operation.id);
    return c.json({ deleted: true, id, lowStockAlerts: actor.role === 'admin' ? await lowStockAlerts(c.env.DB) : [] });
  });
  return app;
}
