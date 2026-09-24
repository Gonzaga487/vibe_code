import { Hono } from 'hono';
import { auditStatement } from './audit';
import { comparePassword, hashPassword } from './auth';
import { assertOperationCreated, first, operationStatement } from './db';
import { badRequest, forbidden, unauthorized } from './errors';
import { parseJsonBody } from './http';
import { getSettings, publicSettings, settingUpsertStatement, userSettings } from './settings';
import { lowStockAlerts } from './fuel';
import { changePasswordSchema, settingsPatchSchema } from './validators';
import type { AppEnv, AppContext, UserRow, WorkerConfig } from './types';

export function settingsRouter(config: WorkerConfig): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.get('/', async (c) => {
    const settings = await getSettings(c.env.DB);
    const actor = c.get('auth');
    return c.json({ settings: actor.role === 'admin' ? settings : userSettings(settings, actor) });
  });

  app.post('/password', async (c) => {
    const actor = c.get('auth');
    const body = await parseJsonBody(c, changePasswordSchema);
    const user = await first<UserRow>(c.env.DB, 'SELECT * FROM users WHERE id = ?', actor.id);
    if (!user || !await comparePassword(body.currentPassword, user.password_hash)) {
      const audit = auditStatement({
        category: 'auth', event: 'auth.password_change_failed', actorId: actor.id, actorUsername: actor.username,
        metadata: {}, requestId: c.get('requestId'), ipAddress: c.req.header('cf-connecting-ip') || null,
        userAgent: c.req.header('user-agent') || null,
      });
      await c.env.DB.prepare(audit.sql).bind(...audit.bindings).run();
      throw unauthorized('Current password is incorrect');
    }
    if (await comparePassword(body.newPassword, user.password_hash)) throw badRequest('New password must be different from the current password');
    const hash = await hashPassword(body.newPassword, config.bcryptRounds);
    const now = new Date().toISOString();
    const operation = operationStatement({
      db: c.env.DB, kind: 'settings_password', entityTable: 'users', entityId: actor.id, requestId: c.get('requestId'),
      guard: { sessionVersion: user.session_version }, conditionSql: 'id = ? AND session_version = ?', conditionBindings: [actor.id, user.session_version],
    });
    const audit = auditStatement({
      category: 'auth', event: 'auth.password_reset_completed', actorId: actor.id, actorUsername: actor.username,
      metadata: { targetUserId: actor.id }, requestId: c.get('requestId'), operationId: operation.id,
      ipAddress: c.req.header('cf-connecting-ip') || null, userAgent: c.req.header('user-agent') || null,
    });
    await c.env.DB.batch([
      c.env.DB.prepare(operation.sql).bind(...operation.bindings),
      c.env.DB.prepare(`
        UPDATE users SET password_hash = ?, session_version = session_version + 1, must_change_password = 0,
          password_changed_at = ?, updated_at = ? WHERE id = ? AND EXISTS (SELECT 1 FROM api_operations WHERE id = ?)
      `).bind(hash, now, now, actor.id, operation.id),
      c.env.DB.prepare(audit.sql).bind(...audit.bindings),
    ]);
    await assertOperationCreated(c.env.DB, operation.id);
    const updated = await userRow(c.env.DB, actor.id);
    return c.json({ reset: true, user: { id: updated.id, username: updated.username, fullName: updated.full_name, role: updated.role }, tokenRequired: true });
  });

  app.patch('/', async (c) => {
    const actor = c.get('auth');
    if (actor.role !== 'admin') throw forbidden('Administrator access is required');
    const body = await parseJsonBody(c, settingsPatchSchema);
    const current = await getSettings(c.env.DB);
    const updates = { ...body };
    if (updates.interfaceOptions) updates.interfaceOptions = { ...current.interfaceOptions, ...updates.interfaceOptions };
    if (updates.notifications) updates.notifications = { ...current.notifications, ...updates.notifications };
    const operation = operationStatement({
      db: c.env.DB, kind: 'settings_update', entityTable: 'app_settings', requestId: c.get('requestId'),
      guard: { fields: Object.keys(body) },
    });
    const keyMap: Record<string, string> = {
      stationName: 'station_name', timezone: 'timezone', dateFormat: 'date_format', language: 'language',
      lowStockThresholdLitres: 'low_stock_threshold_litres', auditRetentionDays: 'audit_retention_days',
      interfaceOptions: 'interface_options', notifications: 'notifications',
    };
    const statements = [c.env.DB.prepare(operation.sql).bind(...operation.bindings)];
    for (const [property, value] of Object.entries(updates)) {
      const key = keyMap[property];
      if (!key || value === undefined) continue;
      const statement = settingUpsertStatement(key, value, actor.id, operation.id);
      statements.push(c.env.DB.prepare(statement.sql).bind(...statement.bindings));
    }
    const audit = auditStatement({
      category: 'settings', event: 'settings.updated', actorId: actor.id, actorUsername: actor.username,
      metadata: { fields: Object.keys(body) }, requestId: c.get('requestId'), operationId: operation.id,
      ipAddress: c.req.header('cf-connecting-ip') || null, userAgent: c.req.header('user-agent') || null,
    });
    statements.push(c.env.DB.prepare(audit.sql).bind(...audit.bindings));
    await c.env.DB.batch(statements);
    await assertOperationCreated(c.env.DB, operation.id);
    return c.json({ settings: await getSettings(c.env.DB), lowStockAlerts: await lowStockAlerts(c.env.DB) });
  });
  return app;
}

async function userRow(db: D1Database, id: number): Promise<UserRow> {
  const row = await first<UserRow>(db, 'SELECT * FROM users WHERE id = ?', id);
  if (!row) throw unauthorized();
  return row;
}

export async function publicSettingsResponse(db: D1Database): Promise<Record<string, unknown>> {
  return { settings: publicSettings(await getSettings(db)), currency: 'KSh' };
}
