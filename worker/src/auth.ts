import type { MiddlewareHandler } from 'hono';
import { jwtVerify, SignJWT } from 'jose';
import { z } from 'zod';
import bcrypt from 'bcryptjs';
import { auditStatement } from './audit';
import { first } from './db';
import { AppError, forbidden, rateLimited, unauthorized } from './errors';
import type { AppEnv, AppContext, AuthUser, DbRow, UserRow, WorkerConfig } from './types';

const ISSUER = 'zenenergies-api';
const AUDIENCE = 'zenenergies-web';
const TOKEN_TTL_SECONDS = 30 * 60;
const DUMMY_BCRYPT_HASH = '$2b$10$A.iMMI91Hsh8JDDDgDYjpuMf2.kn.YGPrhxiyASf5k2c.FNlQ1kH.';

const payloadSchema = z.object({
  sub: z.coerce.number().int().positive().safe(),
  role: z.enum(['admin', 'attendant']),
  ver: z.number().int().nonnegative().safe(),
});

const PASSWORD_CHANGE_PATHS = new Set([
  '/api/auth/me',
  '/api/auth/change-password',
  '/api/settings',
  '/api/settings/password',
]);

function secretKey(secret: string): Uint8Array<ArrayBuffer> {
  return new Uint8Array(new TextEncoder().encode(secret)) as Uint8Array<ArrayBuffer>;
}

export async function signAccessToken(user: AuthUser, secret: string): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ role: user.role, ver: user.session_version })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(String(user.id))
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt(now)
    .setExpirationTime(now + TOKEN_TTL_SECONDS)
    .sign(secretKey(secret));
}

export function authMiddleware(config: WorkerConfig): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const header = c.req.header('authorization');
    if (!header?.startsWith('Bearer ')) throw unauthorized();
    const token = header.slice(7).trim();
    if (!token) throw unauthorized();
    let user: UserRow | null;
    try {
      const verified = await jwtVerify(token, secretKey(config.jwtSecret), {
        algorithms: ['HS256'],
        issuer: ISSUER,
        audience: AUDIENCE,
      });
      const payload = payloadSchema.parse(verified.payload);
      user = await first<UserRow>(c.env.DB, `
        SELECT id, username, full_name, role, is_active, session_version, must_change_password,
               created_at, updated_at, last_login_at
        FROM users WHERE id = ?
      `, payload.sub);
      if (!user || !user.is_active || user.role !== payload.role || user.session_version !== payload.ver) {
        throw unauthorized('Session is no longer valid');
      }
      const passwordChangePathAllowed = PASSWORD_CHANGE_PATHS.has(c.req.path)
        && (c.req.path !== '/api/auth/me' || c.req.method === 'GET')
        && (c.req.path !== '/api/settings' || c.req.method === 'GET')
        && (c.req.path !== '/api/settings/password' || c.req.method === 'POST');
      if (user.must_change_password && !passwordChangePathAllowed) {
        throw new AppError(403, 'PASSWORD_CHANGE_REQUIRED', 'Password change is required before using the station API');
      }
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw unauthorized('Invalid or expired access token');
    }
    c.set('auth', user);
    await next();
  };
}

export const requireAdmin: MiddlewareHandler<AppEnv> = async (c, next) => {
  if (c.get('auth')?.role !== 'admin') throw forbidden('Administrator access is required');
  await next();
};

