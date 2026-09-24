import { describe, expect, it } from 'vitest';
import { planConsumption } from '../../src/inventory';
import type { FuelRow } from '../../src/types';
import type { LotRow } from '../../src/inventory';

describe('FIFO inventory planning', () => {
  it('allocates the oldest lots first and reconciles cost', () => {
    const fuel = { id: 1, fuel_type: 'DIESEL', quantity: 100, tank_capacity_litres: 1000 } as FuelRow;
    const lots = [
      { id: 10, fuel_id: 1, original_quantity: 40, remaining_quantity: 40, unit_cost_cents: 10000 },
      { id: 11, fuel_id: 1, original_quantity: 60, remaining_quantity: 60, unit_cost_cents: 12000 },
    ] as LotRow[];
    const plan = planConsumption(fuel, 50, lots, 99);
    expect(plan.allocations).toEqual([
      { lotId: 10, quantity: 40, unitCostCents: 10000, costCents: 400000 },
      { lotId: 11, quantity: 10, unitCostCents: 12000, costCents: 120000 },
    ]);
    expect(plan.stockAfter).toBe(50);
    expect(plan.costCents).toBe(520000);
  });

  it('rejects consumption that stock or lots cannot cover', () => {
    const fuel = { id: 1, fuel_type: 'PETROL', quantity: 2, tank_capacity_litres: 1000 } as FuelRow;
    expect(() => planConsumption(fuel, 3, [], 1)).toThrow(/Insufficient stock/);
  });
});
