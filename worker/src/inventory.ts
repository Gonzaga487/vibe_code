import { conflict } from './errors';
import { MAX_MONEY_CENTS, roundLitres } from './http';
import type { BindValue, DbRow, FuelRow } from './types';

export const EPSILON = 0.0005;
const MAX_ALLOCATION_ROWS = 2000;

export interface LotRow extends DbRow {
  id: number;
  fuel_id: number;
  restock_id: number | null;
  adjustment_id: number | null;
  original_quantity: number;
  remaining_quantity: number;
  unit_cost_cents: number;
}

export interface AllocationPlan {
  lotId: number;
  quantity: number;
  unitCostCents: number;
  costCents: number;
}

export interface ConsumptionPlan {
  stockBefore: number;
  stockAfter: number;
  costCents: number;
  movementId: number;
  allocations: AllocationPlan[];
}

export function assertStock(fuel: Pick<FuelRow, 'quantity' | 'fuel_type'>, needed: number): void {
  if (fuel.quantity + EPSILON < needed) throw conflict(`Insufficient stock for ${fuel.fuel_type}`);
}

export function assertCapacity(fuel: Pick<FuelRow, 'quantity' | 'fuel_type' | 'tank_capacity_litres'>, resultingQuantity: number): void {
  if (fuel.tank_capacity_litres !== null && resultingQuantity > fuel.tank_capacity_litres + EPSILON) {
    throw conflict(`Stock change exceeds the configured capacity for ${fuel.fuel_type}`);
  }
}

export function costTotal(quantity: number, unitCostCents: number): number {
  const total = Math.round(quantity * unitCostCents);
  if (!Number.isSafeInteger(total) || total > MAX_MONEY_CENTS) throw conflict('Inventory cost total is outside the supported range');
  return total;
}

export function planConsumption(fuel: FuelRow, quantityInput: number, lots: LotRow[], movementId: number): ConsumptionPlan {
  const quantity = roundLitres(quantityInput);
  assertStock(fuel, quantity);
  if (lots.length > MAX_ALLOCATION_ROWS) throw conflict('Too many inventory lots to consume in one Worker request; consolidate lots first');
  const stockBefore = fuel.quantity;
  const stockAfter = roundLitres(stockBefore - quantity);
  let remaining = quantity;
  let costCents = 0;
  const allocations: AllocationPlan[] = [];
  for (const lot of lots) {
    if (remaining <= EPSILON) break;
    const allocated = roundLitres(Math.min(lot.remaining_quantity, remaining));
    if (allocated <= 0) continue;
    const allocatedCost = costTotal(allocated, lot.unit_cost_cents);
    allocations.push({ lotId: lot.id, quantity: allocated, unitCostCents: lot.unit_cost_cents, costCents: allocatedCost });
    costCents += allocatedCost;
    remaining = roundLitres(remaining - allocated);
  }
  if (remaining > EPSILON) throw conflict('Inventory lots do not cover the requested consumption');
  if (!Number.isSafeInteger(costCents) || costCents > MAX_MONEY_CENTS) throw conflict('Consumption cost is outside the supported range');
  return { stockBefore, stockAfter, costCents, movementId, allocations };
}

export function weightedAverageStatement(fuelId: number, operationId: string): { sql: string; bindings: BindValue[] } {
  return {
    sql: `
      UPDATE fuel_management SET
        weighted_average_cost_cents = COALESCE((
          SELECT CAST(ROUND(SUM(remaining_quantity * unit_cost_cents) / SUM(remaining_quantity)) AS INTEGER)
          FROM inventory_lots WHERE fuel_id = ? AND remaining_quantity > 0
        ), 0)
      WHERE id = ? AND EXISTS (SELECT 1 FROM api_operations WHERE id = ?)
    `,
    bindings: [fuelId, fuelId, operationId],
  };
}

export interface SourceLotBalance {
  lotId: number;
  remainingAfter: number;
}

export function stockConsumptionStatements(options: {
  operationId: string;
  fuelId: number;
  quantity: number;
  sourceType: 'pump_reading' | 'stock_adjustment';
  sourceId: number;
  actorId: number;
  plan: ConsumptionPlan;
  lotBalances: SourceLotBalance[];
}): Array<{ sql: string; bindings: BindValue[] }> {
  const { operationId, fuelId, quantity, sourceType, sourceId, actorId, plan } = options;
  const statements: Array<{ sql: string; bindings: BindValue[] }> = [
    {
      sql: `UPDATE fuel_management SET quantity = ?, stock_litres = ?, updated_at = ? WHERE id = ? AND EXISTS (SELECT 1 FROM api_operations WHERE id = ?)`,
      bindings: [plan.stockAfter, plan.stockAfter, new Date().toISOString(), fuelId, operationId],
    },
  ];
  for (const balance of options.lotBalances) {
    statements.push({
      sql: `UPDATE inventory_lots SET remaining_quantity = ? WHERE id = ? AND EXISTS (SELECT 1 FROM api_operations WHERE id = ?)`,
      bindings: [balance.remainingAfter, balance.lotId, operationId],
    });
  }
  statements.push({
    sql: `
      INSERT INTO inventory_movements
        (id, fuel_id, source_type, source_id, signed_quantity, signed_cost_cents, stock_before, stock_after, created_by, created_at)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM api_operations WHERE id = ?)
    `,
    bindings: [plan.movementId, fuelId, sourceType, sourceId, -quantity, -plan.costCents, plan.stockBefore, plan.stockAfter, actorId, new Date().toISOString(), operationId],
  });
  for (const allocation of plan.allocations) {
    statements.push({
      sql: `INSERT INTO inventory_allocations (movement_id, lot_id, quantity, unit_cost_cents) SELECT ?, ?, ?, ? WHERE EXISTS (SELECT 1 FROM api_operations WHERE id = ?)`,
      bindings: [plan.movementId, allocation.lotId, allocation.quantity, allocation.unitCostCents, operationId],
    });
  }
  statements.push(weightedAverageStatement(fuelId, operationId));
  return statements;
}
