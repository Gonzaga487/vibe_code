import { Hono } from 'hono';
import { auditForContext } from './audit';
import { hashPassword } from './auth';
import { assertOperationCreated, first, operationStatement } from './db';
import { badRequest, conflict, notFound } from './errors';
import { escapeLike, paginated, pagination, parseJsonBody, positiveId, randomId } from './http';
import { safeUser } from './serializers';
import { currentAdminCount } from './settings';
import { createUserSchema, parseQuery, resetPasswordSchema, updateUserSchema, usersListSchema } from './validators';
import type { AppEnv, AppContext, DbRow, UserRow, WorkerConfig } from './types';

async function userById(db: D1Database, id: number): Promise<UserRow> {
  const row = await first<UserRow>(db, 'SELECT * FROM users WHERE id = ?', id);
  if (!row) throw notFound('User was not found');
  return row;
}

export function usersRouter(config: WorkerConfig): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get('/', async (c) => {
    const filters = parseQuery(c, usersListSchema);
    const page = pagination(filters.page, filters.pageSize);
    const where: string[] = [];
    const bindings: Array<string | number> = [];
    if (filters.role) { where.push('role = ?'); bindings.push(filters.role); }
    if (filters.isActive !== undefined) { where.push('is_active = ?'); bindings.push(filters.isActive ? 1 : 0); }
    if (filters.search) {
      where.push("(username LIKE ? ESCAPE '\\' OR full_name LIKE ? ESCAPE '\\')");
      const term = `%${escapeLike(filters.search)}%`;
      bindings.push(term, term);
    }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const rows = await c.env.DB.prepare(`SELECT * FROM users ${clause} ORDER BY created_at DESC LIMIT ? OFFSET ?`)
      .bind(...bindings, page.pageSize, page.offset).all<DbRow>();
    const total = await first<{ count: number }>(c.env.DB, `SELECT COUNT(*) AS count FROM users ${clause}`, ...bindings);
    return c.json(paginated(rows.results, Number(total?.count || 0), page, safeUser));
  });

  app.get('/:id', async (c) => {
    const id = positiveId(c.req.param('id'));
    return c.json({ user: safeUser(await userById(c.env.DB, id)) });
  });

  app.post('/', async (c) => {
    const body = await parseJsonBody(c, createUserSchema);
    const duplicate = await first(c.env.DB, 'SELECT id FROM users WHERE username = ? COLLATE NOCASE', body.username);
    if (duplicate) throw conflict('Username is already in use');
    const hash = await hashPassword(body.password, config.bcryptRounds);
    const id = randomId();
    const now = new Date().toISOString();
    const operation = operationStatement({
      db: c.env.DB, kind: 'user_create', entityTable: 'users', entityId: id, requestId: c.get('requestId'),
      guard: { username: body.username, role: body.role },
      conditionSql: 'NOT EXISTS (SELECT 1 FROM users WHERE username = ? COLLATE NOCASE)', conditionBindings: [body.username], entityCondition: false,
    });
    const audit = auditForContext(c, {
      category: 'admin', event: 'admin.user_created', operationId: operation.id,
      metadata: { targetUserId: id, role: body.role },
    });
    await c.env.DB.batch([
      c.env.DB.prepare(operation.sql).bind(...operation.bindings),
      c.env.DB.prepare(`
        INSERT INTO users
          (id, username, password_hash, full_name, role, is_active, must_change_password, created_by, created_at, updated_at, password_changed_at)
        SELECT ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?
        WHERE EXISTS (SELECT 1 FROM api_operations WHERE id = ?)
      `).bind(id, body.username, hash, body.fullName, body.role, body.mustChangePassword ? 1 : 0, c.get('auth').id, now, now, now, operation.id),
      c.env.DB.prepare(audit.sql).bind(...audit.bindings),
    ]);
    await assertOperationCreated(c.env.DB, operation.id);
    return c.json({ user: safeUser(await userById(c.env.DB, id)) }, 201);
  });

  app.patch('/:id', async (c) => {
    const id = positiveId(c.req.param('id'));
    const body = await parseJsonBody(c, updateUserSchema);
    const user = await userById(c.env.DB, id);
    const nextRole = body.role ?? user.role;
    const nextActive = body.isActive ?? Boolean(user.is_active);
    if (user.id === c.get('auth').id && (nextRole !== 'admin' || !nextActive)) {
      throw badRequest('You cannot remove your own administrator access');
    }
    if (user.role === 'admin' && user.is_active && (nextRole !== 'admin' || !nextActive) && await currentAdminCount(c.env.DB, id) === 0) {
      throw conflict('At least one active administrator is required');
    }
    const nextMustChange = body.mustChangePassword === undefined ? user.must_change_password : (body.mustChangePassword ? 1 : 0);
    const now = new Date().toISOString();
    const operation = operationStatement({
      db: c.env.DB, kind: 'user_update', entityTable: 'users', entityId: id, requestId: c.get('requestId'),
      guard: { fields: Object.keys(body) },
      conditionSql: 'id = ? AND session_version = ? AND updated_at = ?', conditionBindings: [id, user.session_version, user.updated_at],
    });
    const audit = auditForContext(c, {
      category: 'admin', event: 'admin.user_updated', operationId: operation.id,
      metadata: { targetUserId: id, fields: Object.keys(body) },
    });
    await c.env.DB.batch([
      c.env.DB.prepare(operation.sql).bind(...operation.bindings),
      c.env.DB.prepare(`
        UPDATE users SET full_name = ?, role = ?, is_active = ?, must_change_password = ?,
          session_version = CASE WHEN role != ? OR is_active != ? THEN session_version + 1 ELSE session_version END,
          updated_at = ?
        WHERE id = ? AND EXISTS (SELECT 1 FROM api_operations WHERE id = ?)
      `).bind(body.fullName ?? user.full_name, nextRole, nextActive ? 1 : 0, nextMustChange, nextRole, nextActive ? 1 : 0, now, id, operation.id),
      c.env.DB.prepare(audit.sql).bind(...audit.bindings),
    ]);
    await assertOperationCreated(c.env.DB, operation.id);
    return c.json({ user: safeUser(await userById(c.env.DB, id)) });
  });

  app.delete('/:id', async (c) => {
    const id = positiveId(c.req.param('id'));
    if (id === c.get('auth').id) throw badRequest('You cannot delete your own account');
    const user = await userById(c.env.DB, id);
    if (user.role === 'admin' && user.is_active && await currentAdminCount(c.env.DB, id) === 0) throw conflict('At least one active administrator is required');
    const operation = operationStatement({
      db: c.env.DB, kind: 'user_deactivate', entityTable: 'users', entityId: id, requestId: c.get('requestId'),
      guard: { targetUserId: id }, conditionSql: 'id = ? AND session_version = ?', conditionBindings: [id, user.session_version],
    });
    const audit = auditForContext(c, {
      category: 'admin', event: 'admin.user_deleted', operationId: operation.id,
      metadata: { targetUserId: id, targetUsername: user.username, mode: 'deactivated_to_preserve_history' },
    });
    await c.env.DB.batch([
      c.env.DB.prepare(operation.sql).bind(...operation.bindings),
      c.env.DB.prepare('UPDATE users SET is_active = 0, session_version = session_version + 1, updated_at = ? WHERE id = ? AND EXISTS (SELECT 1 FROM api_operations WHERE id = ?)').bind(new Date().toISOString(), id, operation.id),
      c.env.DB.prepare(audit.sql).bind(...audit.bindings),
    ]);
    await assertOperationCreated(c.env.DB, operation.id);
    return c.json({ deleted: true, softDeleted: true, user: safeUser(await userById(c.env.DB, id)) });
  });

  app.post('/:id/reset-password', async (c) => {
    const id = positiveId(c.req.param('id'));
    const body = await parseJsonBody(c, resetPasswordSchema);
    const user = await userById(c.env.DB, id);
    const hash = await hashPassword(body.newPassword, config.bcryptRounds);
    const now = new Date().toISOString();
    const operation = operationStatement({
      db: c.env.DB, kind: 'user_password_reset', entityTable: 'users', entityId: id, requestId: c.get('requestId'),
      guard: { targetUserId: id }, conditionSql: 'id = ? AND session_version = ?', conditionBindings: [id, user.session_version],
    });
    const audit = auditForContext(c, {
      category: 'admin', event: 'admin.user_password_reset', operationId: operation.id,
      metadata: { targetUserId: id, targetUsername: user.username },
    });
    await c.env.DB.batch([
      c.env.DB.prepare(operation.sql).bind(...operation.bindings),
      c.env.DB.prepare(`
        UPDATE users SET password_hash = ?, session_version = session_version + 1, must_change_password = 1,
          password_changed_at = ?, updated_at = ? WHERE id = ? AND EXISTS (SELECT 1 FROM api_operations WHERE id = ?)
      `).bind(hash, now, now, id, operation.id),
      c.env.DB.prepare(audit.sql).bind(...audit.bindings),
    ]);
    await assertOperationCreated(c.env.DB, operation.id);
    return c.json({ user: safeUser(await userById(c.env.DB, id)), sessionsTerminated: true });
  });

  app.post('/:id/terminate', async (c) => {
    const id = positiveId(c.req.param('id'));
    const user = await userById(c.env.DB, id);
    const operation = operationStatement({
      db: c.env.DB, kind: 'user_sessions_terminate', entityTable: 'users', entityId: id, requestId: c.get('requestId'),
      guard: { targetUserId: id }, conditionSql: 'id = ? AND session_version = ?', conditionBindings: [id, user.session_version],
    });
    const audit = auditForContext(c, {
      category: 'admin', event: 'admin.user_sessions_terminated', operationId: operation.id,
      metadata: { targetUserId: id, targetUsername: user.username },
    });
    await c.env.DB.batch([
      c.env.DB.prepare(operation.sql).bind(...operation.bindings),
      c.env.DB.prepare('UPDATE users SET session_version = session_version + 1, updated_at = ? WHERE id = ? AND EXISTS (SELECT 1 FROM api_operations WHERE id = ?)').bind(new Date().toISOString(), id, operation.id),
      c.env.DB.prepare(audit.sql).bind(...audit.bindings),
    ]);
    await assertOperationCreated(c.env.DB, operation.id);
    return c.json({ user: safeUser(await userById(c.env.DB, id)), sessionsTerminated: true });
  });

  return app;
}
