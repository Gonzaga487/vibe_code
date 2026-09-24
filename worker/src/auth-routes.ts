import { Hono } from 'hono';
import { auditStatement } from './audit';
import {
  assertLoginAllowed,
  clearLoginFailures,
  comparePassword,
  failedLoginAudit,
  findAuthUser,
  findLoginUser,
  hashPassword,
  loginFailureStatement,
  signAccessToken,
} from './auth';
import { assertOperationCreated, first, operationStatement } from './db';
import { badRequest, unauthorized } from './errors';
import { parseJsonBody } from './http';
import { currentUser } from './serializers';
import { changePasswordSchema, loginSchema } from './validators';
import type { AppEnv, AppContext, UserRow, WorkerConfig } from './types';

export function authRoutes(config: WorkerConfig): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.post('/login', async (c) => {
    const body = await parseJsonBody(c, loginSchema);
    const ipAddress = c.req.header('cf-connecting-ip') || 'unknown';
    const identity = `${body.username}|${ipAddress}`;
    await assertLoginAllowed(c.env.DB, identity, config);
    const user = await findLoginUser(c.env.DB, body.username);
    const passwordMatches = await comparePassword(body.password, user?.password_hash);
    if (!user || !passwordMatches || !user.is_active || user.role !== body.role) {
      const limiter = await loginFailureStatement(config, identity);
      const audit = failedLoginAudit({
        requestId: c.get('requestId'), ipAddress: c.req.header('cf-connecting-ip') || null,
        userAgent: c.req.header('user-agent') || null, actorId: user?.id, username: body.username, role: body.role,
      });
      await c.env.DB.batch([
        c.env.DB.prepare(limiter.sql).bind(...limiter.bindings),
        c.env.DB.prepare(audit.sql).bind(...audit.bindings),
      ]);
      throw unauthorized('Invalid username, password, or role');
    }

    const now = new Date().toISOString();
    const limiter = await clearLoginFailures(c.env.DB, identity, config);
    const audit = auditStatement({
      category: 'auth', event: 'auth.login_succeeded', actorId: user.id, actorUsername: user.username,
      metadata: { role: user.role }, requestId: c.get('requestId'),
      ipAddress: c.req.header('cf-connecting-ip') || null, userAgent: c.req.header('user-agent') || null,
    });
    await c.env.DB.batch([
      c.env.DB.prepare("UPDATE users SET last_login_at = ? WHERE id = ?").bind(now, user.id),
      c.env.DB.prepare(limiter.sql).bind(...limiter.bindings),
      c.env.DB.prepare(audit.sql).bind(...audit.bindings),
    ]);
    const current = await findAuthUser(c.env.DB, user.id);
    if (!current) throw unauthorized();
    return c.json({
      token: await signAccessToken(current, config.jwtSecret),
      expiresIn: 1800,
      user: currentUser(current),
    });
  });

  app.get('/me', async (c) => c.json({ user: currentUser(c.get('auth')) }));

  app.post('/change-password', async (c) => {
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
    const passwordHash = await hashPassword(body.newPassword, config.bcryptRounds);
    const now = new Date().toISOString();
    const operation = operationStatement({
      db: c.env.DB, kind: 'password_change', entityTable: 'users', entityId: actor.id, requestId: c.get('requestId'),
      guard: { sessionVersion: user.session_version }, conditionSql: 'id = ? AND session_version = ?', conditionBindings: [actor.id, user.session_version],
    });
    const audit = auditStatement({
      category: 'auth', event: 'auth.password_changed', actorId: actor.id, actorUsername: actor.username,
      metadata: { targetUserId: actor.id }, requestId: c.get('requestId'), ipAddress: c.req.header('cf-connecting-ip') || null,
      userAgent: c.req.header('user-agent') || null, operationId: operation.id,
    });
    await c.env.DB.batch([
      c.env.DB.prepare(operation.sql).bind(...operation.bindings),
      c.env.DB.prepare(`
        UPDATE users SET password_hash = ?, session_version = session_version + 1, must_change_password = 0,
          password_changed_at = ?, updated_at = ? WHERE id = ? AND EXISTS (SELECT 1 FROM api_operations WHERE id = ?)
      `).bind(passwordHash, now, now, actor.id, operation.id),
      c.env.DB.prepare(audit.sql).bind(...audit.bindings),
    ]);
    await assertOperationCreated(c.env.DB, operation.id);
    const updated = await findAuthUser(c.env.DB, actor.id);
    if (!updated) throw unauthorized();
    return c.json({ token: await signAccessToken(updated, config.jwtSecret), expiresIn: 1800, user: currentUser(updated) });
  });

  return app;
}
