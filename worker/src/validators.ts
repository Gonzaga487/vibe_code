import type { Context } from 'hono';
import { z } from 'zod';
import { isValidTimezone } from './date';
import { badRequest } from './errors';
import { validationDetails } from './http';
import { MAX_MONEY_CENTS } from './http';

export const roleSchema = z.enum(['admin', 'attendant']);
export const fuelTypeSchema = z.enum(['PETROL', 'DIESEL']);
export const paymentMethodSchema = z.enum(['cash', 'mpesa', 'mixed']);
export const expenseCategorySchema = z.enum(['FUEL', 'UTILITIES', 'SALARY', 'MAINTENANCE', 'TRANSPORT', 'OTHER']);
export const isoDateSchema = z.iso.date();

export const passwordSchema = z.string()
  .min(12, 'Password must be at least 12 characters')
  .max(128, 'Password cannot exceed 128 characters')
  .regex(/[a-z]/, 'Password must contain a lowercase letter')
  .regex(/[A-Z]/, 'Password must contain an uppercase letter')
  .regex(/\d/, 'Password must contain a number')
  .regex(/[^A-Za-z0-9]/, 'Password must contain a symbol')
  .refine((value) => !/(password|admin|station|welcome|qwerty)/i.test(value), 'Password is too predictable');

export const usernameSchema = z.string()
  .trim()
  .min(3)
  .max(32)
  .regex(/^[A-Za-z0-9._-]+$/, 'Username may contain letters, numbers, dots, underscores, and hyphens')
  .regex(/[A-Za-z]/, 'Username must contain a letter');

export const loginSchema = z.object({
  username: z.string().trim().min(1).max(32),
  password: z.string().min(1).max(128),
  role: roleSchema,
}).strict();

function confirmedPasswordSchema() {
  return z.object({
    currentPassword: z.string().min(1).max(128),
    newPassword: z.string().max(128),
    confirmPassword: z.string().max(128).optional(),
    confirmNewPassword: z.string().max(128).optional(),
  }).strict().superRefine((value, context) => {
    const parsedPassword = passwordSchema.safeParse(value.newPassword);
    if (!parsedPassword.success) {
      context.addIssue({ code: 'custom', path: ['newPassword'], message: parsedPassword.error.issues[0]?.message || 'New password is not strong enough' });
    }
    const confirmation = value.confirmPassword ?? value.confirmNewPassword;
    if (!confirmation) context.addIssue({ code: 'custom', path: ['confirmPassword'], message: 'Password confirmation is required' });
    else if (confirmation !== value.newPassword) context.addIssue({ code: 'custom', path: ['confirmPassword'], message: 'Password confirmation does not match' });
  });
}

export const changePasswordSchema = confirmedPasswordSchema();

const paginationFields = {
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
};

export const usersListSchema = z.object({
  ...paginationFields,
  role: roleSchema.optional(),
  isActive: z.enum(['true', 'false']).transform((value) => value === 'true').optional(),
  search: z.string().trim().max(100).optional(),
}).strict();

export const createUserSchema = z.object({
  username: usernameSchema,
  password: passwordSchema,
  fullName: z.string().trim().min(2).max(100),
  role: roleSchema,
  mustChangePassword: z.boolean().default(true),
}).strict();

