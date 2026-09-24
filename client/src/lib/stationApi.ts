import { request } from '@/lib/api';
import type {
  CalendarActivityKind,
  CalendarCollection,
  CalendarDay,
  Fuel,
  FuelType,
  Paginated,
  PaymentMethod,
  Pump,
  Reading,
  Role,
  Sale,
} from '@/types/api';

export type ApiContractVersion = 'v1' | 'v2';
export const API_CONTRACT_VERSION: ApiContractVersion = import.meta.env.VITE_API_CONTRACT === 'v1' ? 'v1' : 'v2';

export class ContractError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ContractError';
  }
}

type JsonRecord = Record<string, unknown>;

function record(value: unknown, context: string): JsonRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ContractError(`${context} must be an object.`);
  return value as JsonRecord;
}

function optionalRecord(value: unknown): JsonRecord | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as JsonRecord : null;
}

function valueAt(source: JsonRecord, key: string): unknown {
  return source[key];
}

function firstValue(source: JsonRecord, keys: string[]): unknown {
  for (const key of keys) {
    const value = valueAt(source, key);
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function requiredNumber(source: JsonRecord, keys: string[], context: string): number {
  const raw = firstValue(source, keys);
  const number = typeof raw === 'string' && raw.trim() ? Number(raw) : raw;
  if (typeof number !== 'number' || !Number.isFinite(number)) throw new ContractError(`${context} is missing or invalid (${keys.join(' or ')}).`);
  return number;
}

function optionalNumber(source: JsonRecord, keys: string[]): number | null {
  const raw = firstValue(source, keys);
  if (raw === undefined) return null;
  const number = typeof raw === 'string' && raw.trim() ? Number(raw) : raw;
  return typeof number === 'number' && Number.isFinite(number) ? number : null;
}

function requiredString(source: JsonRecord, keys: string[], context: string): string {
  const raw = firstValue(source, keys);
  if (typeof raw !== 'string' || !raw.trim()) throw new ContractError(`${context} is missing or invalid (${keys.join(' or ')}).`);
  return raw;
}

function optionalString(source: JsonRecord, keys: string[]): string | null {
  const raw = firstValue(source, keys);
  return typeof raw === 'string' && raw.trim() ? raw : null;
}

function numberFromNestedMoney(source: JsonRecord, keys: string[]): number | null {
  const direct = optionalNumber(source, keys);
  if (direct !== null) return direct;
  for (const key of keys) {
    const nested = optionalRecord(source[key]);
    if (nested) {
      const amount = optionalNumber(nested, ['amountKsh', 'valueKsh', 'amount', 'value']);
      if (amount !== null) return amount;
    }
  }
  return null;
}

function arrayField(root: JsonRecord, keys: string[], context: string): unknown[] {
  for (const key of keys) {
    const value = root[key];
    if (Array.isArray(value)) return value;
  }
  throw new ContractError(`${context} did not return a supported collection.`);
}

function normalizePage<T>(payload: unknown, mapper: (value: unknown, index: number) => T, context: string): Paginated<T> {
  const root = record(payload, context);
  const data = arrayField(root, ['data', 'items', 'results'], context);
  const paginationSource = optionalRecord(root.pagination) || optionalRecord(optionalRecord(root.meta)?.pagination);
  if (!paginationSource) throw new ContractError(`${context} response is missing pagination metadata.`);
  const page = requiredNumber(paginationSource, ['page'], `${context} pagination.page`);
  const pageSize = requiredNumber(paginationSource, ['pageSize', 'perPage'], `${context} pagination.pageSize`);
  const total = requiredNumber(paginationSource, ['total', 'totalItems'], `${context} pagination.total`);
  const totalPages = optionalNumber(paginationSource, ['totalPages', 'pageCount']) ?? Math.ceil(total / pageSize);
  return { data: data.map(mapper), pagination: { page, pageSize, total, totalPages } };
}

function fuelTypeFrom(value: unknown): FuelType | null {
  if (typeof value !== 'string') return null;
  const normalized = value.trim().toUpperCase();
  return normalized === 'PETROL' || normalized === 'DIESEL' ? normalized : null;
}

function normalizeFuel(value: unknown, index: number): Fuel | null {
  const raw = record(value, `fuel[${index}]`);
  const nestedFuel = optionalRecord(raw.fuel);
  const typeValue = firstValue(raw, ['fuelType', 'type']) ?? (nestedFuel ? firstValue(nestedFuel, ['fuelType', 'type']) : undefined);
  const type = fuelTypeFrom(typeValue);
  if (!type) return null;
  const nestedPrice = optionalRecord(raw.sellingPrice);
  const sellingPriceKsh = numberFromNestedMoney(raw, ['sellingPriceKsh', 'priceKsh', 'sellingPrice'])
    ?? (nestedPrice ? numberFromNestedMoney(nestedPrice, ['amountKsh', 'valueKsh']) : null);
  const activeValue = firstValue(raw, ['isActive', 'active']);
  const isActive = typeof activeValue === 'boolean' ? activeValue : activeValue === 1 || activeValue === '1' || activeValue === 'true';
  if (typeof activeValue !== 'boolean' && activeValue !== 0 && activeValue !== 1 && activeValue !== '0' && activeValue !== 'true' && activeValue !== 'false') {
    throw new ContractError(`Fuel ${type} is missing isActive.`);
  }
  return {
    id: requiredNumber(raw, ['id'], `fuel ${type}.id`),
    fuelType: type,
    pricePerLitre: optionalNumber(raw, ['pricePerLitre', 'price_per_litre']),
    sellingPriceKsh,
    isActive,
    stockLitres: optionalNumber(raw, ['stockLitres', 'stock_litres']),
    quantityLitres: optionalNumber(raw, ['quantityLitres', 'stockLitres', 'quantity']),
    weightedAverageCostKsh: numberFromNestedMoney(raw, ['weightedAverageCostKsh', 'averageCostKsh', 'weightedAverageCost']),
    inventoryValueKsh: numberFromNestedMoney(raw, ['inventoryValueKsh', 'stockValueKsh', 'inventoryValue']),
    tankCapacityLitres: optionalNumber(raw, ['tankCapacityLitres', 'capacityLitres', 'tankCapacity']),
    createdAt: optionalString(raw, ['createdAt']),
    updatedAt: optionalString(raw, ['updatedAt']),
  };
}

function normalizePump(value: unknown, index: number): Pump {
  const raw = record(value, `pump[${index}]`);
  const type = fuelTypeFrom(raw.fuelType ?? optionalRecord(raw.fuel)?.type);
  if (!type) throw new ContractError(`Pump[${index}] is missing a supported fuel type.`);
  const activeValue = raw.isActive;
  return {
    id: requiredNumber(raw, ['id'], `pump[${index}].id`),
    fuelId: requiredNumber(raw, ['fuelId', 'fuel_id'], `pump[${index}].fuelId`),
    fuelType: type,
    pumpCode: requiredString(raw, ['pumpCode', 'pump_code', 'code'], `pump[${index}].pumpCode`),
    isActive: activeValue === true || activeValue === 1 || activeValue === '1' || activeValue === 'true',
    createdAt: optionalString(raw, ['createdAt']),
    updatedAt: optionalString(raw, ['updatedAt']),
  };
}

function normalizeSale(value: unknown, index: number): Sale {
  const raw = record(value, `sale[${index}]`);
  const userRaw = optionalRecord(raw.user) || { id: raw.userId, username: raw.username, fullName: raw.fullName ?? raw.full_name };
  const fuelRaw = optionalRecord(raw.fuel) || (raw.fuelId || raw.fuelType ? { id: raw.fuelId, type: raw.fuelType } : null);
  const fuelType = fuelRaw ? fuelTypeFrom(firstValue(fuelRaw, ['type', 'fuelType']) ?? firstValue(raw, ['fuelType'])) : null;
  const modeValue = firstValue(raw, ['mode']);
  const mode = modeValue === 'quick' || modeValue === 'detailed' ? modeValue : 'detailed';
  if (mode === 'detailed' && !fuelType) throw new ContractError(`Sale[${index}] detailed mode is missing a supported Petrol or Diesel type.`);
  const paymentRaw = optionalRecord(raw.payment) || {};
  const methodValue = firstValue(paymentRaw, ['method']) ?? firstValue(raw, ['paymentMethod']);
  const method = typeof methodValue === 'string' && ['cash', 'mpesa', 'mixed'].includes(methodValue.toLowerCase())
    ? methodValue.toLowerCase() as PaymentMethod
    : null;
  if (!method) throw new ContractError(`Sale[${index}] is missing a valid payment method.`);
  const totalKsh = numberFromNestedMoney(raw, ['totalKsh', 'amountKsh', 'total']);
  if (totalKsh === null) throw new ContractError(`Sale[${index}] is missing totalKsh or amountKsh.`);
  const sale: Sale = {
    id: requiredNumber(raw, ['id'], `sale[${index}].id`),
    shiftId: requiredNumber(raw, ['shiftId'], `sale[${index}].shiftId`),
    user: {
      id: requiredNumber(userRaw, ['id'], `sale[${index}].user.id`),
      username: requiredString(userRaw, ['username'], `sale[${index}].user.username`),
      fullName: requiredString(userRaw, ['fullName', 'full_name'], `sale[${index}].user.fullName`),
    },
    mode,
    amountKsh: totalKsh,
    fuel: fuelType && fuelRaw ? {
      id: requiredNumber(fuelRaw, ['id', 'fuelId'], `sale[${index}].fuel.id`),
      type: fuelType,
    } : null,
    pumpId: optionalNumber(raw, ['pumpId', 'pump_id']),
    litres: optionalNumber(raw, ['litres', 'quantityLitres', 'volumeLitres']),
    unitPriceKsh: numberFromNestedMoney(raw, ['unitPriceKsh', 'priceKsh', 'unitPrice']),
    unitCostKsh: numberFromNestedMoney(raw, ['unitCostKsh', 'costKsh', 'unitCost']) ?? undefined,
    totalKsh,
    payment: {
      method,
      cashKsh: numberFromNestedMoney(paymentRaw, ['cashKsh', 'cashAmountKsh']) ?? numberFromNestedMoney(raw, ['cashAmountKsh', 'cashKsh']),
      mpesaKsh: numberFromNestedMoney(paymentRaw, ['mpesaKsh', 'mpesaAmountKsh']) ?? numberFromNestedMoney(raw, ['mpesaAmountKsh', 'mpesaKsh']),
    },
    customerName: optionalString(raw, ['customerName', 'customer_name']),
    notes: optionalString(raw, ['notes']),
    soldAt: requiredString(raw, ['soldAt', 'sold_at', 'timestamp'], `sale[${index}].soldAt`),
    timestamp: optionalString(raw, ['timestamp', 'soldAt', 'sold_at']) || requiredString(raw, ['soldAt', 'sold_at', 'timestamp'], `sale[${index}].timestamp`),
    createdAt: requiredString(raw, ['createdAt', 'created_at'], `sale[${index}].createdAt`),
  };
  return sale;
}

function normalizeReading(value: unknown, index: number): Reading {
  const raw = record(value, `reading[${index}]`);
  const userRaw = optionalRecord(raw.user) || { id: raw.userId, username: raw.username, fullName: raw.fullName ?? raw.full_name };
  const fuelRaw = optionalRecord(raw.fuel) || { id: raw.fuelId, type: raw.fuelType };
  const fuelType = fuelTypeFrom(firstValue(fuelRaw, ['type', 'fuelType']) ?? firstValue(raw, ['fuelType']));
  if (!fuelType) throw new ContractError(`Reading[${index}] is missing a supported Petrol or Diesel type.`);
  const reconciliationRaw = optionalRecord(raw.reconciliation) || {};
  const readingUnitRaw = optionalString(raw, ['readingUnit', 'reading_unit', 'unit'])?.toUpperCase();
  const hasKshFields = ['openingKsh', 'closingKsh', 'previousClosingKsh', 'consumptionKsh'].some((key) => raw[key] !== undefined);
  const readingUnit: Reading['readingUnit'] = readingUnitRaw === 'KSH' || readingUnitRaw === 'KES' || hasKshFields
    ? 'KSH'
    : 'LITRES';
  const opening = requiredNumber(raw, ['opening', 'openingReading', 'openingLitres', 'openingKsh'], `reading[${index}].opening`);
  const closing = requiredNumber(raw, ['closing', 'closingReading', 'closingLitres', 'closingKsh', 'closing_reading'], `reading[${index}].closing`);
  const previousClosing = requiredNumber(raw, ['previousClosing', 'previousClosingLitres', 'previousClosingKsh', 'prevClosingLitres', 'prevClosingKsh', 'previousClosing'], `reading[${index}].previousClosing`);
  const meterReference = optionalString(raw, ['meterReference', 'meter_reference', 'pumpCode', 'pumpName']) || 'Station meter';
  return {
    id: requiredNumber(raw, ['id'], `reading[${index}].id`),
    fuel: { id: requiredNumber(fuelRaw, ['id'], `reading[${index}].fuel.id`), type: fuelType },
    user: {
      id: requiredNumber(userRaw, ['id'], `reading[${index}].user.id`),
      username: requiredString(userRaw, ['username'], `reading[${index}].user.username`),
      fullName: requiredString(userRaw, ['fullName', 'full_name'], `reading[${index}].user.fullName`),
    },
    readingDate: requiredString(raw, ['readingDate', 'reading_date', 'date'], `reading[${index}].readingDate`),
    opening,
    closing,
    previousClosing,
    closingReading: closing,
    openingReading: opening,
    meterReference,
    pumpId: optionalString(raw, ['pumpId', 'pump_id']),
    readingUnit,
    notes: optionalString(raw, ['notes']),
    createdAt: requiredString(raw, ['createdAt', 'created_at'], `reading[${index}].createdAt`),
    updatedAt: requiredString(raw, ['updatedAt', 'updated_at'], `reading[${index}].updatedAt`),
    stockImpact: optionalRecord(raw.stockImpact) ? {
      beforeLitres: requiredNumber(raw.stockImpact as JsonRecord, ['beforeLitres', 'before'], `reading[${index}].stockImpact.beforeLitres`),
      afterLitres: requiredNumber(raw.stockImpact as JsonRecord, ['afterLitres', 'after'], `reading[${index}].stockImpact.afterLitres`),
    } : undefined,
    consumptionLitres: readingUnit === 'LITRES' ? optionalNumber(raw, ['consumptionLitres', 'consumption', 'litres']) : null,
    consumptionKsh: readingUnit === 'KSH' ? numberFromNestedMoney(raw, ['consumptionKsh', 'reconciliationKsh']) : null,
    unitPriceKsh: numberFromNestedMoney(raw, ['unitPriceKsh', 'reconciliationPriceKsh', 'unitPrice']),
    reconciliationKsh: numberFromNestedMoney(raw, ['reconciliationKsh', 'reconciliationAmountKsh'])
      ?? numberFromNestedMoney(reconciliationRaw, ['amountKsh', 'valueKsh', 'amount']),
  };
}

function dateKey(value: unknown, context: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new ContractError(`${context} is missing a date.`);
  const date = value.slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(new Date(`${date}T00:00:00`).getTime())) throw new ContractError(`${context} contains an invalid date.`);
  return date;
}

function activityKind(value: unknown): CalendarActivityKind | null {
  if (typeof value !== 'string') return null;
  const normalized = value.toLowerCase().replace(/[\s_-]+/g, '');
  if (normalized.includes('sale')) return 'sale';
  if (normalized.includes('restock') || normalized.includes('delivery') || normalized.includes('inventory')) return 'restock';
  if (normalized.includes('expense')) return 'expense';
  if (normalized.includes('shift')) return 'shift';
  return null;
}

function emptyDay(date: string, role: Role): CalendarDay {
  return { date, saleCount: 0, litres: null, shiftCount: 0, expenseCount: 0, restockCount: 0, financialHidden: role === 'attendant', salesKsh: null, cogsKsh: null, expensesKsh: null, netKsh: null, activities: [] };
}

function addActivity(day: CalendarDay, kind: CalendarActivityKind, id: string, label: string, available: Set<CalendarActivityKind>, increment = true): void {
  available.add(kind);
  day.activities.push({ id, kind, label });
  if (!increment) return;
  if (kind === 'sale') day.saleCount += 1;
  if (kind === 'restock') day.restockCount += 1;
  if (kind === 'expense') day.expenseCount += 1;
  if (kind === 'shift') day.shiftCount += 1;
}

function flattenCalendarEvents(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  const source = optionalRecord(value);
  if (!source) return [];
  const output: unknown[] = [];
  for (const nested of Object.values(source)) {
    if (Array.isArray(nested)) output.push(...nested);
  }
  return output;
}

function normalizeCalendar(payload: unknown): CalendarCollection {
  const root = record(payload, 'calendar');
  const periodRaw = record(root.period ?? {}, 'calendar.period');
  const roleValue = root.role;
  if (roleValue !== 'admin' && roleValue !== 'attendant') throw new ContractError('calendar.role must be admin or attendant.');
  const role: Role = roleValue;
  const days = new Map<string, CalendarDay>();
  const available = new Set<CalendarActivityKind>();
  const events = flattenCalendarEvents(root.events ?? root.items);
  if (!Array.isArray(root.events) && !Array.isArray(root.items) && (!root.events || typeof root.events !== 'object')) {
    throw new ContractError('calendar response does not contain an events collection.');
  }

  events.forEach((value, index) => {
    const raw = record(value, `calendar.events[${index}]`);
    const aggregate = firstValue(raw, ['ownSaleCount', 'ownShiftCount', 'saleCount', 'shiftCount']) !== undefined;
    if (aggregate) {
      const date = dateKey(firstValue(raw, ['date']), `calendar.events[${index}].date`);
      const day = days.get(date) || emptyDay(date, role);
      const saleCount = requiredNumber(raw, ['ownSaleCount', 'saleCount'], `calendar.events[${index}].saleCount`);
      const shiftCount = requiredNumber(raw, ['ownShiftCount', 'shiftCount'], `calendar.events[${index}].shiftCount`);
      const litres = requiredNumber(raw, ['ownLitres', 'litres'], `calendar.events[${index}].litres`);
      const expenseCount = role === 'admin'
        ? (API_CONTRACT_VERSION === 'v1' ? optionalNumber(raw, ['expenseCount']) ?? 0 : requiredNumber(raw, ['expenseCount'], `calendar.events[${index}].expenseCount`))
        : 0;
      day.saleCount += saleCount;
      day.shiftCount += shiftCount;
      day.expenseCount += expenseCount;
      day.litres = (day.litres ?? 0) + litres;
      if (role === 'admin' && raw.financialHidden !== true) {
        day.salesKsh = (day.salesKsh ?? 0) + requiredNumber(raw, ['salesKsh', 'amountKsh'], `calendar.events[${index}].salesKsh`);
        day.cogsKsh = (day.cogsKsh ?? 0) + requiredNumber(raw, ['cogsKsh'], `calendar.events[${index}].cogsKsh`);
        day.expensesKsh = (day.expensesKsh ?? 0) + requiredNumber(raw, ['expensesKsh'], `calendar.events[${index}].expensesKsh`);
        day.netKsh = (day.netKsh ?? 0) + requiredNumber(raw, ['netKsh'], `calendar.events[${index}].netKsh`);
      }
      if (day.saleCount) addActivity(day, 'sale', `${date}-sale-${index}`, `${day.saleCount} sale${day.saleCount === 1 ? '' : 's'}`, available, false);
      if (day.expenseCount) addActivity(day, 'expense', `${date}-expense-${index}`, `${day.expenseCount} expense${day.expenseCount === 1 ? '' : 's'}`, available, false);
      if (day.shiftCount) addActivity(day, 'shift', `${date}-shift-${index}`, `${day.shiftCount} shift${day.shiftCount === 1 ? '' : 's'}`, available, false);
      days.set(date, day);
      return;
    }

    const date = dateKey(firstValue(raw, ['date', 'eventDate', 'startAt', 'occurredAt', 'createdAt']), `calendar.events[${index}] date`);
    const kind = activityKind(firstValue(raw, ['kind', 'type', 'eventType', 'activityType', 'category']));
    if (!kind) return;
    const day = days.get(date) || emptyDay(date, role);
    const idValue = firstValue(raw, ['id', 'eventId']);
    const id = idValue === undefined || idValue === null ? `${date}-${kind}-${index}` : String(idValue);
    const label = optionalString(raw, ['title', 'name', 'description', 'label']) ?? kind;
    addActivity(day, kind, id, label, available);
    if (kind === 'sale') {
      const litres = optionalNumber(raw, ['litres', 'quantityLitres', 'volumeLitres']);
      if (litres !== null) day.litres = (day.litres ?? 0) + litres;
      if (role === 'admin' && raw.financialHidden !== true) {
        const financialData = optionalRecord(raw.financialData) || {};
        const amount = numberFromNestedMoney(financialData, ['amountKsh', 'totalKsh', 'amount']);
        if (amount !== null) day.salesKsh = (day.salesKsh ?? 0) + amount;
      }
    }
    if (kind === 'expense' && role === 'admin' && raw.financialHidden !== true) {
      const financialData = optionalRecord(raw.financialData) || {};
      const amount = numberFromNestedMoney(financialData, ['amountKsh', 'totalKsh', 'amount']);
      if (amount !== null) day.expensesKsh = (day.expensesKsh ?? 0) + amount;
    }
    days.set(date, day);
  });

  return {
    period: {
      from: requiredString(periodRaw, ['from'], 'calendar.period.from'),
      to: requiredString(periodRaw, ['to'], 'calendar.period.to'),
      timezone: requiredString(periodRaw, ['timezone'], 'calendar.period.timezone'),
    },
    role,
    availableKinds: [...available],
    days: [...days.values()].sort((left, right) => left.date.localeCompare(right.date)),
  };
}

export interface SaleDraft {
  mode: 'quick' | 'detailed';
  fuelId?: number;
  unitPriceKsh?: number;
  unitPriceOverrideKsh?: number;
  cashAmountKsh: number;
  mpesaAmountKsh: number;
  pumpId?: number;
  customerName?: string;
  notes?: string;
  soldAt?: string;
}

function saleMethod(cashAmountKsh: number, mpesaAmountKsh: number): PaymentMethod {
  if (cashAmountKsh > 0 && mpesaAmountKsh > 0) return 'mixed';
  if (cashAmountKsh > 0) return 'cash';
  if (mpesaAmountKsh > 0) return 'mpesa';
  throw new ContractError('Enter a Cash or M-Pesa amount greater than zero.');
}

function encodeSale(draft: SaleDraft): Record<string, unknown> {
  const paymentMethod = saleMethod(draft.cashAmountKsh, draft.mpesaAmountKsh);
  const amountKsh = Math.round((draft.cashAmountKsh + draft.mpesaAmountKsh) * 100) / 100;
  if (amountKsh <= 0) throw new ContractError('The combined sale amount must be greater than zero.');

  if (API_CONTRACT_VERSION === 'v2') {
    if (draft.mode === 'detailed' && (!draft.fuelId || !draft.pumpId)) {
      throw new ContractError('Detailed sales require a fuel type and pump.');
    }
    return {
      mode: draft.mode,
      amountKsh,
      paymentMethod,
      ...(draft.fuelId ? { fuelId: draft.fuelId } : {}),
      ...(draft.pumpId ? { pumpId: draft.pumpId } : {}),
      ...(draft.unitPriceOverrideKsh && draft.unitPriceOverrideKsh > 0 ? { unitPriceKsh: draft.unitPriceOverrideKsh } : {}),
      ...(draft.customerName?.trim() ? { customerName: draft.customerName.trim() } : {}),
      ...(draft.notes?.trim() ? { notes: draft.notes.trim() } : {}),
      ...(draft.soldAt ? { soldAt: draft.soldAt } : {}),
    };
  }

  if (!draft.fuelId || !draft.unitPriceKsh || draft.unitPriceKsh <= 0) throw new ContractError('A fuel and configured selling price are required for this API contract.');
  const litres = Math.round((amountKsh / draft.unitPriceKsh) * 1000) / 1000;
  if (litres <= 0) throw new ContractError('The sale amount is too small for the configured selling price.');
  const serverTotalKsh = Math.round(litres * Math.round(draft.unitPriceKsh * 100)) / 100;
  if (Math.abs(serverTotalKsh - amountKsh) > 0.005) {
    throw new ContractError('This amount cannot be represented exactly in 0.001 L at the configured selling price. Adjust the amount.');
  }
  const notes = [draft.pumpId ? `Meter/pump: ${draft.pumpId}` : '', draft.notes?.trim() || ''].filter(Boolean).join('\n') || undefined;
  return {
    mode: draft.mode,
    fuelId: draft.fuelId,
    litres,
    paymentMethod,
    ...(paymentMethod === 'mixed' ? { cashAmountKsh: draft.cashAmountKsh, mpesaAmountKsh: draft.mpesaAmountKsh } : {}),
    ...(draft.unitPriceOverrideKsh && draft.unitPriceOverrideKsh > 0 ? { unitPriceKsh: draft.unitPriceOverrideKsh } : {}),
    ...(draft.customerName?.trim() ? { customerName: draft.customerName.trim() } : {}),
    ...(notes ? { notes } : {}),
    ...(draft.soldAt ? { soldAt: draft.soldAt } : {}),
  };
}

export interface ReadingDraft {
  fuelId: number;
  readingDate: string;
  opening: number;
  previousClosing: number;
  closingReading: number;
  meterReference?: string;
  notes?: string;
}

function encodeReading(kind: 'pump' | 'sales', draft: ReadingDraft): Record<string, unknown> {
  const common = {
    fuelId: draft.fuelId,
    readingDate: draft.readingDate,
    ...(draft.meterReference?.trim() ? { meterReference: draft.meterReference.trim() } : {}),
    ...(draft.notes?.trim() ? { notes: draft.notes.trim() } : {}),
  };
  if (API_CONTRACT_VERSION === 'v2') {
    return kind === 'pump'
      ? { ...common, openingLitres: draft.opening, closingLitres: draft.closingReading, prevClosingLitres: draft.previousClosing }
      : { ...common, openingKsh: draft.opening, closingKsh: draft.closingReading, prevClosingKsh: draft.previousClosing };
  }
  return {
    ...common,
    openingReading: draft.opening,
    closingReading: draft.closingReading,
    previousClosing: draft.previousClosing,
  };
}

export const stationApi = {
  fuels: {
    async list(): Promise<Fuel[]> {
      const payload = await request<unknown>('/fuel');
      const root = Array.isArray(payload) ? { data: payload } : record(payload, 'fuel response');
      return arrayField(root, ['data', 'fuels', 'items'], 'fuel response').map(normalizeFuel).filter((fuel): fuel is Fuel => fuel !== null);
    },
  },
  pumps: {
    async list(): Promise<Pump[]> {
      const payload = await request<unknown>('/pumps');
      const root = Array.isArray(payload) ? { data: payload } : record(payload, 'pump response');
      return arrayField(root, ['data', 'pumps', 'items'], 'pump response').map(normalizePump);
    },
  },
  sales: {
    async list(query: string): Promise<Paginated<Sale>> {
      const payload = await request<unknown>(`/sales${query}`);
      return normalizePage(payload, normalizeSale, 'sales');
    },
    async create(draft: SaleDraft): Promise<Sale> {
      const payload = await request<unknown>('/sales', { method: 'POST', body: encodeSale(draft) });
      const root = record(payload, 'sale create response');
      return normalizeSale(root.sale ?? root, 0);
    },
    async remove(id: number): Promise<void> {
      await request<unknown>(`/sales/${id}`, { method: 'DELETE' });
    },
  },
  readings: {
    async list(kind: 'pump' | 'sales', query: string): Promise<Paginated<Reading>> {
      const endpoint = kind === 'pump' ? '/pump-readings' : '/sales-readings';
      const payload = await request<unknown>(`${endpoint}${query}`);
      return normalizePage(payload, normalizeReading, `${kind} readings`);
    },
    async save(kind: 'pump' | 'sales', id: number | null, draft: ReadingDraft): Promise<Reading> {
      const endpoint = kind === 'pump' ? '/pump-readings' : '/sales-readings';
      const payload = await request<unknown>(id ? `${endpoint}/${id}` : endpoint, { method: id ? 'PATCH' : 'POST', body: encodeReading(kind, draft) });
      const root = record(payload, 'reading save response');
      return normalizeReading(root.reading ?? root, 0);
    },
    async remove(kind: 'pump' | 'sales', id: number): Promise<void> {
      const endpoint = kind === 'pump' ? '/pump-readings' : '/sales-readings';
      await request<unknown>(`${endpoint}/${id}`, { method: 'DELETE' });
    },
  },
  calendar: {
    async list(from: string, to: string): Promise<CalendarCollection> {
      const params = new URLSearchParams({ from, to });
      return normalizeCalendar(await request<unknown>(`/calendar?${params.toString()}`));
    },
  },
};
