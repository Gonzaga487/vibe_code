import { Hono } from 'hono';
import { auditForContext } from './audit';
import { assertOperationCreated, first, operationStatement } from './db';
import { badRequest, conflict, notFound } from './errors';
import {
  MAX_MONEY_CENTS,
  nonNegativeMoney,
  paginated,
  pagination,
  parseJsonBody,
  positiveId,
  positiveMoney,
  randomId,
  roundLitres,
} from './http';
import {
  EPSILON,
  assertCapacity,
  assertStock,
  costTotal,
  planConsumption,
  stockConsumptionStatements,
  weightedAverageStatement,
} from './inventory';
import type { LotRow } from './inventory';
import { getSettings } from './settings';
import { serializeAdjustment, serializeFuel, serializePump, serializeRestock } from './serializers';
import {
  adjustmentSchema,
  inventoryListSchema,
  fuelCreateSchema,
  fuelPatchSchema,
  parseQuery,
  pumpCreateSchema,
  pumpPatchSchema,
  restockCreateSchema,
  restockPatchSchema,
  sellingPriceSchema,
} from './validators';
import type { AppEnv, AppContext, DbRow, FuelRow, PumpRow } from './types';

export async function getFuel(db: D1Database, id: number, active = false): Promise<FuelRow> {
  const row = await first<FuelRow>(db, `SELECT * FROM fuel_management WHERE id = ?${active ? ' AND is_active = 1' : ''}`, id);
  if (!row) throw notFound('Fuel type was not found');
  return row;
}

export async function getPump(db: D1Database, id: number, active = false): Promise<PumpRow> {
  const row = await first<PumpRow>(db, `
    SELECT p.*, f.fuel_type FROM pumps p JOIN fuel_management f ON f.id = p.fuel_id
    WHERE p.id = ?${active ? ' AND p.is_active = 1 AND f.is_active = 1' : ''}
  `, id);
  if (!row) throw notFound('Pump was not found');
  return row;
}

export async function lowStockAlerts(db: D1Database): Promise<Array<Record<string, unknown>>> {
  const settings = await getSettings(db);
  const fuels = await db.prepare(`
    SELECT id, fuel_type, quantity, selling_price_cents, weighted_average_cost_cents
    FROM fuel_management WHERE is_active = 1 AND quantity <= ? ORDER BY quantity, id
  `).bind(settings.lowStockThresholdLitres).all<DbRow>();
  return fuels.results.map((row) => ({
    fuelId: Number(row.id),
    fuelType: row.fuel_type,
    quantityLitres: Number(row.quantity),
    thresholdLitres: settings.lowStockThresholdLitres,
    sellingPriceKsh: Number(row.selling_price_cents) / 100,
    weightedAverageCostKsh: Number(row.weighted_average_cost_cents) / 100,
  }));
}

function auditStatementFor(c: AppContext, event: string, metadata: unknown, operationId: string) {
  return auditForContext(c, { category: 'inventory', event, metadata, operationId });
}