async function identityHash(identity: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey('raw', secretKey(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(identity));
  return [...new Uint8Array(signature)].map((value) => value.toString(16).padStart(2, '0')).join('');
}

export async function assertLoginAllowed(db: D1Database, identity: string, config: WorkerConfig): Promise<void> {
  const keyHash = await identityHash(identity.toLowerCase(), config.jwtSecret);
  const row = await first<{ blocked_until: number }>(db, 'SELECT blocked_until FROM login_rate_limits WHERE key_hash = ?', keyHash);
  if (row && Number(row.blocked_until) > Date.now()) throw rateLimited();
}

export async function loginFailureStatement(config: WorkerConfig, identity: string): Promise<{ sql: string; bindings: Array<string | number> }> {
  const keyHash = await identityHash(identity.toLowerCase(), config.jwtSecret);
  const now = Date.now();
  const cutoff = now - config.loginWindowMs;
  return { sql: `
    INSERT INTO login_rate_limits (key_hash, window_started_at, attempts, blocked_until, updated_at)
    VALUES (?, ?, 1, 0, ?)
    ON CONFLICT(key_hash) DO UPDATE SET
      attempts = CASE WHEN login_rate_limits.window_started_at <= ? THEN 1 ELSE login_rate_limits.attempts + 1 END,
      window_started_at = CASE WHEN login_rate_limits.window_started_at <= ? THEN excluded.window_started_at ELSE login_rate_limits.window_started_at END,
      blocked_until = CASE
        WHEN login_rate_limits.window_started_at <= ? AND login_rate_limits.attempts + 1 >= ? THEN ?
        WHEN login_rate_limits.window_started_at > ? AND login_rate_limits.attempts + 1 >= ? THEN ?
        ELSE login_rate_limits.blocked_until
      END,
      updated_at = excluded.updated_at
  `, bindings: [
    keyHash,
    now,
    new Date(now).toISOString(),
    cutoff,
    cutoff,
    cutoff,
    config.loginMaxFailures,
    now + config.loginBlockMs,
    cutoff,
    config.loginMaxFailures,
    now + config.loginBlockMs,
  ] };
}

export async function clearLoginFailures(db: D1Database, identity: string, config: WorkerConfig): Promise<{ keyHash: string; sql: string; bindings: Array<string | number> }> {
  const keyHash = await identityHash(identity.toLowerCase(), config.jwtSecret);
  return {
    keyHash,
    sql: `UPDATE login_rate_limits SET attempts = 0, blocked_until = 0, updated_at = ? WHERE key_hash = ?`,
    bindings: [new Date().toISOString(), keyHash],
  };
}

export async function comparePassword(password: string, hash: string | null | undefined): Promise<boolean> {
  return bcrypt.compare(password, hash || DUMMY_BCRYPT_HASH);
}

export async function hashPassword(password: string, rounds: number): Promise<string> {
  return bcrypt.hash(password, rounds);
}

export async function findLoginUser(db: D1Database, username: string): Promise<UserRow | null> {
  return first<UserRow>(db, 'SELECT * FROM users WHERE username = ? COLLATE NOCASE', username);
}

export async function findAuthUser(db: D1Database, id: number): Promise<AuthUser | null> {
  return first<AuthUser>(db, `
    SELECT id, username, full_name, role, is_active, session_version, must_change_password,
           created_at, updated_at, last_login_at
    FROM users WHERE id = ?
  `, id);
}

export async function purgeExpiredWorkerRows(db: D1Database): Promise<void> {
  const now = new Date();
  const retentionRow = await first<DbRow>(db, 'SELECT value_json FROM app_settings WHERE key = ?', 'audit_retention_days');
  let retentionDays = 365;
  try {
    const parsed = JSON.parse(String(retentionRow?.value_json || '365')) as unknown;
    if (Number.isInteger(parsed) && Number(parsed) >= 30 && Number(parsed) <= 3650) retentionDays = Number(parsed);
  } catch {
    // Keep the safe default when a legacy/corrupt setting is encountered.
  }
  const auditCutoff = new Date(now.getTime() - retentionDays * 86_400_000).toISOString();
  await db.batch([
    db.prepare('DELETE FROM login_rate_limits WHERE blocked_until < ? AND updated_at < ?').bind(new Date(now.getTime() - 86_400_000).toISOString(), now.toISOString()),
    db.prepare('DELETE FROM api_operations WHERE expires_at < ?').bind(now.toISOString()),
    db.prepare('DELETE FROM idempotency_records WHERE expires_at < ?').bind(now.toISOString()),
    db.prepare('DELETE FROM audit_logs WHERE created_at < ?').bind(auditCutoff),
  ]);
}

export function failedLoginAudit(options: {
  requestId: string;
  ipAddress: string | null;
  userAgent: string | null;
  actorId?: number | null;
  username: string;
  role: string;
}) {
  return auditStatement({
    category: 'auth',
    event: 'auth.login_failed',
    metadata: { submittedRole: options.role, reason: 'invalid_credentials_or_role' },
    actorId: options.actorId,
    actorUsername: options.username.slice(0, 32),
    requestId: options.requestId,
    ipAddress: options.ipAddress,
    userAgent: options.userAgent,
  });
}
