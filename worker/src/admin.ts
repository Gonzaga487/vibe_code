import { Hono } from 'hono';
import { auditStatement } from './audit';
import { createSnapshot, restoreSnapshot, validateSnapshot } from './backup';
import { first, operationStatement } from './db';
import { AppError, tooLarge } from './errors';
import { money, parseJsonBody, randomId } from './http';
import { clearOperationalSchema, restoreSchema } from './validators';
import type { AppEnv, AppContext, DbRow } from './types';

const MAX_BACKUP_BYTES = 8 * 1024 * 1024;
const WORKER_STARTED_AT = Date.now();

export function adminRouter(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/backup', async (c) => {
    const actor = c.get('auth');
    const audit = auditStatement({
      category: 'admin', event: 'admin.backup_downloaded', actorId: actor.id, actorUsername: actor.username,
      metadata: {}, requestId: c.get('requestId'), ipAddress: c.req.header('cf-connecting-ip') || null,
      userAgent: c.req.header('user-agent') || null,
    });
    await c.env.DB.prepare(audit.sql).bind(...audit.bindings).run();
    const snapshot = await createSnapshot(c.env.DB, 2);
    const serialized = JSON.stringify(snapshot, null, 2);
    if (new TextEncoder().encode(serialized).byteLength > MAX_BACKUP_BYTES) {
      throw tooLarge('The snapshot exceeds the 8 MB safe Cloudflare D1 backup limit');
    }
    return new Response(serialized, {
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'content-disposition': `attachment; filename="zenenergies-backup-${snapshot.exportedAt.slice(0, 10)}.json"`,
      },
    });
  });

  app.post('/restore', async (c) => {
    const body = await parseJsonBody(c, restoreSchema);
    const serialized = JSON.stringify(body.snapshot);
    if (new TextEncoder().encode(serialized).byteLength > MAX_BACKUP_BYTES) {
      throw tooLarge('The snapshot exceeds the 8 MB atomic D1 restore limit');
    }
    const actor = c.get('auth');
    const snapshot = await validateSnapshot(c.env.DB, body.snapshot, 2, actor);
    const now = new Date().toISOString();
    const audit = {
      id: randomId(),
      sql: `INSERT INTO audit_logs
        (id, actor_id, actor_username, category, event, metadata_json, ip_address, user_agent, request_id, created_at, user_id, timestamp)
        VALUES (?, ?, ?, 'admin', 'admin.restore_completed', ?, ?, ?, ?, ?, ?, ?)`,
      bindings: [
        randomId(), actor.id, actor.username,
        JSON.stringify({ schemaVersion: 2, tableCount: Object.keys(snapshot.tables).length }),
        c.req.header('cf-connecting-ip') || null, c.req.header('user-agent') || null, c.get('requestId'), now, actor.id, now,
      ] satisfies Array<string | number | null>,
    };
    const counts = await restoreSnapshot(c.env.DB, snapshot, audit);
    return c.json({ restored: true, schemaVersion: 2, counts });
  });

  app.post('/clear-operational-data', async (c) => {
    const actor = c.get('auth');
    const body = await parseJsonBody(c, clearOperationalSchema);
    const openShifts = await first<{ count: number }>(c.env.DB, "SELECT COUNT(*) AS count FROM shifts WHERE status = 'open'");
    const openShiftCount = Number(openShifts?.count || 0);
    if (openShiftCount && (!body.force || body.forceConfirmation !== 'FORCE CLEAR OPERATIONAL DATA')) {
      throw new AppError(409, 'OPEN_SHIFTS_EXIST', 'Close open shifts before clearing operational data, or provide forceConfirmation explicitly');
    }
    const operation = operationStatement({
      db: c.env.DB, kind: 'clear_operational', entityTable: 'operational_data', requestId: c.get('requestId'),
      guard: { force: body.force, openShiftCount },
    });
    const audit = auditStatement({
      category: 'admin', event: 'admin.operational_data_cleared', actorId: actor.id, actorUsername: actor.username,
      metadata: { forced: Boolean(body.force), openShiftCount }, requestId: c.get('requestId'), operationId: operation.id,
      ipAddress: c.req.header('cf-connecting-ip') || null, userAgent: c.req.header('user-agent') || null,
    });
    const tables = ['inventory_allocations', 'inventory_movements', 'inventory_lots', 'sales_readings', 'pump_readings', 'expenses', 'sales', 'stock_adjustments', 'restocks', 'shifts'];
    const statements = [
      c.env.DB.prepare(operation.sql).bind(...operation.bindings),
      ...tables.map((table) => c.env.DB.prepare(`DELETE FROM "${table}"`).bind()),
      c.env.DB.prepare("UPDATE fuel_management SET quantity = 0, stock_litres = 0, weighted_average_cost_cents = 0, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE EXISTS (SELECT 1 FROM api_operations WHERE id = ?)").bind(operation.id),
      c.env.DB.prepare('DELETE FROM idempotency_records').bind(),
      c.env.DB.prepare('DELETE FROM api_operations WHERE id != ?').bind(operation.id),
      c.env.DB.prepare(audit.sql).bind(...audit.bindings),
    ];
    const result = await c.env.DB.batch(statements);
    const counts: Record<string, number> = {};
    tables.forEach((table, index) => { counts[table] = Number(result[index + 1]?.meta?.changes || 0); });
    return c.json({ cleared: true, excluded: ['users', 'app_settings', 'audit_logs', 'fuel_management', 'pumps'], counts });
  });

  app.get('/metrics', async (c) => {
    const users = await first<DbRow>(c.env.DB, `
      SELECT COUNT(*) AS total, SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) AS active,
        SUM(CASE WHEN role = 'admin' AND is_active = 1 THEN 1 ELSE 0 END) AS active_admins FROM users
    `);
    const sales = await first<DbRow>(c.env.DB, 'SELECT COUNT(*) AS count, COALESCE(SUM(total_cents), 0) AS total_cents, COALESCE(SUM(litres), 0) AS litres FROM sales');
    const shifts = await first<DbRow>(c.env.DB, "SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open FROM shifts");
    const fuel = await first<DbRow>(c.env.DB, `
      SELECT COUNT(*) AS fuel_types, COALESCE(SUM(quantity), 0) AS litres,
        COALESCE(SUM(CAST(ROUND(quantity * weighted_average_cost_cents) AS INTEGER)), 0) AS value_cents
      FROM fuel_management WHERE is_active = 1
    `);
    const quick = await first<{ quick_check: string }>(c.env.DB, 'PRAGMA quick_check');
    const foreignKeys = await first(c.env.DB, 'PRAGMA foreign_key_check');
    const audit = auditStatement({
      category: 'admin', event: 'admin.platform_metrics_viewed', actorId: c.get('auth').id,
      actorUsername: c.get('auth').username, metadata: {}, requestId: c.get('requestId'),
      ipAddress: c.req.header('cf-connecting-ip') || null, userAgent: c.req.header('user-agent') || null,
    });
    await c.env.DB.prepare(audit.sql).bind(...audit.bindings).run();
    return c.json({ metrics: {
      application: { environment: 'cloudflare-worker', schemaVersion: 2, uptimeSeconds: Math.round((Date.now() - WORKER_STARTED_AT) / 1000) },
      database: { path: 'Cloudflare D1', bytes: null, integrity: foreignKeys ? 'failed' : String(quick?.quick_check || 'unknown') },
      users: { total: Number(users?.total || 0), active: Number(users?.active || 0), activeAdmins: Number(users?.active_admins || 0) },
      operations: {
        salesCount: Number(sales?.count || 0), lifetimeSalesKsh: money(Number(sales?.total_cents || 0)), lifetimeLitresSold: Number(sales?.litres || 0),
        shifts: { total: Number(shifts?.total || 0), open: Number(shifts?.open || 0) },
        fuel: { fuelTypes: Number(fuel?.fuel_types || 0), litres: Number(fuel?.litres || 0), inventoryValueKsh: money(Number(fuel?.value_cents || 0)) },
      },
      auditLogCount: Number((await first<{ count: number }>(c.env.DB, 'SELECT COUNT(*) AS count FROM audit_logs'))?.count || 0),
    } });
  });

  return app;
}
