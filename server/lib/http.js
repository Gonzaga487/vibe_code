import { z } from 'zod';
import { badRequest } from './errors.js';

export const asyncHandler = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);

export const idSchema = z.coerce.number().int().positive().safe();

export function parseId(value, field = 'id') {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw badRequest(`${field} must be a positive integer`);
  return id;
}

export const paginationSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
});

export function getPagination(query) {
  const page = query.page;
  const pageSize = query.pageSize;
  return { page, pageSize, offset: (page - 1) * pageSize };
}

export function paginated(items, total, pagination, mapper = (item) => item) {
  return {
    data: items.map(mapper),
    pagination: {
      page: pagination.page,
      pageSize: pagination.pageSize,
      total,
      totalPages: Math.ceil(total / pagination.pageSize),
    },
  };
}

export const MAX_MONEY_CENTS = 100_000_000_000;

export function money(cents) {
  if (cents === null || cents === undefined) return null;
  return Math.round(Number(cents)) / 100;
}

export function toCents(value, field = 'amount') {
  const number = Number(value);
  if (!Number.isFinite(number)) throw badRequest(`${field} must be a finite number`);
  const cents = Math.round(number * 100);
  if (!Number.isSafeInteger(cents) || Math.abs(cents) > MAX_MONEY_CENTS) throw badRequest(`${field} is outside the supported range`);
  return cents;
}

export function positiveMoney(value, field = 'amount') {
  const cents = toCents(value, field);
  if (cents <= 0) throw badRequest(`${field} must be greater than zero`);
  return cents;
}

export function nonNegativeMoney(value, field = 'amount') {
  const cents = toCents(value, field);
  if (cents < 0) throw badRequest(`${field} cannot be negative`);
  return cents;
}

export function roundLitres(value) {
  return Math.round((Number(value) + Number.EPSILON) * 1000) / 1000;
}

export function asInteger(value, field = 'value') {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw badRequest(`${field} must be a safe integer`);
  return number;
}

export function parseJson(value, fallback = null) {
  if (value === null || value === undefined) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

export function csvCell(value) {
  if (value === null || value === undefined) return '';
  let text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}
