import { conflict, notFound } from '../lib/errors.js';
import { MAX_MONEY_CENTS, roundLitres } from '../lib/http.js';
import { getSettings } from './settings.js';

const EPSILON = 0.0005;

function updateWeightedCost(db, fuelId) {
  const value = db.prepare(`
    SELECT COALESCE(SUM(remaining_quantity * unit_cost_cents), 0) AS value,
           COALESCE(SUM(remaining_quantity), 0) AS quantity
    FROM inventory_lots
    WHERE fuel_id = ? AND remaining_quantity > 0
  `).get(fuelId);
  const average = value.quantity > EPSILON ? Math.round(value.value / value.quantity) : 0;
  db.prepare(`
    UPDATE fuel_management
    SET weighted_average_cost_cents = ?, stock_litres = quantity,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ?
  `).run(average, fuelId);
}

function assertStock(row, needed) {
  if (row.quantity + EPSILON < needed) {
    throw conflict(`Insufficient stock for ${row.fuel_type}`);
  }
}

function assertCapacity(row, resultingQuantity) {
  if (row.tank_capacity_litres !== null && resultingQuantity > row.tank_capacity_litres + EPSILON) {
    throw conflict(`Stock change exceeds the configured capacity for ${row.fuel_type}`);
  }
}

function costTotal(quantity, unitCostCents) {
  const total = Math.round(quantity * unitCostCents);
  if (!Number.isSafeInteger(total) || total > MAX_MONEY_CENTS) throw conflict('Inventory cost total is outside the supported range');
  return total;
}

export function getFuelOrThrow(db, fuelId, { active = false } = {}) {
  const row = db.prepare(`SELECT * FROM fuel_management WHERE id = ?${active ? ' AND is_active = 1' : ''}`).get(fuelId);
  if (!row) throw notFound('Fuel type was not found');
  return row;
}

export function getPumpOrThrow(db, pumpId, { active = false } = {}) {
  const row = db.prepare(`SELECT p.*, f.fuel_type FROM pumps p JOIN fuel_management f ON f.id = p.fuel_id WHERE p.id = ?${active ? ' AND p.is_active = 1 AND f.is_active = 1' : ''}`).get(pumpId);
  if (!row) throw notFound('Pump was not found');
  return row;
}

export function addRestockInventory(db, restock, actorId) {
  const fuel = getFuelOrThrow(db, restock.fuel_id, { active: true });
  const stockBefore = fuel.quantity;
  const stockAfter = roundLitres(stockBefore + restock.quantity);
  assertCapacity(fuel, stockAfter);
  db.prepare(`
    INSERT INTO inventory_lots
      (fuel_id, restock_id, original_quantity, remaining_quantity, unit_cost_cents)
    VALUES (?, ?, ?, ?, ?)
  `).run(restock.fuel_id, restock.id, restock.quantity, restock.quantity, restock.unit_cost_cents);
  db.prepare(`
    UPDATE fuel_management
    SET quantity = ?, stock_litres = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ?
  `).run(stockAfter, stockAfter, restock.fuel_id);
  db.prepare(`
    INSERT INTO inventory_movements
      (fuel_id, source_type, source_id, signed_quantity, signed_cost_cents, stock_before, stock_after, created_by)
    VALUES (?, 'restock', ?, ?, ?, ?, ?, ?)
  `).run(
    restock.fuel_id,
    restock.id,
    restock.quantity,
    costTotal(restock.quantity, restock.unit_cost_cents),
    stockBefore,
    stockAfter,
    actorId,
  );
  db.prepare('UPDATE restocks SET stock_before = ?, stock_after = ? WHERE id = ?')
    .run(stockBefore, stockAfter, restock.id);
  updateWeightedCost(db, restock.fuel_id);
  return { stockBefore, stockAfter };
}