export function fuelRouter(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/', async (c) => {
    const actor = c.get('auth');
    const rows = actor.role === 'admin'
      ? await c.env.DB.prepare('SELECT * FROM fuel_management ORDER BY fuel_type').all<DbRow>()
      : await c.env.DB.prepare('SELECT * FROM fuel_management WHERE is_active = 1 ORDER BY fuel_type').all<DbRow>();
    return c.json({ data: rows.results.map((row) => serializeFuel(row, actor.role)) });
  });

  app.post('/', async (c) => {
    const body = await parseJsonBody(c, fuelCreateSchema);
    const duplicate = await first(c.env.DB, 'SELECT id FROM fuel_management WHERE fuel_type = ?', body.fuelType);
    if (duplicate) throw badRequest('Fuel type already exists');
    const price = positiveMoney(body.sellingPriceKsh);
    const id = randomId();
    const now = new Date().toISOString();
    const operation = operationStatement({
      db: c.env.DB, kind: 'fuel_create', entityTable: 'fuel_management', entityId: id, requestId: c.get('requestId'),
      guard: { fuelType: body.fuelType, price },
      conditionSql: 'NOT EXISTS (SELECT 1 FROM fuel_management WHERE fuel_type = ?)',
      conditionBindings: [body.fuelType],
      entityCondition: false,
    });
    const audit = auditStatementFor(c, 'fuel.created', { fuelId: id, fuelType: body.fuelType }, operation.id);
    await c.env.DB.batch([
      c.env.DB.prepare(operation.sql).bind(...operation.bindings),
      c.env.DB.prepare(`
        INSERT INTO fuel_management
          (id, fuel_type, selling_price_cents, price_per_litre, stock_litres, tank_capacity_litres, created_by, updated_by, created_at, updated_at)
        SELECT ?, ?, ?, ?, 0, ?, ?, ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM api_operations WHERE id = ?)
      `).bind(id, body.fuelType, price, price / 100, body.tankCapacityLitres ?? null, c.get('auth').id, c.get('auth').id, now, now, operation.id),
      c.env.DB.prepare(audit.sql).bind(...audit.bindings),
    ]);
    await assertOperationCreated(c.env.DB, operation.id);
    const row = await getFuel(c.env.DB, id);
    return c.json({ fuel: serializeFuel(row, 'admin'), lowStockAlerts: await lowStockAlerts(c.env.DB) }, 201);
  });

  app.patch('/:id', async (c) => {
    const id = positiveId(c.req.param('id'));
    const body = await parseJsonBody(c, fuelPatchSchema);
    const current = await getFuel(c.env.DB, id);
    const price = body.sellingPriceKsh === undefined ? current.selling_price_cents : positiveMoney(body.sellingPriceKsh);
    const capacity = body.tankCapacityLitres === undefined ? current.tank_capacity_litres : body.tankCapacityLitres;
    if (capacity !== null && capacity < current.stock_litres) throw conflict('Tank capacity cannot be lower than current stock');
    const now = new Date().toISOString();
    const operation = operationStatement({
      db: c.env.DB, kind: 'fuel_update', entityTable: 'fuel_management', entityId: id, requestId: c.get('requestId'),
      guard: { fields: Object.keys(body) }, conditionSql: 'id = ? AND updated_at = ?', conditionBindings: [id, current.updated_at],
    });
    const audit = auditStatementFor(c, 'fuel.updated', { fuelId: id, fields: Object.keys(body) }, operation.id);
    await c.env.DB.batch([
      c.env.DB.prepare(operation.sql).bind(...operation.bindings),
      c.env.DB.prepare(`
        UPDATE fuel_management SET selling_price_cents = ?, price_per_litre = ?, tank_capacity_litres = ?,
          is_active = ?, updated_by = ?, updated_at = ?
        WHERE id = ? AND EXISTS (SELECT 1 FROM api_operations WHERE id = ?)
      `).bind(price, price / 100, capacity, body.isActive === undefined ? current.is_active : (body.isActive ? 1 : 0), c.get('auth').id, now, id, operation.id),
      c.env.DB.prepare(audit.sql).bind(...audit.bindings),
    ]);
    await assertOperationCreated(c.env.DB, operation.id);
    return c.json({ fuel: serializeFuel(await getFuel(c.env.DB, id), 'admin'), lowStockAlerts: await lowStockAlerts(c.env.DB) });
  });

  app.post('/:id/selling-price', async (c) => {
    const id = positiveId(c.req.param('id'));
    const body = await parseJsonBody(c, sellingPriceSchema);
    const current = await getFuel(c.env.DB, id);
    const price = positiveMoney(body.sellingPriceKsh);
    const operation = operationStatement({
      db: c.env.DB, kind: 'fuel_price_update', entityTable: 'fuel_management', entityId: id, requestId: c.get('requestId'),
      guard: { price }, conditionSql: 'id = ? AND updated_at = ?', conditionBindings: [id, current.updated_at],
    });
    const audit = auditStatementFor(c, 'fuel.selling_price_updated', { fuelId: id, sellingPriceKsh: price / 100 }, operation.id);
    await c.env.DB.batch([
      c.env.DB.prepare(operation.sql).bind(...operation.bindings),
      c.env.DB.prepare(`
        UPDATE fuel_management SET selling_price_cents = ?, price_per_litre = ?, updated_by = ?, updated_at = ?
        WHERE id = ? AND EXISTS (SELECT 1 FROM api_operations WHERE id = ?)
      `).bind(price, price / 100, c.get('auth').id, new Date().toISOString(), id, operation.id),
      c.env.DB.prepare(audit.sql).bind(...audit.bindings),
    ]);
    await assertOperationCreated(c.env.DB, operation.id);
    return c.json({ fuel: serializeFuel(await getFuel(c.env.DB, id), 'admin'), lowStockAlerts: await lowStockAlerts(c.env.DB) });
  });

  return app;
}

