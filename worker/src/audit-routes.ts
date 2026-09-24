import { Hono } from 'hono';
import { auditForContext, serializeAudit } from './audit';
import { first, operationStatement } from './db';
import { paginated, pagination, parseJsonBody } from './http';
import { getSettings } from './settings';
import { auditListSchema, auditWipeSchema, parseQuery } from './validators';
import type { AppEnv, AppContext, DbRow } from './types';

export function auditRouter(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.get('/', async (c) => {
    const filters = parseQuery(c, auditListSchema);
    const page = pagination(filters.page, filters.pageSize);
    const where: string[] = [];
    const bindings: Array<string | number> = [];
    if (filters.category) { where.push('category = ?'); bindings.push(filters.category); }
    if (filters.event) { where.push('event LIKE ?'); bindings.push(`%${filters.event}%`); }
    if (filters.actorId) { where.push('actor_id = ?'); bindings.push(filters.actorId); }
    if (filters.from) { where.push('date(created_at) >= ?'); bindings.push(filters.from); }
    if (filters.to) { where.push('date(created_at) <= ?'); bindings.push(filters.to); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const rows = await c.env.DB.prepare(`SELECT * FROM audit_logs ${clause} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`)
      .bind(...bindings, page.pageSize, page.offset).all<DbRow>();
    const count = await first<{ count: number }>(c.env.DB, `SELECT COUNT(*) AS count FROM audit_logs ${clause}`, ...bindings);
    const audit = auditForContext(c, {
      category: 'admin', event: 'admin.audit_viewed',
      metadata: { page: filters.page, pageSize: filters.pageSize, category: filters.category || null },
    });
    await c.env.DB.prepare(audit.sql).bind(...audit.bindings).run();
    return c.json(paginated(rows.results, Number(count?.count || 0), page, serializeAudit));
  });

  app.post('/wipe', async (c) => {
    const body = await parseJsonBody(c, auditWipeSchema);
    const settings = await getSettings(c.env.DB);
    const retentionDays = body.retentionDays ?? settings.auditRetentionDays;
    const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString();
    const operation = operationStatement({
      db: c.env.DB, kind: 'audit_wipe', entityTable: 'audit_logs', requestId: c.get('requestId'),
      guard: { wipeAll: body.wipeAll, retentionDays },
    });
    const audit = auditForContext(c, {
      category: 'admin', event: 'admin.audit_wiped', operationId: operation.id,
      metadata: { retentionDays: body.wipeAll ? null : retentionDays, wipeAll: body.wipeAll },
    });
    const result = await c.env.DB.batch([
      c.env.DB.prepare(operation.sql).bind(...operation.bindings),
      c.env.DB.prepare(body.wipeAll
        ? 'DELETE FROM audit_logs WHERE EXISTS (SELECT 1 FROM api_operations WHERE id = ?)'
        : 'DELETE FROM audit_logs WHERE created_at < ? AND EXISTS (SELECT 1 FROM api_operations WHERE id = ?)')
        .bind(...(body.wipeAll ? [operation.id] : [cutoff, operation.id])),
      c.env.DB.prepare(audit.sql).bind(...audit.bindings),
    ]);
    const deleted = Number(result[1]?.meta?.changes || 0);
    return c.json({ wiped: true, deleted, preservedActionEvent: true });
  });
  return app;
}
