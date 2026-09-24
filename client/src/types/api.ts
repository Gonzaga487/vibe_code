export type Role = 'admin' | 'attendant';
export type FuelType = 'PETROL' | 'DIESEL';
export type PaymentMethod = 'cash' | 'mpesa' | 'mixed';
export type ExpenseCategory = 'FUEL' | 'UTILITIES' | 'SALARY' | 'MAINTENANCE' | 'TRANSPORT' | 'OTHER';

export interface User {
  id: number;
  username: string;
  fullName: string;
  role: Role;
  isActive: boolean;
  mustChangePassword: boolean;
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
}

export interface AuthSession {
  token: string;
  expiresAt: number;
  user: User;
}

export interface LoginResponse {
  token: string;
  expiresIn: number;
  user: User;
}

export interface Pagination {
  page: number;
  pageSize: number;
  total: number;
  totalPages: number;
}

export interface Paginated<T> {
  data: T[];
  pagination: Pagination;
}

export interface LowStockAlert {
  fuelId: number;
  fuelType: FuelType;
  quantityLitres: number;
  thresholdLitres: number;
  sellingPriceKsh: number;
  weightedAverageCostKsh: number;
}

export interface Fuel {
  id: number;
  fuelType: FuelType;
  pricePerLitre?: number | null;
  sellingPriceKsh: number | null;
  isActive: boolean;
  stockLitres?: number | null;
  quantityLitres?: number | null;
  weightedAverageCostKsh?: number | null;
  inventoryValueKsh?: number | null;
  tankCapacityLitres?: number | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface Pump {
  id: number;
  fuelId: number;
  fuelType: FuelType;
  pumpCode: string;
  isActive: boolean;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface AdminDashboard {
  role: 'admin';
  date: string;
  financialHidden: false;
  currency: 'KSh';
  today: {
    salesCount: number;
    litresSold: number;
    salesKsh: number;
    cashKsh: number;
    mpesaKsh: number;
    cogsKsh: number;
    expensesKsh: number;
    netKsh: number;
  };
  openShiftCount: number;
  lowStockAlerts: LowStockAlert[];
}

export interface AttendantDashboard {
  role: 'attendant';
  date: string;
  financialHidden: true;
  user: Pick<User, 'id' | 'fullName'> & { status: 'active' | 'inactive' };
  openShift: { id: number; status: 'open'; openedAt: string } | null;
  ownToday: { saleCount: number; litresSold: number };
}

export type Dashboard = AdminDashboard | AttendantDashboard;

export interface SaleUser {
  id: number;
  username: string;
  fullName: string;
}

export interface Sale {
  id: number;
  shiftId: number;
  user: SaleUser;
  mode: 'quick' | 'detailed';
  fuel: { id: number; type: FuelType } | null;
  pumpId: number | null;
  litres: number | null;
  unitPriceKsh: number | null;
  unitCostKsh?: number | null;
  amountKsh: number;
  totalKsh: number;
  payment: {
    method: PaymentMethod;
    cashKsh: number | null;
    mpesaKsh: number | null;
  };
  customerName: string | null;
  notes: string | null;
  soldAt: string;
  timestamp: string;
  createdAt: string;
}

export interface ShiftSummarySales {
  totalKsh: number;
  cashKsh: number;
  mpesaKsh: number;
}

export interface Shift {
  id: number;
  attendantId: number;
  user: SaleUser;
  status: 'open' | 'closed';
  statusLabel: 'Open' | 'Closed';
  openedAt: string;
  closedAt: string | null;
  openingCashKsh: number;
  openingMpesaKsh: number;
  closingCashKsh: number | null;
  closingMpesaKsh: number | null;
  expectedCashKsh: number;
  expectedMpesaKsh: number;
  openingFloat: { cashKsh: number; mpesaKsh: number };
  expected: { cashKsh: number; mpesaKsh: number };
  counted: { cashKsh: number; mpesaKsh: number } | null;
  discrepancy: { cashKsh: number; mpesaKsh: number; totalKsh: number } | null;
  summary: {
    saleCount: number;
    expenseCount: number;
    litres: number;
    sales: ShiftSummarySales;
    expenses: ShiftSummarySales;
  };
  closingNotes: string | null;
  reconciliation?: {
    recordedCashKsh: number;
    recordedMpesaKsh: number;
    recordedTotalKsh: number;
    salesMeterKsh: number;
    salesMeterVarianceKsh: number;
    pumpLitres: number;
    dataStatus: string;
  } | null;
}

export interface Reading {
  id: number;
  fuel: { id: number; type: FuelType };
  user: SaleUser;
  readingDate: string;
  opening: number;
  closing: number;
  previousClosing: number;
  closingReading: number;
  openingReading: number;
  meterReference: string;
  pumpId: string | null;
  readingUnit: 'LITRES' | 'KSH';
  notes: string | null;
  createdAt: string;
  updatedAt: string;
  stockImpact?: { beforeLitres: number; afterLitres: number };
  consumptionLitres?: number | null;
  consumptionKsh?: number | null;
  unitPriceKsh?: number | null;
  reconciliationKsh?: number | null;
}

export interface Restock {
  id: number;
  fuel: { id: number; type?: FuelType };
  fuelType?: FuelType;
  litresAdded?: number;
  quantityLitres: number;
  costPerLitre?: number;
  unitCostKsh: number;
  totalCostKsh: number;
  supplier: string;
  reference: string | null;
  notes: string | null;
  stockBeforeLitres: number;
  stockAfterLitres: number;
  createdBy: number;
  createdAt: string;
  updatedBy: number;
  updatedAt: string;
}

export interface RestockPayload {
  fuelId: number;
  quantityLitres: number;
  unitCostKsh: number;
  supplier: string;
  reference?: string;
  notes?: string;
}

export interface StockAdjustment {
  id: number;
  fuelId: number;
  fuelType?: FuelType;
  quantityLitres: number;
  reason: string;
  notes: string | null;
  unitCostKsh: number | null;
  oldStock?: number;
  newStock?: number;
  previousQuantityLitres: number;
  newQuantityLitres: number;
  createdBy: number;
  createdAt: string;
  timestamp?: string;
}

export interface Expense {
  id: number;
  shiftId: number | null;
  user: SaleUser;
  category: ExpenseCategory;
  description: string;
  amountKsh: number;
  paymentMethod: Exclude<PaymentMethod, 'mixed'>;
  expenseDate: string;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

export type ExpensePayload = Omit<ExpensePayloadBase, never>;

interface ExpensePayloadBase {
  shiftId?: number | null;
  category: ExpenseCategory;
  description: string;
  amountKsh: number;
  paymentMethod: 'cash' | 'mpesa';
  expenseDate?: string;
  notes?: string;
}

export interface DailyTrend {
  date: string;
  saleCount: number;
  litres: number;
  salesKsh: number;
  formalRevenueKsh: number;
  recordedSaleRevenueKsh: number;
  revenueVarianceKsh: number;
  rankingRevenueKsh: number;
  cogsKsh: number;
  grossProfitKsh: number;
  grossMarginPercent: number | null;
  expensesKsh: number;
  netKsh: number;
  cumulativeSignedShiftGapKsh: number;
  cumulativeAbsoluteShiftGapKsh: number;
}

export interface OperationsReport {
  period: { from: string; to: string; timezone: string };
  filters: { userId: number | null; fuelId: number | null };
  currency: 'KSh';
  dataStatus: 'noSalesMeterReadings' | 'partial' | 'complete';
  coverage: { recordedGroups: number; coveredGroups: number; ratio: number };
  totals: {
    saleCount: number;
    litres: number;
    salesKsh: number;
    formalRevenueKsh: number;
    recordedSaleRevenueKsh: number;
    revenueVarianceKsh: number;
    cogsKsh: number;
    grossProfitKsh: number;
    grossMarginPercent: number | null;
    expensesKsh: number;
    netKsh: number;
  };
  paymentSplit: { cashKsh: number; mpesaKsh: number };
  fuels: Array<{
    id: number | null;
    type: FuelType | 'UNASSIGNED';
    litres: number;
    salesKsh: number;
    formalRevenueKsh: number;
    recordedSaleRevenueKsh: number;
    revenueVarianceKsh: number;
    cogsKsh: number;
    grossProfitKsh: number;
    grossMarginPercent: number | null;
  }>;
  shiftGaps: { signedKsh: number; absoluteKsh: number };
  dailyTrend: DailyTrend[];
}

export interface DeltaValue {
  absoluteKsh: number;
  percent: number | null;
}

export interface MonthlyReport {
  year: number;
  month: number;
  previousPeriod: { year: number; month: number };
  currency: 'KSh';
  totals: OperationsReport['totals'];
  paymentSplit: OperationsReport['paymentSplit'];
  dataStatus: OperationsReport['dataStatus'];
  coverage: OperationsReport['coverage'];
  monthOverMonth: {
    revenue: DeltaValue;
    recordedRevenue: DeltaValue;
    cogs: DeltaValue;
    grossProfit: DeltaValue;
    expenses: DeltaValue;
    net: DeltaValue;
    litres: { absolute: number; percent: number | null };
  };
  bestDay: { date: string; revenueKsh: number; netKsh: number } | null;
  worstDay: { date: string; revenueKsh: number; netKsh: number } | null;
  shiftGaps: OperationsReport['shiftGaps'];
  fuels: OperationsReport['fuels'];
  dailyTrend: DailyTrend[];
}

export type DateFormat = 'yyyy-MM-dd' | 'dd/MM/yyyy' | 'MM/dd/yyyy';
export type Theme = 'system' | 'light' | 'dark';

export interface InterfaceOptions {
  theme: Theme;
  compactTables: boolean;
  showStationClock: boolean;
}

export interface PublicSettings {
  stationName: string;
  currency: 'KSh';
  timezone: string;
  dateFormat: DateFormat;
  language: 'en' | 'sw';
  interfaceOptions: InterfaceOptions;
}

export interface Settings extends PublicSettings {
  role?: Role;
  username?: string;
  lowStockThresholdLitres?: number;
  auditRetentionDays?: number;
  notifications?: {
    lowStock: boolean;
    shiftReminders: boolean;
    dailySummary: boolean;
    salesAlerts: boolean;
  };
}

export type CalendarActivityKind = 'sale' | 'restock' | 'expense' | 'shift';

export interface CalendarActivity {
  id: string;
  kind: CalendarActivityKind;
  label: string;
}

export interface CalendarDay {
  date: string;
  saleCount: number;
  litres: number | null;
  shiftCount: number;
  expenseCount: number;
  restockCount: number;
  financialHidden: boolean;
  salesKsh: number | null;
  cogsKsh: number | null;
  expensesKsh: number | null;
  netKsh: number | null;
  activities: CalendarActivity[];
}

export interface CalendarCollection {
  period: { from: string; to: string; timezone: string };
  role: Role;
  availableKinds: CalendarActivityKind[];
  days: CalendarDay[];
}

export interface AuditEntry {
  id: number;
  actor: { id: number; username: string } | null;
  category: 'auth' | 'admin' | 'sale' | 'shift' | 'inventory' | 'reading' | 'expense' | 'settings' | 'system';
  event: string;
  metadata: Record<string, unknown>;
  ipAddress: string | null;
  userAgent: string | null;
  requestId: string | null;
  timestamp: string;
}

export interface PlatformMetrics {
  application: { environment: string; schemaVersion: number; uptimeSeconds: number };
  database: { path: string; bytes: number | null; integrity: string };
  users: { total: number; active: number; activeAdmins: number };
  operations: {
    salesCount: number;
    lifetimeSalesKsh: number;
    lifetimeLitresSold: number;
    shifts: { total: number; open: number };
    fuel: { fuelTypes: number; litres: number; inventoryValueKsh: number };
  };
  auditLogCount: number;
}

export interface BackupSnapshot {
  format: 'zenenergies-sqlite-json';
  formatVersion: 1;
  schemaVersion: number;
  exportedAt: string;
  tables: Record<string, { columns: unknown[]; rows: Record<string, unknown>[] }>;
  checksum: string;
}

export interface DeletedResponse {
  deleted: true;
  id: number;
  lowStockAlerts?: LowStockAlert[];
}

export interface RestoreResponse {
  restored: true;
  schemaVersion: number;
  counts: Record<string, number>;
}

export interface ClearOperationalResponse {
  cleared: true;
  excluded: string[];
  counts: Record<string, number>;
}