export function applyAdjustmentInventory(db, adjustment, actorId) {
  const fuel = getFuelOrThrow(db, adjustment.fuel_id, { active: true });
  const stockBefore = fuel.quantity;
  if (adjustment.quantity < 0) assertStock(fuel, Math.abs(adjustment.quantity));
  let stockAfter = roundLitres(stockBefore + adjustment.quantity);
  if (stockAfter < -EPSILON) throw conflict('Adjustment would make stock negative');
  assertCapacity(fuel, stockAfter);

  let movementId;
  if (adjustment.quantity > 0) {
    const cost = adjustment.unit_cost_cents ?? fuel.weighted_average_cost_cents;
    db.prepare(`
      INSERT INTO inventory_lots
        (fuel_id, adjustment_id, original_quantity, remaining_quantity, unit_cost_cents)
      VALUES (?, ?, ?, ?, ?)
    `).run(adjustment.fuel_id, adjustment.id, adjustment.quantity, adjustment.quantity, cost);
    const movement = db.prepare(`
      INSERT INTO inventory_movements
        (fuel_id, source_type, source_id, signed_quantity, signed_cost_cents, stock_before, stock_after, created_by)
      VALUES (?, 'stock_adjustment', ?, ?, ?, ?, ?, ?)
    `).run(
      adjustment.fuel_id,
      adjustment.id,
      adjustment.quantity,
      costTotal(adjustment.quantity, cost),
      stockBefore,
      stockAfter,
      actorId,
    );
    movementId = Number(movement.lastInsertRowid);
  } else if (adjustment.quantity < 0) {
    const consumed = consumeLots(db, fuel, Math.abs(adjustment.quantity), 'stock_adjustment', adjustment.id, actorId);
    movementId = consumed.movementId;
    stockAfter = consumed.stockAfter;
  } else {
    stockAfter = stockBefore;
  }

  db.prepare(`
    UPDATE stock_adjustments
    SET previous_quantity = ?, new_quantity = ?, old_stock = ?, new_stock = ?,
        unit_cost_cents = COALESCE(unit_cost_cents, ?), timestamp = COALESCE(NULLIF(timestamp, ''), created_at)
    WHERE id = ?
  `).run(stockBefore, stockAfter, stockBefore, stockAfter, adjustment.quantity > 0 ? adjustment.unit_cost_cents : null, adjustment.id);
  updateWeightedCost(db, adjustment.fuel_id);
  return { stockBefore, stockAfter, movementId };
}

