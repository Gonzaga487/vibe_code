import type { AppContext, AuthUser } from './types';
import { randomId } from './http';
import type { BindValue } from './types';

const SENSITIVE_KEY = /password|token|secret|authorization|cookie|hash/i;

function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 5) return '[TRUNCATED]';
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return value;
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitize(item, depth + 1));
  if (typeof value === 'object') {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 100)) {
      output[key] = SENSITIVE_KEY.test(key) ? '[REDACTED]' : sanitize(item, depth + 1);
    }
    return output;
  }
  return String(value);
}

export interface AuditOptions {
  category: 'auth' | 'admin' | 'sale' | 'shift' | 'inventory' | 'reading' | 'expense' | 'settings' | 'system';
  event: string;
  metadata?: unknown;
  actorId?: number | null;
  actorUsername?: string | null;
  operationId?: string;
  requestId?: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}

export function auditStatement(options: AuditOptions) {
  const now = new Date().toISOString();
  const operationClause = options.operationId ? ' AND EXISTS (SELECT 1 FROM api_operations WHERE id = ?)' : '';
  return {
    sql: `
      INSERT INTO audit_logs
        (id, actor_id, actor_username, category, event, metadata_json, ip_address, user_agent, request_id, created_at, user_id, timestamp)
      SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE 1 = 1${operationClause}
    `,
    bindings: [
      randomId(),
      options.actorId ?? null,
      options.actorUsername ?? null,
      options.category,
      options.event,
      JSON.stringify(sanitize(options.metadata || {})),
      options.ipAddress?.slice(0, 100) || null,
      options.userAgent?.slice(0, 300) || null,
      options.requestId?.slice(0, 100) || null,
      now,
      options.actorId ?? null,
      now,
      ...(options.operationId ? [options.operationId] : []),
    ] satisfies BindValue[],
  };
}

export function auditForContext(c: AppContext, options: Omit<AuditOptions, 'requestId' | 'ipAddress' | 'userAgent'>): ReturnType<typeof auditStatement> {
  let auth: AuthUser | undefined;
  try {
    auth = c.get('auth');
  } catch {
    auth = undefined;
  }
  return auditStatement({
    ...options,
    actorId: options.actorId ?? auth?.id ?? null,
    actorUsername: options.actorUsername ?? auth?.username ?? null,
    requestId: c.get('requestId'),
    ipAddress: c.req.header('cf-connecting-ip') || null,
    userAgent: c.req.header('user-agent') || null,
  });
}

export function auditPruneStatement(retentionDays: number, operationId?: string) {
  const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString();
  const guard = operationId ? 'AND EXISTS (SELECT 1 FROM api_operations WHERE id = ?)' : '';
  return {
    sql: `DELETE FROM audit_logs WHERE created_at < ?${guard}`,
    bindings: [cutoff, ...(operationId ? [operationId] : [])] satisfies BindValue[],
  };
}

export function serializeAudit(row: Record<string, unknown>) {
  let metadata: unknown = {};
  try {
    metadata = JSON.parse(String(row.metadata_json || '{}'));
  } catch {
    metadata = {};
  }
  const actorId = Number(row.user_id ?? row.actor_id ?? 0) || null;
  return {
    id: Number(row.id),
    actor: actorId ? { id: actorId, username: row.actor_username } : null,
    category: row.category,
    event: row.event,
    metadata,
    ipAddress: row.ip_address,
    userAgent: row.user_agent,
    requestId: row.request_id,
    timestamp: row.timestamp || row.created_at,
  };
}
