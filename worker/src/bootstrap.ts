import { first, operationStatement } from './db';
import { hashPassword } from './auth';
import { auditStatement } from './audit';
import { AppError } from './errors';
import { passwordSchema, usernameSchema } from './validators';
import { z } from 'zod';
import type { Env, WorkerConfig } from './types';
import { randomId } from './http';

let lastBootstrapCheck = 0;
let bootstrapUnavailable = false;

export async function maybeBootstrapAdmin(env: Env, config: WorkerConfig, force = false): Promise<boolean> {
  const now = Date.now();
  if (!force && bootstrapUnavailable && now - lastBootstrapCheck < 60_000) return false;
  lastBootstrapCheck = now;
  const existing = await first<{ count: number }>(env.DB, 'SELECT COUNT(*) AS count FROM users');
  if (Number(existing?.count || 0) > 0) {
    bootstrapUnavailable = false;
    return false;
  }

  const username = env.ADMIN_USERNAME?.trim();
  const password = env.ADMIN_PASSWORD;
  const fullName = env.ADMIN_FULL_NAME?.trim() || 'Station Administrator';
  if (!username || !password) {
    bootstrapUnavailable = true;
    return false;
  }

  const parsedUsername = usernameSchema.safeParse(username);
  const parsedPassword = passwordSchema.safeParse(password);
  const parsedName = z.string().trim().min(2).max(100).safeParse(fullName);
  if (!parsedUsername.success || !parsedPassword.success || !parsedName.success) {
    bootstrapUnavailable = true;
    throw new AppError(503, 'BOOTSTRAP_UNAVAILABLE', 'Administrator bootstrap is not available');
  }

  const passwordHash = await hashPassword(parsedPassword.data, config.bcryptRounds);
  const userId = randomId();
  const requestId = crypto.randomUUID();
  const operation = operationStatement({
    db: env.DB,
    kind: 'bootstrap_admin',
    entityTable: 'users',
    requestId,
    conditionSql: 'NOT EXISTS (SELECT 1 FROM users)',
    entityCondition: false,
  });
  const nowIso = new Date().toISOString();
  const audit = auditStatement({
    category: 'admin',
    event: 'admin.bootstrap',
    actorId: userId,
    actorUsername: parsedUsername.data,
    metadata: { userId, username: parsedUsername.data, source: 'worker_secret_bindings' },
    requestId,
    operationId: operation.id,
  });
  const statements = [
    env.DB.prepare(operation.sql).bind(...operation.bindings),
    env.DB.prepare(`
      INSERT INTO users
        (id, username, password_hash, full_name, role, is_active, must_change_password, created_at, updated_at, password_changed_at)
      SELECT ?, ?, ?, ?, 'admin', 1, 1, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM api_operations WHERE id = ?)
    `).bind(userId, parsedUsername.data, passwordHash, parsedName.data, nowIso, nowIso, nowIso, operation.id),
    env.DB.prepare(audit.sql).bind(...audit.bindings),
  ];
  await env.DB.batch(statements);
  bootstrapUnavailable = false;
  const created = await first<{ count: number }>(env.DB, 'SELECT COUNT(*) AS count FROM users WHERE id = ?', userId);
  return Number(created?.count || 0) === 1;
}