function consumeLots(db, fuel, quantity, sourceType, sourceId, actorId) {
  assertStock(fuel, quantity);
  const lots = db.prepare(`
    SELECT id, remaining_quantity, unit_cost_cents
    FROM inventory_lots
    WHERE fuel_id = ? AND remaining_quantity > 0
    ORDER BY id
  `).all(fuel.id);
  const stockBefore = fuel.quantity;
  let remaining = roundLitres(quantity);
  let cost = 0;
  const allocations = [];

  for (const lot of lots) {
    if (remaining <= EPSILON) break;
    const allocated = roundLitres(Math.min(lot.remaining_quantity, remaining));
    if (allocated <= 0) continue;
    db.prepare('UPDATE inventory_lots SET remaining_quantity = ? WHERE id = ?')
      .run(roundLitres(lot.remaining_quantity - allocated), lot.id);
    allocations.push({ lotId: lot.id, quantity: allocated, unitCostCents: lot.unit_cost_cents });
    cost += costTotal(allocated, lot.unit_cost_cents);
    remaining = roundLitres(remaining - allocated);
  }
  if (remaining > EPSILON) throw conflict('Inventory lots do not cover the requested consumption');
  if (!Number.isSafeInteger(cost) || cost > MAX_MONEY_CENTS) throw conflict('Consumption cost is outside the supported range');

  const stockAfter = roundLitres(stockBefore - quantity);
  db.prepare(`
    UPDATE fuel_management
    SET quantity = ?, stock_litres = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ?
  `).run(stockAfter, stockAfter, fuel.id);
  const movement = db.prepare(`
    INSERT INTO inventory_movements
      (fuel_id, source_type, source_id, signed_quantity, signed_cost_cents, stock_before, stock_after, created_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(fuel.id, sourceType, sourceId, -quantity, -cost, stockBefore, stockAfter, actorId);
  const movementId = Number(movement.lastInsertRowid);
  const insertAllocation = db.prepare(`
    INSERT INTO inventory_allocations (movement_id, lot_id, quantity, unit_cost_cents)
    VALUES (?, ?, ?, ?)
  `);
  for (const allocation of allocations) {
    insertAllocation.run(movementId, allocation.lotId, allocation.quantity, allocation.unitCostCents);
  }
  updateWeightedCost(db, fuel.id);
  return { movementId, stockBefore, stockAfter };
}

export function consumeInventory(db, { fuelId, quantity, sourceType, sourceId, actorId }) {
  const fuel = getFuelOrThrow(db, fuelId, { active: true });
  if (quantity <= 0) return { movementId: null, stockBefore: fuel.quantity, stockAfter: fuel.quantity };
  return consumeLots(db, fuel, roundLitres(quantity), sourceType, sourceId, actorId);
}

export function reverseConsumption(db, { sourceType, sourceId, actorId }) {
  const original = db.prepare(`
    SELECT * FROM inventory_movements
    WHERE source_type = ? AND source_id = ? AND signed_quantity < 0 AND reversed_at IS NULL
    ORDER BY id DESC LIMIT 1
  `).get(sourceType, sourceId);
  if (!original) return null;
  const allocations = db.prepare('SELECT * FROM inventory_allocations WHERE movement_id = ?').all(original.id);
  const fuel = getFuelOrThrow(db, original.fuel_id);
  const stockBefore = fuel.quantity;
  const restoredQuantity = Math.abs(original.signed_quantity);

  const restore = db.prepare(`
    UPDATE inventory_lots
    SET remaining_quantity = MIN(original_quantity, remaining_quantity + ?)
    WHERE id = ?
  `);
  for (const allocation of allocations) {
    restore.run(allocation.quantity, allocation.lot_id);
  }
  const stockAfter = roundLitres(stockBefore + restoredQuantity);
  db.prepare(`
    UPDATE fuel_management
    SET quantity = ?, stock_litres = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ?
  `).run(stockAfter, stockAfter, fuel.id);
  const reversal = db.prepare(`
    INSERT INTO inventory_movements
      (fuel_id, source_type, source_id, signed_quantity, signed_cost_cents, stock_before, stock_after, created_by, reversal_movement_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    fuel.id,
    sourceType,
    sourceId,
    restoredQuantity,
    Math.abs(original.signed_cost_cents),
    stockBefore,
    stockAfter,
    actorId,
    original.id,
  );
  db.prepare(`
    UPDATE inventory_movements
    SET reversed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), reversal_movement_id = ?
    WHERE id = ?
  `).run(Number(reversal.lastInsertRowid), original.id);
  updateWeightedCost(db, fuel.id);
  return { movementId: Number(reversal.lastInsertRowid), stockBefore, stockAfter };
}

function reverseRestockLot(db, restock, actorId) {
  const lot = db.prepare('SELECT * FROM inventory_lots WHERE restock_id = ?').get(restock.id);
  if (!lot || lot.remaining_quantity <= EPSILON) return false;
  const fuel = getFuelOrThrow(db, restock.fuel_id);
  assertStock(fuel, lot.remaining_quantity);
  const stockBefore = fuel.quantity;
  const stockAfter = roundLitres(stockBefore - lot.remaining_quantity);
  db.prepare('UPDATE inventory_lots SET remaining_quantity = 0, restock_id = NULL WHERE id = ?').run(lot.id);
  db.prepare('UPDATE fuel_management SET quantity = ?, stock_litres = ? WHERE id = ?').run(stockAfter, stockAfter, fuel.id);
  const original = db.prepare(`
    SELECT id FROM inventory_movements
    WHERE source_type = 'restock' AND source_id = ? AND signed_quantity > 0 AND reversed_at IS NULL
    ORDER BY id DESC LIMIT 1
  `).get(restock.id);
  const movement = db.prepare(`
    INSERT INTO inventory_movements
      (fuel_id, source_type, source_id, signed_quantity, signed_cost_cents, stock_before, stock_after, created_by, reversal_movement_id)
    VALUES (?, 'restock', ?, ?, ?, ?, ?, ?, ?)
  `).run(
    fuel.id,
    restock.id,
    -lot.remaining_quantity,
    -costTotal(lot.remaining_quantity, lot.unit_cost_cents),
    stockBefore,
    stockAfter,
    actorId,
    original?.id || null,
  );
  if (original) {
    db.prepare(`UPDATE inventory_movements SET reversed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), reversal_movement_id = ? WHERE id = ?`)
      .run(Number(movement.lastInsertRowid), original.id);
  }
  updateWeightedCost(db, fuel.id);
  return true;
}

export function reviseRestock(db, restock, next, actorId) {
  const inventoryChanged = next.fuel_id !== restock.fuel_id
    || Math.abs(next.quantity - restock.quantity) > EPSILON
    || next.unit_cost_cents !== restock.unit_cost_cents;
  const existingLot = db.prepare('SELECT * FROM inventory_lots WHERE restock_id = ?').get(restock.id);
  if (inventoryChanged && (!existingLot || existingLot.remaining_quantity <= EPSILON)) {
    throw conflict('A fully consumed restock can only have descriptive metadata corrected');
  }

  if (inventoryChanged) {
    reverseRestockLot(db, restock, actorId);
    db.prepare('UPDATE inventory_lots SET restock_id = NULL WHERE restock_id = ? AND remaining_quantity <= ?').run(restock.id, EPSILON);
    if (next.quantity > 0) addRestockInventory(db, { ...next, id: restock.id }, actorId);
  }

  const stock = db.prepare('SELECT quantity FROM fuel_management WHERE id = ?').get(next.fuel_id);
  db.prepare(`
    UPDATE restocks
    SET fuel_id = ?, quantity = ?, unit_cost_cents = ?, total_cost_cents = ?,
        fuel_type = (SELECT fuel_type FROM fuel_management WHERE id = ?),
        litres_added = ?, cost_per_litre = ?, timestamp = COALESCE(NULLIF(timestamp, ''), created_at),
        supplier = ?, reference = ?, notes = ?, stock_after = ?, updated_by = ?,
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
    WHERE id = ?
  `).run(
    next.fuel_id,
    next.quantity,
    next.unit_cost_cents,
    costTotal(next.quantity, next.unit_cost_cents),
    next.fuel_id,
    next.quantity,
    next.unit_cost_cents / 100.0,
    next.supplier,
    next.reference,
    next.notes,
    inventoryChanged ? stock.quantity : restock.stock_after,
    actorId,
    restock.id,
  );
}

export function removeRestock(db, restock, actorId) {
  reverseRestockLot(db, restock, actorId);
  db.prepare('DELETE FROM restocks WHERE id = ?').run(restock.id);
}

export function getLowStockAlerts(db) {
  const threshold = getSettings(db).lowStockThresholdLitres;
  return db.prepare(`
    SELECT id, fuel_type, quantity, selling_price_cents, weighted_average_cost_cents
    FROM fuel_management
    WHERE is_active = 1 AND quantity <= ?
    ORDER BY quantity ASC, id ASC
  `).all(threshold).map((row) => ({
    fuelId: row.id,
    fuelType: row.fuel_type,
    quantityLitres: row.quantity,
    thresholdLitres: threshold,
    sellingPriceKsh: row.selling_price_cents / 100,
    weightedAverageCostKsh: row.weighted_average_cost_cents / 100,
  }));
}

export function inventoryAlertsForResponse(db, user) {
  return user.role === 'admin' ? getLowStockAlerts(db) : [];
}