export const updateUserSchema = z.object({
  fullName: z.string().trim().min(2).max(100).optional(),
  role: roleSchema.optional(),
  isActive: z.boolean().optional(),
  mustChangePassword: z.boolean().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, 'At least one field is required');

export const resetPasswordSchema = z.object({ newPassword: passwordSchema }).strict();

export const shiftOpenSchema = z.object({
  openingCashKsh: z.number().finite().nonnegative().default(0),
  openingMpesaKsh: z.number().finite().nonnegative().default(0),
}).strict();

export const shiftCloseSchema = z.object({
  countedCashKsh: z.number().finite().nonnegative(),
  countedMpesaKsh: z.number().finite().nonnegative(),
  closingCashKsh: z.number().finite().nonnegative().optional(),
  closingMpesaKsh: z.number().finite().nonnegative().optional(),
  notes: z.string().trim().max(1000).optional(),
}).strict().superRefine((value, context) => {
  if (value.closingCashKsh !== undefined && Math.round(value.closingCashKsh * 100) !== Math.round(value.countedCashKsh * 100)) {
    context.addIssue({ code: 'custom', path: ['closingCashKsh'], message: 'closingCashKsh must match countedCashKsh' });
  }
  if (value.closingMpesaKsh !== undefined && Math.round(value.closingMpesaKsh * 100) !== Math.round(value.countedMpesaKsh * 100)) {
    context.addIssue({ code: 'custom', path: ['closingMpesaKsh'], message: 'closingMpesaKsh must match countedMpesaKsh' });
  }
});

export const shiftsListSchema = z.object({
  ...paginationFields,
  status: z.enum(['open', 'closed', 'Open', 'Closed']).transform((value) => value.toLowerCase()).optional(),
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
  userId: z.coerce.number().int().positive().optional(),
}).strict().refine((value) => !value.from || !value.to || value.from <= value.to, 'from cannot be after to');

const litresSchema = z.number().finite().positive().max(100_000).refine(
  (value) => Math.abs(value * 1000 - Math.round(value * 1000)) < 0.000001,
  'litres supports at most 3 decimal places',
);
const amountSchema = z.number().finite().positive().max(MAX_MONEY_CENTS / 100);
const optionalMoneySchema = z.number().finite().nonnegative().max(MAX_MONEY_CENTS / 100).optional();

export const saleSchema = z.object({
  mode: z.enum(['quick', 'detailed']),
  paymentMethod: paymentMethodSchema,
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
  if (value.soldAt && Date.parse(value.soldAt) > Date.now()) {
    context.addIssue({ code: 'custom', path: ['soldAt'], message: 'soldAt must be a valid timestamp that is not in the future' });
  }
});

export const salesListSchema = z.object({
  ...paginationFields,
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
  shiftId: z.coerce.number().int().positive().optional(),
  userId: z.coerce.number().int().positive().optional(),
  fuelId: z.coerce.number().int().positive().optional(),
  fuelType: fuelTypeSchema.optional(),
  pumpId: z.coerce.number().int().positive().optional(),
  mode: z.enum(['quick', 'detailed']).optional(),
  paymentMethod: paymentMethodSchema.optional(),
  search: z.string().trim().max(120).optional(),
}).strict().refine((value) => !value.from || !value.to || value.from <= value.to, 'from cannot be after to');

export const fuelCreateSchema = z.object({
  fuelType: fuelTypeSchema,
  sellingPriceKsh: z.number().finite().positive(),
  tankCapacityLitres: z.number().finite().positive().max(10_000_000).optional(),
}).strict();

export const fuelPatchSchema = z.object({
  sellingPriceKsh: z.number().finite().positive().optional(),
  tankCapacityLitres: z.number().finite().positive().max(10_000_000).nullable().optional(),
  isActive: z.boolean().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, 'At least one field is required');

export const sellingPriceSchema = z.object({ sellingPriceKsh: z.number().finite().positive() }).strict();

export const restockCreateSchema = z.object({
  fuelId: z.coerce.number().int().positive().safe(),
  quantityLitres: z.number().finite().positive().max(1_000_000).refine(
    (value) => Math.abs(value * 1000 - Math.round(value * 1000)) < 0.000001,
    'quantityLitres supports at most 3 decimal places',
  ),
  unitCostKsh: z.number().finite().nonnegative(),
  supplier: z.string().trim().min(2).max(120),
  reference: z.string().trim().min(1).max(100).optional(),
  notes: z.string().trim().max(1000).optional(),
}).strict();

export const restockPatchSchema = restockCreateSchema.partial().refine((value) => Object.keys(value).length > 0, 'At least one field is required');

export const adjustmentSchema = z.object({
  fuelId: z.coerce.number().int().positive().safe(),
  newStockLitres: z.number().finite().nonnegative().max(10_000_000).refine(
    (value) => Math.abs(value * 1000 - Math.round(value * 1000)) < 0.000001,
    'newStockLitres supports at most 3 decimal places',
  ).optional(),
  quantityLitres: z.number().finite().min(-1_000_000).max(1_000_000).refine(
    (value) => Math.abs(value * 1000 - Math.round(value * 1000)) < 0.000001,
    'quantityLitres supports at most 3 decimal places',
  ).optional(),
  reason: z.string().trim().min(3).max(500),
  notes: z.string().trim().max(1000).optional(),
  unitCostKsh: z.number().finite().nonnegative().optional(),
}).strict().refine((value) => (value.newStockLitres === undefined) !== (value.quantityLitres === undefined), 'Provide newStockLitres or legacy quantityLitres, not both');

export const inventoryListSchema = z.object({
  ...paginationFields,
  fuelId: z.coerce.number().int().positive().optional(),
  supplier: z.string().trim().max(120).optional(),
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
}).strict().refine((value) => !value.from || !value.to || value.from <= value.to, 'from cannot be after to');

export const pumpCreateSchema = z.object({
  fuelId: z.coerce.number().int().positive().safe(),
  pumpCode: z.string().trim().min(1).max(50).regex(/^[A-Za-z0-9._-]+$/, 'pumpCode contains invalid characters'),
}).strict();

export const pumpPatchSchema = z.object({ isActive: z.boolean() }).strict();

const readingBaseSchema = z.object({
  fuelId: z.coerce.number().int().positive().safe().optional(),
  fuelType: fuelTypeSchema.optional(),
  date: isoDateSchema.optional(),
  readingDate: isoDateSchema.optional(),
  openingLitres: z.number().finite().nonnegative().max(1_000_000_000_000).optional(),
  openingReading: z.number().finite().nonnegative().max(1_000_000_000_000).optional(),
  openingKsh: z.number().finite().nonnegative().max(1_000_000_000_000).optional(),
  closingLitres: z.number().finite().nonnegative().max(1_000_000_000_000).optional(),
  closingReading: z.number().finite().nonnegative().max(1_000_000_000_000).optional(),
  closingKsh: z.number().finite().nonnegative().max(1_000_000_000_000).optional(),
  previousClosing: z.number().finite().nonnegative().max(1_000_000_000_000).optional(),
  prevClosingLitres: z.number().finite().nonnegative().max(1_000_000_000_000).optional(),
  prevClosingKsh: z.number().finite().nonnegative().max(1_000_000_000_000).optional(),
  meterReference: z.string().trim().min(1).max(100).optional(),
  notes: z.string().trim().max(1000).optional(),
}).strict();

export const readingCreateSchema = readingBaseSchema.superRefine((value, context) => {
  if (!value.fuelId && !value.fuelType) context.addIssue({ code: 'custom', path: ['fuelId'], message: 'A fuel type is required' });
  if (!value.date && !value.readingDate) context.addIssue({ code: 'custom', path: ['date'], message: 'A reading date is required' });
  const opening = value.openingLitres ?? value.openingReading ?? value.openingKsh;
  const closing = value.closingLitres ?? value.closingReading ?? value.closingKsh;
  if (opening === undefined) context.addIssue({ code: 'custom', path: ['openingLitres'], message: 'An opening reading is required' });
  if (closing === undefined) context.addIssue({ code: 'custom', path: ['closingLitres'], message: 'A closing reading is required' });
  if (value.openingLitres !== undefined && value.openingReading !== undefined && value.openingLitres !== value.openingReading) context.addIssue({ code: 'custom', path: ['openingReading'], message: 'Opening aliases do not match' });
  if (value.closingLitres !== undefined && value.closingReading !== undefined && value.closingLitres !== value.closingReading) context.addIssue({ code: 'custom', path: ['closingReading'], message: 'Closing aliases do not match' });
});

export const readingPatchSchema = readingBaseSchema.partial().refine((value) => Object.keys(value).length > 0, 'At least one field is required');
export const readingBackdateSchema = readingBaseSchema.partial().refine((value) => value.date !== undefined || value.readingDate !== undefined, 'A reading date is required');

export const readingsListSchema = z.object({
  ...paginationFields,
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
  fuelId: z.coerce.number().int().positive().optional(),
  userId: z.coerce.number().int().positive().optional(),
}).strict().refine((value) => !value.from || !value.to || value.from <= value.to, 'from cannot be after to');

export const expenseCreateSchema = z.object({
  shiftId: z.coerce.number().int().positive().safe().nullable().optional(),
  category: expenseCategorySchema,
  description: z.string().trim().min(2).max(500),
  amountKsh: z.number().finite().positive(),
  paymentMethod: z.enum(['cash', 'mpesa']),
  expenseDate: isoDateSchema.optional(),
  notes: z.string().trim().max(1000).optional(),
}).strict();

export const expensePatchSchema = expenseCreateSchema.partial().refine((value) => Object.keys(value).length > 0, 'At least one field is required');

export const expensesListSchema = z.object({
  ...paginationFields,
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
  shiftId: z.coerce.number().int().positive().optional(),
  userId: z.coerce.number().int().positive().optional(),
  category: expenseCategorySchema.optional(),
}).strict().refine((value) => !value.from || !value.to || value.from <= value.to, 'from cannot be after to');

export const settingsPatchSchema = z.object({
  stationName: z.string().trim().min(2).max(100).optional(),
  timezone: z.string().trim().min(1).max(100).optional(),
  dateFormat: z.enum(['yyyy-MM-dd', 'dd/MM/yyyy', 'MM/dd/yyyy']).optional(),
  language: z.enum(['en', 'sw']).optional(),
  lowStockThresholdLitres: z.number().finite().nonnegative().max(10_000_000).optional(),
  auditRetentionDays: z.number().int().min(30).max(3650).optional(),
  interfaceOptions: z.object({
    theme: z.enum(['system', 'light', 'dark']).optional(),
    compactTables: z.boolean().optional(),
    showStationClock: z.boolean().optional(),
  }).strict().optional(),
  notifications: z.object({
    lowStock: z.boolean().optional(),
    shiftReminders: z.boolean().optional(),
    dailySummary: z.boolean().optional(),
    salesAlerts: z.boolean().optional(),
  }).strict().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, 'At least one field is required').superRefine((value, context) => {
  if (value.timezone && !isValidTimezone(value.timezone)) {
    context.addIssue({ code: 'custom', path: ['timezone'], message: 'timezone must be a valid IANA timezone' });
  }
});

export const auditListSchema = z.object({
  ...paginationFields,
  category: z.enum(['auth', 'admin', 'sale', 'shift', 'inventory', 'reading', 'expense', 'settings', 'system']).optional(),
  event: z.string().trim().min(1).max(100).optional(),
  actorId: z.coerce.number().int().positive().optional(),
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
}).strict().refine((value) => !value.from || !value.to || value.from <= value.to, 'from cannot be after to');

export const auditWipeSchema = z.object({
  confirmation: z.literal('WIPE AUDIT LOGS'),
  retentionDays: z.number().int().min(1).max(3650).optional(),
  wipeAll: z.boolean().default(false),
}).strict();

export const calendarQuerySchema = z.object({ from: isoDateSchema, to: isoDateSchema }).strict().superRefine((value, context) => {
  if (value.from > value.to) context.addIssue({ code: 'custom', path: ['to'], message: 'to cannot be before from' });
});

export const reportQuerySchema = z.object({
  from: isoDateSchema,
  to: isoDateSchema,
  userId: z.coerce.number().int().positive().optional(),
  fuelId: z.coerce.number().int().positive().optional(),
}).strict().superRefine((value, context) => {
  if (value.from > value.to) context.addIssue({ code: 'custom', path: ['to'], message: 'to cannot be before from' });
});

export const monthlyQuerySchema = z.object({
  year: z.coerce.number().int().min(2020).max(new Date().getUTCFullYear()),
  month: z.coerce.number().int().min(1).max(12),
}).strict();

export const csvQuerySchema = z.object({ from: isoDateSchema.optional(), to: isoDateSchema.optional() }).strict().refine(
  (value) => !value.from || !value.to || value.from <= value.to,
  'from cannot be after to',
);

export const clearOperationalSchema = z.object({
  confirmation: z.literal('CLEAR OPERATIONAL DATA'),
  force: z.boolean().default(false),
  forceConfirmation: z.literal('FORCE CLEAR OPERATIONAL DATA').optional(),
}).strict();

export const restoreSchema = z.object({ snapshot: z.unknown() }).strict();

export function parseQuery<T>(c: Context, schema: z.ZodType<T>): T {
  const result = schema.safeParse(c.req.query());
  if (!result.success) throw badRequest('Request validation failed', validationDetails(result.error, 'query'));
  return result.data;
}
