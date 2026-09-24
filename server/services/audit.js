import { DateTime } from 'luxon';
import { getSettings } from './settings.js';

const SENSITIVE_KEY = /password|token|secret|authorization|cookie|hash/i;

function sanitizeMetadata(value, depth = 0) {
  if (depth > 5) return '[TRUNCATED]';
  if (value === null || ['string', 'number', 'boolean'].includes(typeof value)) return value;
  if (Array.isArray(value)) return value.slice(0, 100).map((item) => sanitizeMetadata(item, depth + 1));
  if (typeof value === 'object') {
    const output = {};
    for (const [key, item] of Object.entries(value).slice(0, 100)) {
      if (SENSITIVE_KEY.test(key)) output[key] = '[REDACTED]';
      else output[key] = sanitizeMetadata(item, depth + 1);
    }
    return output;
  }
  return String(value);
}

export function recordAudit(db, {
  req,
  actorId,
  actorUsername,
  category,
  event,
  metadata = {},
  tx = db,
  prune = true,
}) {
  const resolvedActorId = req?.auth?.user?.id ?? actorId ?? null;
  const resolvedUsername = req?.auth?.user?.username ?? actorUsername ?? null;
  const cleanMetadata = sanitizeMetadata(metadata);
  const result = tx.prepare(`
    INSERT INTO audit_logs
      (actor_id, user_id, actor_username, category, event, metadata_json, ip_address, user_agent, request_id, created_at, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
  `).run(
    resolvedActorId,
    resolvedActorId,
    resolvedUsername,
    category,
    event,
    JSON.stringify(cleanMetadata),
    req?.ip?.slice(0, 100) || null,
    req?.get?.('user-agent')?.slice(0, 300) || null,
    req?.id?.slice(0, 100) || null,
  );

  if (prune) {
    const retentionDays = getSettings(tx).auditRetentionDays;
    const cutoff = DateTime.utc().minus({ days: retentionDays }).toISO();
    tx.prepare('DELETE FROM audit_logs WHERE created_at < ?').run(cutoff);
  }
  return result.lastInsertRowid;
}

export function serializeAudit(row) {
  let metadata = {};
  try {
    metadata = JSON.parse(row.metadata_json);
  } catch {
    metadata = {};
  }
  return {
    id: row.id,
    actor: (row.user_id ?? row.actor_id) ? { id: row.user_id ?? row.actor_id, username: row.actor_username } : null,
    category: row.category,
    event: row.event,
    metadata,
    ipAddress: row.ip_address,
    userAgent: row.user_agent,
    requestId: row.request_id,
    timestamp: row.timestamp || row.created_at,
  };
}
