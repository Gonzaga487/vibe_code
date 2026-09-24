import { AppError, conflict, tooLarge, unprocessable } from './errors';
import { randomOperationId } from './http';
import type { BindValue, DbRow } from './types';

export async function first<T extends DbRow = DbRow>(db: D1Database, sql: string, ...bindings: BindValue[]): Promise<T | null> {
  return db.prepare(sql).bind(...bindings).first<T>();
}

export async function all<T extends DbRow = DbRow>(db: D1Database, sql: string, ...bindings: BindValue[]): Promise<T[]> {
  return (await db.prepare(sql).bind(...bindings).all<T>()).results;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export interface OperationOptions {
  db: D1Database;
  kind: string;
  entityTable: string;
  entityId?: number | string | null;
  requestId?: string;
  guard?: unknown;
  conditionSql?: string;
  conditionBindings?: BindValue[];
  entityCondition?: boolean;
  retentionHours?: number;
}

/**
 * Creates a durable write guard inside the same D1 batch as its mutation.
 * Every business statement is additionally conditioned on this operation row,
 * preventing a stale pre-read from partially applying after a concurrent write.
 */
export function operationStatement(options: OperationOptions): { id: string; sql: string; bindings: BindValue[] } {
  if (!/^[a-z][a-z0-9_]{0,79}$/i.test(options.entityTable)) throw new Error('Unsafe operation entity table');
  const id = randomOperationId();
  const now = Date.now();
  const created = new Date(now).toISOString();
  const expires = new Date(now + (options.retentionHours ?? 24 * 30) * 3_600_000).toISOString();
  const condition = options.conditionSql
    ? options.entityCondition === false
      ? ` AND (${options.conditionSql})`
      : ` AND EXISTS (SELECT 1 FROM "${options.entityTable}" WHERE ${options.conditionSql})`
    : '';
  const sql = `
    INSERT INTO api_operations
      (id, operation_kind, entity_table, entity_id, request_id, guard_json, created_at, expires_at)
    SELECT ?, ?, ?, ?, ?, ?, ?, ?
    WHERE 1 = 1${condition}
  `;
  return {
    id,
    sql,
    bindings: [
      id,
      options.kind,
      options.entityTable,
      options.entityId === undefined || options.entityId === null ? null : String(options.entityId),
      options.requestId || null,
      JSON.stringify(options.guard ?? {}),
      created,
      expires,
      ...(options.conditionBindings || []),
    ],
  };
}

export function operationExistsSql(alias = 'op'): string {
  return `EXISTS (SELECT 1 FROM api_operations ${alias} WHERE ${alias}.id = ?)`;
}

export function operationExistsCondition(operationId: string, alias = 'op'): { sql: string; bindings: BindValue[] } {
  return { sql: operationExistsSql(alias), bindings: [operationId] };
}

export async function assertOperationCreated(db: D1Database, id: string): Promise<void> {
  const row = await first(db, 'SELECT id FROM api_operations WHERE id = ?', id);
  if (!row) throw conflict('The record changed while this request was being processed; retry the request');
}

export function d1ConstraintMessage(error: unknown): string | null {
  if (!error || typeof error !== 'object') return null;
  const message = 'message' in error && typeof error.message === 'string' ? error.message : '';
  return /(UNIQUE constraint failed|constraint failed|FOREIGN KEY constraint failed|CHECK constraint failed)/i.test(message)
    ? message
    : null;
}

export function normalizeD1Error(error: unknown): never {
  const message = error instanceof Error ? error.message : '';
  if (/(TOO_LARGE|request.*large|query.*too large|body.*large)/i.test(message)) throw tooLarge();
  if (d1ConstraintMessage(error)) throw conflict('The requested change conflicts with existing data');
  if (/(busy|locked|timeout|temporarily unavailable)/i.test(message)) {
    throw new AppError(503, 'DATABASE_UNAVAILABLE', 'The database is temporarily unavailable');
  }
  if (/(invalid JSON|malformed|unsupported)/i.test(message)) throw unprocessable('A database value could not be processed');
  throw error;
}
