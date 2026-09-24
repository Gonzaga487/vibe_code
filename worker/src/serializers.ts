import { parseJson, money } from './http';
import type { AuthUser, FuelType, PumpRow, Role } from './types';

export function safeUser(user: Record<string, unknown> | null): Record<string, unknown> | null {
  if (!user) return null;
  return {
    id: Number(user.id),
    username: user.username,
    fullName: user.full_name,
    role: user.role,
    isActive: Boolean(user.is_active),
    mustChangePassword: Boolean(user.must_change_password),
    createdAt: user.created_at,
    updatedAt: user.updated_at,
    lastLoginAt: user.last_login_at,
  };
}

export function serializeFuel(row: Record<string, unknown>, role: Role) {
  const base = { id: Number(row.id), fuelType: row.fuel_type, isActive: Boolean(row.is_active) };
  if (role !== 'admin') return base;
  return {
    ...base,
    pricePerLitre: Number(row.price_per_litre),
    sellingPriceKsh: money(Number(row.selling_price_cents)),
    stockLitres: Number(row.stock_litres),
    quantityLitres: Number(row.stock_litres),
    weightedAverageCostKsh: money(Number(row.weighted_average_cost_cents)),
    inventoryValueKsh: money(Math.round(Number(row.stock_litres) * Number(row.weighted_average_cost_cents))),
    tankCapacityLitres: row.tank_capacity_litres,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function serializePump(row: Record<string, unknown>) {
  return {
    id: Number(row.id),
    fuelId: Number(row.fuel_id),
    fuelType: row.fuel_type,
    pumpCode: row.pump_code,
    isActive: Boolean(row.is_active),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function serializeSale(row: Record<string, unknown>, role: Role) {
  const response: Record<string, unknown> = {
    id: Number(row.id),
    shiftId: Number(row.shift_id),
    user: { id: Number(row.user_id), username: row.username, fullName: row.full_name },
    mode: row.mode,
    amountKsh: money(Number(row.amount_cents)),
    totalKsh: money(Number(row.total_cents)),
    payment: {
      method: row.payment_method,
      cashKsh: money(Number(row.cash_cents)),
      mpesaKsh: money(Number(row.mpesa_cents)),
    },
    fuel: row.fuel_id ? { id: Number(row.fuel_id), type: row.fuel_type } : null,
    pumpId: row.pump_id === null || row.pump_id === undefined ? null : Number(row.pump_id),
    litres: row.litres,
    customerName: row.customer_name,
    notes: row.notes,
    soldAt: row.sold_at,
    timestamp: row.timestamp,
    createdAt: row.created_at,
  };
  if (role === 'admin') {
    response.unitPriceKsh = row.unit_price_cents === null ? null : money(Number(row.unit_price_cents));
    response.unitCostKsh = row.unit_cost_cents === null ? null : money(Number(row.unit_cost_cents));
  }
  return response;
}

export function expectedShiftAmounts(row: Record<string, unknown>): { cash: number; mpesa: number } {
  return {
    cash: Number(row.opening_float_cents) + Number(row.sales_cash_cents) - Number(row.expense_cash_cents),
    mpesa: Number(row.opening_float_mpesa_cents) + Number(row.sales_mpesa_cents) - Number(row.expense_mpesa_cents),
  };
}

export function serializeShift(row: Record<string, unknown>, role: Role) {
  const expected = expectedShiftAmounts(row);
  const hasCounted = row.counted_cash_cents !== null && row.counted_mpesa_cents !== null;
  const cashDifference = hasCounted ? Number(row.counted_cash_cents) - expected.cash : null;
  const mpesaDifference = hasCounted ? Number(row.counted_mpesa_cents) - expected.mpesa : null;
  const attendantId = Number(row.attendant_id ?? row.user_id);
  const response: Record<string, unknown> = {
    id: Number(row.id),
    attendantId,
    user: { id: attendantId, username: row.username, fullName: row.full_name },
    status: row.status,
    statusLabel: row.status_label || (row.status === 'open' ? 'Open' : 'Closed'),
    openedAt: row.opened_at,
    closedAt: row.closed_at,
    openingCashKsh: money(Number(row.opening_float_cents)),
    openingMpesaKsh: money(Number(row.opening_float_mpesa_cents)),
    closingCashKsh: row.counted_cash_cents === null ? null : money(Number(row.counted_cash_cents)),
    closingMpesaKsh: row.counted_mpesa_cents === null ? null : money(Number(row.counted_mpesa_cents)),
    expectedCashKsh: money(expected.cash),
    expectedMpesaKsh: money(expected.mpesa),
    openingFloat: { cashKsh: money(Number(row.opening_float_cents)), mpesaKsh: money(Number(row.opening_float_mpesa_cents)) },
    expected: { cashKsh: money(expected.cash), mpesaKsh: money(expected.mpesa) },
    counted: hasCounted ? { cashKsh: money(Number(row.counted_cash_cents)), mpesaKsh: money(Number(row.counted_mpesa_cents)) } : null,
    discrepancy: hasCounted ? {
      cashKsh: money(cashDifference),
      mpesaKsh: money(mpesaDifference),
      totalKsh: money(Number(cashDifference) + Number(mpesaDifference)),
    } : null,
    summary: {
      saleCount: Number(row.sale_count),
      expenseCount: Number(row.expense_count),
      litres: Number(row.litres || 0),
      sales: {
        totalKsh: money(Number(row.sales_total_cents)),
        cashKsh: money(Number(row.sales_cash_cents)),
        mpesaKsh: money(Number(row.sales_mpesa_cents)),
      },
      expenses: {
        totalKsh: money(Number(row.expense_cash_cents) + Number(row.expense_mpesa_cents)),
        cashKsh: money(Number(row.expense_cash_cents)),
        mpesaKsh: money(Number(row.expense_mpesa_cents)),
      },
    },
    closingNotes: row.closing_notes,
  };
  if (role === 'admin') response.reconciliation = parseJson(typeof row.reconciliation_json === 'string' ? row.reconciliation_json : null, null);
  return response;
}

export function serializeRestock(row: Record<string, unknown>) {
  return {
    id: Number(row.id),
    fuel: { id: Number(row.fuel_id), type: row.fuel_type },
    fuelType: row.fuel_type,
    litresAdded: Number(row.litres_added),
    quantityLitres: Number(row.litres_added),
    costPerLitre: Number(row.cost_per_litre),
    unitCostKsh: money(Number(row.unit_cost_cents)),
    totalCostKsh: money(Number(row.total_cents)),
    supplier: row.supplier,
    reference: row.reference,
    notes: row.notes,
    stockBeforeLitres: row.stock_before,
    stockAfterLitres: row.stock_after,
    createdBy: Number(row.created_by),
    createdAt: row.created_at,
    timestamp: row.timestamp,
    updatedBy: Number(row.updated_by),
    updatedAt: row.updated_at,
  };
}

export function serializeAdjustment(row: Record<string, unknown>) {
  return {
    id: Number(row.id),
    fuelId: Number(row.fuel_id),
    fuelType: row.fuel_type,
    quantityLitres: Number(row.quantity),
    reason: row.reason,
    notes: row.notes,
    unitCostKsh: row.unit_cost_cents === null ? null : money(Number(row.unit_cost_cents)),
    oldStock: Number(row.old_stock),
    newStock: Number(row.new_stock),
    previousQuantityLitres: row.previous_quantity,
    newQuantityLitres: row.new_quantity,
    createdBy: Number(row.created_by),
    createdAt: row.created_at,
    timestamp: row.timestamp,
  };
}

export function serializeReading(row: Record<string, unknown>, role: Role, kind: 'pump' | 'sales') {
  const isPump = kind === 'pump';
  const response: Record<string, unknown> = {
    id: Number(row.id),
    date: row.date,
    readingDate: row.date,
    fuel: { id: Number(row.fuel_id), type: row.fuel_type as FuelType },
    user: { id: Number(row.user_id), username: row.username, fullName: row.full_name },
    opening: isPump ? Number(row.opening_litres) : Number(row.opening_ksh),
    closing: isPump ? Number(row.closing_litres) : Number(row.closing_ksh),
    previousClosing: isPump ? Number(row.prev_closing_litres) : Number(row.prev_closing_ksh),
    openingLitres: isPump ? Number(row.opening_litres) : undefined,
    closingLitres: isPump ? Number(row.closing_litres) : undefined,
    previousClosingLitres: isPump ? Number(row.prev_closing_litres) : undefined,
    openingKsh: !isPump ? Number(row.opening_ksh) : undefined,
    closingKsh: !isPump ? Number(row.closing_ksh) : undefined,
    previousClosingKsh: !isPump ? Number(row.prev_closing_ksh) : undefined,
    readingUnit: isPump ? 'LITRES' : 'KSH',
    closingReading: isPump ? Number(row.closing_litres) : Number(row.closing_ksh),
    openingReading: isPump ? Number(row.opening_litres) : Number(row.opening_ksh),
    pumpId: null,
    meterReference: row.meter_reference,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (role === 'admin') {
    if (isPump) {
      response.consumptionLitres = Number(row.consumption);
      response.unitPriceKsh = money(Number(row.reconciliation_price_cents));
      response.reconciliationKsh = money(Number(row.reconciliation_value_cents));
      if (row.stock_before !== null && row.stock_after !== null) {
        response.stockImpact = { beforeLitres: Number(row.stock_before), afterLitres: Number(row.stock_after) };
      }
    } else {
      response.consumptionKsh = money(Number(row.reconciliation_value_cents));
      response.reconciliationKsh = money(Number(row.reconciliation_value_cents));
    }
  }
  return response;
}

export function serializeExpense(row: Record<string, unknown>) {
  return {
    id: Number(row.id),
    shiftId: row.shift_id === null ? null : Number(row.shift_id),
    user: { id: Number(row.user_id), username: row.username, fullName: row.full_name },
    category: row.category,
    description: row.description,
    amountKsh: money(Number(row.amount_cents)),
    amount: Number(row.amount),
    paymentMethod: row.payment_method,
    expenseDate: row.expense_date,
    timestamp: row.timestamp,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function currentUser(user: AuthUser): Record<string, unknown> {
  return {
    id: user.id,
    username: user.username,
    fullName: user.full_name,
    role: user.role,
    isActive: Boolean(user.is_active),
    mustChangePassword: Boolean(user.must_change_password),
    createdAt: user.created_at,
    updatedAt: user.updated_at,
    lastLoginAt: user.last_login_at,
  };
}

export type { PumpRow };