export function pumpsRouter(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.get('/', async (c) => {
    const actor = c.get('auth');
    const fuelId = c.req.query('fuelId');
    const where: string[] = [];
    const bindings: number[] = [];
    if (fuelId) {
      const parsed = positiveId(fuelId, 'fuelId');
      where.push('p.fuel_id = ?');
      bindings.push(parsed);
    }
    if (actor.role !== 'admin') where.push('p.is_active = 1');
    const rows = await c.env.DB.prepare(`
      SELECT p.*, f.fuel_type FROM pumps p JOIN fuel_management f ON f.id = p.fuel_id
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY p.pump_code
    `).bind(...bindings).all<DbRow>();
    return c.json({ data: rows.results.map(serializePump) });
  });

  app.post('/', async (c) => {
    const body = await parseJsonBody(c, pumpCreateSchema);
    const fuel = await getFuel(c.env.DB, body.fuelId, true);
    const duplicate = await first(c.env.DB, 'SELECT id FROM pumps WHERE pump_code = ? COLLATE NOCASE', body.pumpCode);
    if (duplicate) throw badRequest('Pump code already exists');
    const id = randomId();
    const now = new Date().toISOString();
    const operation = operationStatement({
      db: c.env.DB, kind: 'pump_create', entityTable: 'pumps', entityId: id, requestId: c.get('requestId'),
      guard: { fuelId: fuel.id, pumpCode: body.pumpCode },
      conditionSql: 'NOT EXISTS (SELECT 1 FROM pumps WHERE pump_code = ? COLLATE NOCASE)',
      conditionBindings: [body.pumpCode],
      entityCondition: false,
    });
    const audit = auditStatementFor(c, 'pump.created', { pumpId: id, fuelId: fuel.id, pumpCode: body.pumpCode }, operation.id);
    await c.env.DB.batch([
      c.env.DB.prepare(operation.sql).bind(...operation.bindings),
      c.env.DB.prepare(`
        INSERT INTO pumps (id, fuel_id, pump_code, created_by, created_at, updated_at)
        SELECT ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM api_operations WHERE id = ?)
      `).bind(id, fuel.id, body.pumpCode, c.get('auth').id, now, now, operation.id),
      c.env.DB.prepare(audit.sql).bind(...audit.bindings),
    ]);
    await assertOperationCreated(c.env.DB, operation.id);
    return c.json({ pump: serializePump(await getPump(c.env.DB, id)) }, 201);
  });

  app.patch('/:id', async (c) => {
    const id = positiveId(c.req.param('id'));
    const body = await parseJsonBody(c, pumpPatchSchema);
    const current = await getPump(c.env.DB, id);
    const operation = operationStatement({
      db: c.env.DB, kind: 'pump_update', entityTable: 'pumps', entityId: id, requestId: c.get('requestId'),
      guard: { isActive: body.isActive }, conditionSql: 'id = ? AND updated_at = ?', conditionBindings: [id, current.updated_at],
    });
    const audit = auditStatementFor(c, 'pump.updated', { pumpId: id, fields: Object.keys(body) }, operation.id);
    await c.env.DB.batch([
      c.env.DB.prepare(operation.sql).bind(...operation.bindings),
      c.env.DB.prepare(`
        UPDATE pumps SET is_active = ?, updated_at = ? WHERE id = ? AND EXISTS (SELECT 1 FROM api_operations WHERE id = ?)
      `).bind(body.isActive ? 1 : 0, new Date().toISOString(), id, operation.id),
      c.env.DB.prepare(audit.sql).bind(...audit.bindings),
    ]);
    await assertOperationCreated(c.env.DB, operation.id);
    return c.json({ pump: serializePump(await getPump(c.env.DB, id)) });
  });
  return app;
}

