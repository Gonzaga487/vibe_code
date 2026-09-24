import type { Context } from 'hono';
import type { ZodType } from 'zod';
import { AppError, badRequest, tooLarge } from './errors';
import type { AppContext, DbRow } from './types';

export const MAX_MONEY_CENTS = 100_000_000_000;

export function money(cents: number | null | undefined): number | null {
  if (cents === null || cents === undefined) return null;
  return Math.round(Number(cents)) / 100;
}

export function toCents(value: unknown, field = 'amount'): number {
  const number = typeof value === 'string' && value.trim() ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isFinite(number)) {
    throw badRequest(`${field} must be a finite number`);
  }
  const cents = Math.round(number * 100);
  if (!Number.isSafeInteger(cents) || Math.abs(cents) > MAX_MONEY_CENTS) {
    throw badRequest(`${field} is outside the supported range`);
  }
  return cents;
}

export function positiveMoney(value: unknown, field = 'amount'): number {
  const cents = toCents(value, field);
  if (cents <= 0) throw badRequest(`${field} must be greater than zero`);
  return cents;
}

export function nonNegativeMoney(value: unknown, field = 'amount'): number {
  const cents = toCents(value, field);
  if (cents < 0) throw badRequest(`${field} cannot be negative`);
  return cents;
}

export function roundLitres(value: number): number {
  return Math.round((value + Number.EPSILON) * 1000) / 1000;
}

export function roundKsh(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function randomId(): number {
  const bytes = new Uint32Array(2);
  crypto.getRandomValues(bytes);
  const value = ((bytes[0] ?? 0) * 2 ** 21) + ((bytes[1] ?? 0) & 0x1fffff);
  return value || 1;
}

export function randomOperationId(): string {
  return crypto.randomUUID();
}

export function positiveId(value: string | undefined, field = 'id'): number {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) throw badRequest(`${field} must be a positive integer`);
  return id;
}

export function parseJson<T>(value: string | null | undefined, fallback: T): T {
  if (value === null || value === undefined) return fallback;
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export function escapeLike(value: string): string {
  return value.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_');
}

export interface Pagination {
  page: number;
  pageSize: number;
  offset: number;
}

export function pagination(page: number, pageSize: number): Pagination {
  return { page, pageSize, offset: (page - 1) * pageSize };
}

export function paginated<T>(items: T[], total: number, page: Pagination, mapper: (item: T) => unknown = (item) => item): {
  data: unknown[];
  pagination: { page: number; pageSize: number; total: number; totalPages: number };
} {
  return {
    data: items.map(mapper),
    pagination: { page: page.page, pageSize: page.pageSize, total, totalPages: Math.ceil(total / page.pageSize) },
  };
}

export function validationDetails(error: { issues: Array<{ path: PropertyKey[]; message: string }> }, source: string): Array<{ field: string; message: string }> {
  return error.issues.map((issue) => ({
    field: issue.path.length ? issue.path.map(String).join('.') : source,
    message: issue.message,
  }));
}

export async function parseJsonBody<T>(c: Context, schema: ZodType<T>): Promise<T> {
  const contentType = c.req.header('content-type')?.split(';', 1)[0]?.trim().toLowerCase();
  if (contentType && contentType !== 'application/json' && !/^application\/[a-z0-9.+-]+\+json$/.test(contentType)) {
    throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE', 'Request content type is not supported');
  }
  let body: unknown;
  try {
    body = await c.req.json();
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(400, 'INVALID_JSON', 'Request body contains invalid JSON');
  }
  const result = schema.safeParse(body);
  if (!result.success) throw badRequest('Request validation failed', validationDetails(result.error, 'body'));
  return result.data;
}

export function queryValue(c: Context, key: string): string | undefined {
  const value = c.req.query(key);
  return value === '' ? undefined : value;
}

export function assertContentLength(c: AppContext, maximum: number): void {
  const raw = c.req.header('content-length');
  if (!raw) return;
  const length = Number(raw);
  if (!Number.isFinite(length) || length < 0) throw badRequest('Content-Length is invalid');
  if (length > maximum) throw tooLarge();
}

export function queryRows<T extends DbRow = DbRow>(result: D1Result<T>): T[] {
  return result.results;
}

export function jsonResponse(data: unknown, status: 200 | 201 = 200, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...headers,
    },
  });
}

export function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '';
  let text = typeof value === 'object' ? JSON.stringify(value) : String(value);
  if (/^[=+\-@]/.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

export function csv(rows: unknown[][]): string {
  return `\uFEFF${rows.map((row) => row.map(csvCell).join(',')).join('\n')}\n`;
}