export function restockRouter(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.get('/', async (c) => {
    const query = parseQuery(c, inventoryListSchema);
    const page = pagination(query.page, query.pageSize);
    const where: string[] = [];
    const bindings: Array<string | number> = [];
    if (query.fuelId) { where.push('r.fuel_id = ?'); bindings.push(query.fuelId); }
    if (query.supplier) { where.push('r.supplier LIKE ?'); bindings.push(`%${query.supplier}%`); }
    if (query.from) { where.push('date(r.timestamp) >= ?'); bindings.push(query.from); }
    if (query.to) { where.push('date(r.timestamp) <= ?'); bindings.push(query.to); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const rows = await c.env.DB.prepare(`SELECT r.* FROM restocks r ${clause} ORDER BY r.timestamp DESC, r.id DESC LIMIT ? OFFSET ?`)
      .bind(...bindings, page.pageSize, page.offset).all<DbRow>();
    const count = await first<{ count: number }>(c.env.DB, `SELECT COUNT(*) AS count FROM restocks r ${clause}`, ...bindings);
    return c.json(paginated(rows.results, Number(count?.count || 0), page, serializeRestock));
  });

  app.get('/:id', async (c) => {
    const row = await first<DbRow>(c.env.DB, 'SELECT * FROM restocks WHERE id = ?', positiveId(c.req.param('id')));
    if (!row) throw notFound('Restock was not found');
    return c.json({ restock: serializeRestock(row) });
  });

  app.post('/', async (c) => {
    const body = await parseJsonBody(c, restockCreateSchema);
    const fuel = await getFuel(c.env.DB, body.fuelId, true);
    const quantity = roundLitres(body.quantityLitres);
    const unitCost = nonNegativeMoney(body.unitCostKsh, 'unitCostKsh');
    const totalCost = costTotal(quantity, unitCost);
    const stockAfter = roundLitres(fuel.quantity + quantity);
    assertCapacity(fuel, stockAfter);
    const id = randomId();
    const movementId = randomId();
    const lotId = randomId();
    const timestamp = new Date().toISOString();
    const operation = operationStatement({
      db: c.env.DB, kind: 'restock_create', entityTable: 'restocks', entityId: id, requestId: c.get('requestId'),
      guard: { fuelId: fuel.id, quantity, unitCost },
      conditionSql: 'EXISTS (SELECT 1 FROM fuel_management WHERE id = ? AND ABS(quantity - ?) < ? AND (tank_capacity_litres IS NULL OR ? <= tank_capacity_litres + ?))',
      conditionBindings: [fuel.id, fuel.quantity, EPSILON, stockAfter, EPSILON],
      entityCondition: false,
    });
    const average = weightedAverageStatement(fuel.id, operation.id);
    const audit = auditStatementFor(c, 'inventory.restocked', { restockId: id, fuelId: fuel.id, litresAdded: quantity }, operation.id);
    await c.env.DB.batch([
      c.env.DB.prepare(operation.sql).bind(...operation.bindings),
      c.env.DB.prepare(`
        INSERT INTO restocks
          (id, fuel_id, fuel_type, quantity, litres_added, unit_cost_cents, cost_per_litre, total_cost_cents,
           supplier, reference, notes, stock_after, created_by, updated_by, created_at, updated_at, timestamp)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM api_operations WHERE id = ?)
      `).bind(id, fuel.id, fuel.fuel_type, quantity, quantity, unitCost, unitCost / 100, totalCost, body.supplier, body.reference || null, body.notes || null, c.get('auth').id, c.get('auth').id, timestamp, timestamp, timestamp, operation.id),
      c.env.DB.prepare(`UPDATE fuel_management SET quantity = ?, stock_litres = ?, updated_at = ? WHERE id = ? AND EXISTS (SELECT 1 FROM api_operations WHERE id = ?)`).bind(stockAfter, stockAfter, timestamp, fuel.id, operation.id),
      c.env.DB.prepare(`
        INSERT INTO inventory_lots (id, fuel_id, restock_id, original_quantity, remaining_quantity, unit_cost_cents, created_at)
        SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM api_operations WHERE id = ?)
      `).bind(lotId, fuel.id, id, quantity, quantity, unitCost, timestamp, operation.id),
      c.env.DB.prepare(`
        INSERT INTO inventory_movements
          (id, fuel_id, source_type, source_id, signed_quantity, signed_cost_cents, stock_before, stock_after, created_by, created_at)
        SELECT ?, ?, 'restock', ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM api_operations WHERE id = ?)
      `).bind(movementId, fuel.id, id, quantity, totalCost, fuel.quantity, stockAfter, c.get('auth').id, timestamp, operation.id),
      c.env.DB.prepare(`UPDATE restocks SET stock_before = ?, stock_after = ? WHERE id = ? AND EXISTS (SELECT 1 FROM api_operations WHERE id = ?)`).bind(fuel.quantity, stockAfter, id, operation.id),
      c.env.DB.prepare(average.sql).bind(...average.bindings),
      c.env.DB.prepare(audit.sql).bind(...audit.bindings),
    ]);
    await assertOperationCreated(c.env.DB, operation.id);
    const row = await first<DbRow>(c.env.DB, 'SELECT * FROM restocks WHERE id = ?', id);
    return c.json({ restock: serializeRestock(row || {}), lowStockAlerts: await lowStockAlerts(c.env.DB) }, 201);
  });

  app.patch('/:id', async (c) => {
    const id = positiveId(c.req.param('id'));
    const body = await parseJsonBody(c, restockPatchSchema);
    const current = await first<DbRow>(c.env.DB, 'SELECT * FROM restocks WHERE id = ?', id);
    if (!current) throw notFound('Restock was not found');
    const nextFuelId = body.fuelId ?? Number(current.fuel_id);
    const quantity = body.quantityLitres === undefined ? Number(current.quantity) : roundLitres(body.quantityLitres);
    if (quantity <= 0) throw badRequest('quantityLitres must be greater than zero');
    const unitCost = body.unitCostKsh === undefined ? Number(current.unit_cost_cents) : nonNegativeMoney(body.unitCostKsh);
    const totalCost = costTotal(quantity, unitCost);
    const inventoryChanged = nextFuelId !== Number(current.fuel_id)
      || Math.abs(quantity - Number(current.quantity)) > EPSILON
      || unitCost !== Number(current.unit_cost_cents);
    const nextFuel = await getFuel(c.env.DB, nextFuelId, true);
    const oldFuel = await getFuel(c.env.DB, Number(current.fuel_id));
    const lot = inventoryChanged ? await first<LotRow>(c.env.DB, 'SELECT * FROM inventory_lots WHERE restock_id = ?', id) : null;
    if (inventoryChanged && (!lot || lot.remaining_quantity <= EPSILON)) throw conflict('A fully consumed restock can only have descriptive metadata corrected');
    const sameFuel = oldFuel.id === nextFuel.id;
    const oldStockAfter = inventoryChanged ? roundLitres(oldFuel.quantity - (lot?.remaining_quantity || 0)) : oldFuel.quantity;
    const nextStockBefore = inventoryChanged && sameFuel ? oldStockAfter : nextFuel.quantity;
    const nextStockAfter = inventoryChanged ? roundLitres(nextStockBefore + quantity) : nextFuel.quantity;
    if (inventoryChanged) {
      assertStock(oldFuel, lot?.remaining_quantity || 0);
      assertCapacity(nextFuel, nextStockAfter);
    }
    let condition = 'id = ? AND updated_at = ?';
    const conditionBindings: Array<string | number> = [id, String(current.updated_at)];
    if (inventoryChanged) {
      condition += ' AND EXISTS (SELECT 1 FROM fuel_management WHERE id = ? AND ABS(quantity - ?) < ?)';
      conditionBindings.push(oldFuel.id, oldFuel.quantity, EPSILON);
      if (!sameFuel) {
        condition += ' AND EXISTS (SELECT 1 FROM fuel_management WHERE id = ? AND ABS(quantity - ?) < ?)';
        conditionBindings.push(nextFuel.id, nextFuel.quantity, EPSILON);
      }
    }
    const operation = operationStatement({
      db: c.env.DB, kind: 'restock_update', entityTable: 'restocks', entityId: id, requestId: c.get('requestId'),
      guard: { fields: Object.keys(body) }, conditionSql: condition, conditionBindings,
    });
    const statements = [c.env.DB.prepare(operation.sql).bind(...operation.bindings)];
    let resultingStock = Number(current.stock_after);
    if (inventoryChanged) {
      if (!lot) throw conflict('A fully consumed restock can only have descriptive metadata corrected');
      assertStock(oldFuel, lot.remaining_quantity);
      resultingStock = nextStockAfter;
      const reversalId = randomId();
      statements.push(
        c.env.DB.prepare(`UPDATE inventory_lots SET remaining_quantity = 0, restock_id = NULL WHERE id = ? AND EXISTS (SELECT 1 FROM api_operations WHERE id = ?)`).bind(lot.id, operation.id),
        c.env.DB.prepare(`UPDATE fuel_management SET quantity = ?, stock_litres = ?, updated_at = ? WHERE id = ? AND EXISTS (SELECT 1 FROM api_operations WHERE id = ?)`).bind(oldStockAfter, oldStockAfter, new Date().toISOString(), oldFuel.id, operation.id),
        c.env.DB.prepare(`
          INSERT INTO inventory_movements
            (id, fuel_id, source_type, source_id, signed_quantity, signed_cost_cents, stock_before, stock_after, created_by, created_at, reversal_movement_id)
          SELECT ?, ?, 'restock', ?, ?, ?, ?, ?, ?, ?, NULL
          WHERE EXISTS (SELECT 1 FROM api_operations WHERE id = ?)
        `).bind(reversalId, oldFuel.id, id, -lot.remaining_quantity, -costTotal(lot.remaining_quantity, lot.unit_cost_cents), oldFuel.quantity, oldStockAfter, c.get('auth').id, new Date().toISOString(), operation.id),
        c.env.DB.prepare(`
          UPDATE inventory_movements SET reversed_at = ?, reversal_movement_id = ?
          WHERE id = (SELECT id FROM inventory_movements WHERE source_type = 'restock' AND source_id = ? AND signed_quantity > 0 AND reversed_at IS NULL ORDER BY id DESC LIMIT 1)
            AND EXISTS (SELECT 1 FROM api_operations WHERE id = ?)
        `).bind(new Date().toISOString(), reversalId, id, operation.id),
        c.env.DB.prepare(weightedAverageStatement(oldFuel.id, operation.id).sql).bind(...weightedAverageStatement(oldFuel.id, operation.id).bindings),
      );
      statements.push(c.env.DB.prepare(`UPDATE fuel_management SET quantity = ?, stock_litres = ?, updated_at = ? WHERE id = ? AND EXISTS (SELECT 1 FROM api_operations WHERE id = ?)`).bind(nextStockAfter, nextStockAfter, new Date().toISOString(), nextFuel.id, operation.id));
      statements.push(
        c.env.DB.prepare(`
          INSERT INTO inventory_lots (id, fuel_id, restock_id, original_quantity, remaining_quantity, unit_cost_cents, created_at)
          SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM api_operations WHERE id = ?)
        `).bind(randomId(), nextFuel.id, id, quantity, quantity, unitCost, new Date().toISOString(), operation.id),
        c.env.DB.prepare(`
          INSERT INTO inventory_movements
            (id, fuel_id, source_type, source_id, signed_quantity, signed_cost_cents, stock_before, stock_after, created_by, created_at)
          SELECT ?, ?, 'restock', ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM api_operations WHERE id = ?)
        `).bind(randomId(), nextFuel.id, id, quantity, totalCost, nextStockBefore, nextStockAfter, c.get('auth').id, new Date().toISOString(), operation.id),
        c.env.DB.prepare(weightedAverageStatement(nextFuel.id, operation.id).sql).bind(...weightedAverageStatement(nextFuel.id, operation.id).bindings),
      );
    }
    const audit = auditStatementFor(c, 'inventory.restock_updated', { restockId: id, fields: Object.keys(body) }, operation.id);
    statements.push(
      c.env.DB.prepare(`
        UPDATE restocks SET fuel_id = ?, fuel_type = ?, quantity = ?, litres_added = ?, unit_cost_cents = ?,
          cost_per_litre = ?, total_cost_cents = ?, supplier = ?, reference = ?, notes = ?, stock_after = ?,
          updated_by = ?, updated_at = ?
        WHERE id = ? AND EXISTS (SELECT 1 FROM api_operations WHERE id = ?)
      `).bind(nextFuel.id, nextFuel.fuel_type, quantity, quantity, unitCost, unitCost / 100, totalCost,
        body.supplier ?? current.supplier, body.reference === undefined ? current.reference : (body.reference || null),
        body.notes === undefined ? current.notes : (body.notes || null), resultingStock, c.get('auth').id,
        new Date().toISOString(), id, operation.id),
      c.env.DB.prepare(audit.sql).bind(...audit.bindings),
    );
    await c.env.DB.batch(statements);
    await assertOperationCreated(c.env.DB, operation.id);
    const row = await first<DbRow>(c.env.DB, 'SELECT * FROM restocks WHERE id = ?', id);
    return c.json({ restock: serializeRestock(row || {}), lowStockAlerts: await lowStockAlerts(c.env.DB) });
  });

  app.delete('/:id', async (c) => {
    const id = positiveId(c.req.param('id'));
    const current = await first<DbRow>(c.env.DB, 'SELECT * FROM restocks WHERE id = ?', id);
    if (!current) throw notFound('Restock was not found');
    const fuel = await getFuel(c.env.DB, Number(current.fuel_id));
    const lot = await first<LotRow>(c.env.DB, 'SELECT * FROM inventory_lots WHERE restock_id = ?', id);
    if (lot && lot.remaining_quantity > EPSILON) assertStock(fuel, lot.remaining_quantity);
    const remaining = lot?.remaining_quantity || 0;
    const stockAfter = roundLitres(fuel.quantity - remaining);
    let condition = 'id = ? AND updated_at = ? AND EXISTS (SELECT 1 FROM fuel_management WHERE id = ? AND ABS(quantity - ?) < ?)';
    const conditionBindings: Array<string | number> = [id, String(current.updated_at), fuel.id, fuel.quantity, EPSILON];
    if (lot) {
      condition += ' AND EXISTS (SELECT 1 FROM inventory_lots WHERE restock_id = ? AND ABS(remaining_quantity - ?) < ?)';
      conditionBindings.push(id, lot.remaining_quantity, EPSILON);
    } else {
      condition += ' AND NOT EXISTS (SELECT 1 FROM inventory_lots WHERE restock_id = ?)';
      conditionBindings.push(id);
    }
    const operation = operationStatement({
      db: c.env.DB, kind: 'restock_delete', entityTable: 'restocks', entityId: id, requestId: c.get('requestId'),
      guard: { restockId: id }, conditionSql: condition, conditionBindings,
    });
    const audit = auditStatementFor(c, 'inventory.restock_deleted', { restockId: id, fuelId: fuel.id, litresRemaining: remaining }, operation.id);
    const statements = [
      c.env.DB.prepare(operation.sql).bind(...operation.bindings),
      c.env.DB.prepare(`UPDATE fuel_management SET quantity = ?, stock_litres = ?, updated_at = ? WHERE id = ? AND EXISTS (SELECT 1 FROM api_operations WHERE id = ?)`).bind(stockAfter, stockAfter, new Date().toISOString(), fuel.id, operation.id),
      c.env.DB.prepare(audit.sql).bind(...audit.bindings),
    ];
    if (lot) {
      const reversalId = randomId();
      statements.push(
        c.env.DB.prepare(`UPDATE inventory_lots SET remaining_quantity = 0, restock_id = NULL WHERE id = ? AND EXISTS (SELECT 1 FROM api_operations WHERE id = ?)`).bind(lot.id, operation.id),
        c.env.DB.prepare(`
          INSERT INTO inventory_movements
            (id, fuel_id, source_type, source_id, signed_quantity, signed_cost_cents, stock_before, stock_after, created_by, created_at, reversal_movement_id)
          SELECT ?, ?, 'restock', ?, ?, ?, ?, ?, ?, ?, NULL
          WHERE EXISTS (SELECT 1 FROM api_operations WHERE id = ?)
        `).bind(reversalId, fuel.id, id, -remaining, -costTotal(remaining, lot.unit_cost_cents), fuel.quantity, stockAfter, c.get('auth').id, new Date().toISOString(), operation.id),
        c.env.DB.prepare(`
          UPDATE inventory_movements SET reversed_at = ?, reversal_movement_id = ?
          WHERE id = (SELECT id FROM inventory_movements WHERE source_type = 'restock' AND source_id = ? AND signed_quantity > 0 AND reversed_at IS NULL ORDER BY id DESC LIMIT 1)
            AND EXISTS (SELECT 1 FROM api_operations WHERE id = ?)
        `).bind(new Date().toISOString(), reversalId, id, operation.id),
        c.env.DB.prepare(weightedAverageStatement(fuel.id, operation.id).sql).bind(...weightedAverageStatement(fuel.id, operation.id).bindings),
      );
    }
    statements.push(c.env.DB.prepare(`DELETE FROM restocks WHERE id = ? AND EXISTS (SELECT 1 FROM api_operations WHERE id = ?)`).bind(id, operation.id));
    await c.env.DB.batch(statements);
    await assertOperationCreated(c.env.DB, operation.id);
    return c.json({ deleted: true, id, lowStockAlerts: await lowStockAlerts(c.env.DB) });
  });
  return app;
}

export function adjustmentsRouter(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.get('/', async (c) => {
    const query = parseQuery(c, inventoryListSchema);
    const page = pagination(query.page, query.pageSize);
    const where: string[] = [];
    const bindings: Array<string | number> = [];
    if (query.fuelId) { where.push('a.fuel_id = ?'); bindings.push(query.fuelId); }
    if (query.from) { where.push('date(a.timestamp) >= ?'); bindings.push(query.from); }
    if (query.to) { where.push('date(a.timestamp) <= ?'); bindings.push(query.to); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const rows = await c.env.DB.prepare(`SELECT a.* FROM stock_adjustments a ${clause} ORDER BY a.timestamp DESC, a.id DESC LIMIT ? OFFSET ?`).bind(...bindings, page.pageSize, page.offset).all<DbRow>();
    const count = await first<{ count: number }>(c.env.DB, `SELECT COUNT(*) AS count FROM stock_adjustments a ${clause}`, ...bindings);
    return c.json(paginated(rows.results, Number(count?.count || 0), page, serializeAdjustment));
  });

  app.post('/', async (c) => {
    const body = await parseJsonBody(c, adjustmentSchema);
    const fuel = await getFuel(c.env.DB, body.fuelId, true);
    const oldStock = roundLitres(fuel.stock_litres);
    const newStock = body.newStockLitres === undefined ? roundLitres(oldStock + (body.quantityLitres || 0)) : roundLitres(body.newStockLitres);
    const quantity = roundLitres(newStock - oldStock);
    const unitCost = body.unitCostKsh === undefined ? null : nonNegativeMoney(body.unitCostKsh, 'unitCostKsh');
    if (quantity > 0 && unitCost === null && fuel.weighted_average_cost_cents === 0) {
      throw badRequest('unitCostKsh is required for a positive adjustment when no cost basis exists');
    }
    assertCapacity(fuel, newStock);
    if (quantity < 0) assertStock(fuel, Math.abs(quantity));
    const id = randomId();
    const timestamp = new Date().toISOString();
    const operation = operationStatement({
      db: c.env.DB, kind: 'stock_adjustment_create', entityTable: 'stock_adjustments', entityId: id, requestId: c.get('requestId'),
      guard: { fuelId: fuel.id, oldStock, newStock, quantity },
      conditionSql: 'EXISTS (SELECT 1 FROM fuel_management WHERE id = ? AND ABS(quantity - ?) < ?)',
      conditionBindings: [fuel.id, oldStock, EPSILON],
      entityCondition: false,
    });
    const statements = [
      c.env.DB.prepare(operation.sql).bind(...operation.bindings),
      c.env.DB.prepare(`
        INSERT INTO stock_adjustments
          (id, fuel_id, fuel_type, quantity, reason, notes, unit_cost_cents, previous_quantity,
           new_quantity, old_stock, new_stock, created_by, created_at, timestamp)
        SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM api_operations WHERE id = ?)
      `).bind(id, fuel.id, fuel.fuel_type, quantity, body.reason, body.notes || null, unitCost,
        oldStock, newStock, oldStock, newStock, c.get('auth').id, timestamp, timestamp, operation.id),
    ];
    if (quantity > 0) {
      const cost = unitCost ?? fuel.weighted_average_cost_cents;
      statements.push(
        c.env.DB.prepare(`UPDATE fuel_management SET quantity = ?, stock_litres = ?, updated_at = ? WHERE id = ? AND EXISTS (SELECT 1 FROM api_operations WHERE id = ?)`).bind(newStock, newStock, timestamp, fuel.id, operation.id),
        c.env.DB.prepare(`INSERT INTO inventory_lots (id, fuel_id, adjustment_id, original_quantity, remaining_quantity, unit_cost_cents, created_at) SELECT ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM api_operations WHERE id = ?)`).bind(randomId(), fuel.id, id, quantity, quantity, cost, timestamp, operation.id),
        c.env.DB.prepare(`INSERT INTO inventory_movements (id, fuel_id, source_type, source_id, signed_quantity, signed_cost_cents, stock_before, stock_after, created_by, created_at) SELECT ?, ?, 'stock_adjustment', ?, ?, ?, ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM api_operations WHERE id = ?)`).bind(randomId(), fuel.id, id, quantity, costTotal(quantity, cost), oldStock, newStock, c.get('auth').id, timestamp, operation.id),
        c.env.DB.prepare(weightedAverageStatement(fuel.id, operation.id).sql).bind(...weightedAverageStatement(fuel.id, operation.id).bindings),
      );
    } else if (quantity < 0) {
      const list = await c.env.DB.prepare('SELECT * FROM inventory_lots WHERE fuel_id = ? AND remaining_quantity > 0 ORDER BY id').bind(fuel.id).all<LotRow>();
      const plan = planConsumption(fuel, Math.abs(quantity), list.results, randomId());
      const balances = list.results.map((lot) => ({
        lotId: lot.id,
        remainingAfter: roundLitres(lot.remaining_quantity - (plan.allocations.find((item) => item.lotId === lot.id)?.quantity || 0)),
      }));
      statements.push(...stockConsumptionStatements({
        operationId: operation.id, fuelId: fuel.id, quantity: Math.abs(quantity),
        sourceType: 'stock_adjustment', sourceId: id, actorId: c.get('auth').id, plan, lotBalances: balances,
      }).map((statement) => c.env.DB.prepare(statement.sql).bind(...statement.bindings)));
    }
    const audit = auditStatementFor(c, 'inventory.stock_adjusted', { adjustmentId: id, fuelId: fuel.id, oldStock, newStock, reason: body.reason }, operation.id);
    statements.push(c.env.DB.prepare(audit.sql).bind(...audit.bindings));
    await c.env.DB.batch(statements);
    await assertOperationCreated(c.env.DB, operation.id);
    const row = await first<DbRow>(c.env.DB, 'SELECT * FROM stock_adjustments WHERE id = ?', id);
    return c.json({ adjustment: serializeAdjustment(row || {}), lowStockAlerts: await lowStockAlerts(c.env.DB) }, 201);
  });
  return app;
}
