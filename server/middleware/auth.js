import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { AppError, forbidden, unauthorized } from '../lib/errors.js';
import { recordAudit } from '../services/audit.js';

const tokenPayloadSchema = z.object({
  sub: z.coerce.number().int().positive().safe(),
  role: z.enum(['admin', 'attendant']),
  ver: z.number().int().nonnegative().safe(),
});

export function createUserSelector(db) {
  return db.prepare(`
    SELECT id, username, full_name, role, is_active, session_version, must_change_password, created_at, updated_at, last_login_at
    FROM users
    WHERE id = ?
  `);
}

export function safeUser(user) {
  if (!user) return null;
  return {
    id: user.id,
    username: user.username,
    fullName: user.full_name,
    role: user.role,
    isActive: Boolean(user.is_active),
    mustChangePassword: Boolean(user.must_change_password),
    createdAt: user.created_at,
    updatedAt: user.updated_at,
    lastLoginAt: user.last_login_at,
  };
}

export function signAccessToken(user, secret) {
  return jwt.sign(
    { role: user.role, ver: user.session_version },
    secret,
    {
      algorithm: 'HS256',
      subject: String(user.id),
      issuer: 'zenenergies-api',
      audience: 'zenenergies-web',
      expiresIn: '30m',
    },
  );
}

export function authMiddleware({ db, jwtSecret }) {
  const selectUser = createUserSelector(db);
  return (req, _res, next) => {
    const header = req.get('authorization');
    if (!header?.startsWith('Bearer ')) return next(unauthorized());
    const token = header.slice(7).trim();
    if (!token) return next(unauthorized());

    try {
      const payload = tokenPayloadSchema.parse(jwt.verify(token, jwtSecret, {
        algorithms: ['HS256'],
        issuer: 'zenenergies-api',
        audience: 'zenenergies-web',
      }));
      const user = selectUser.get(payload.sub);
      if (!user || !user.is_active || user.role !== payload.role || user.session_version !== payload.ver) {
        return next(unauthorized('Session is no longer valid'));
      }
      const requestPath = req.originalUrl.split('?')[0];
      const passwordChangePaths = new Set([
        '/api/auth/me',
        '/api/auth/change-password',
        '/api/settings',
        '/api/settings/password',
      ]);
      if (user.must_change_password && !passwordChangePaths.has(requestPath)) {
        return next(new AppError(403, 'PASSWORD_CHANGE_REQUIRED', 'Password change is required before using the station API'));
      }
      req.auth = { user, tokenVersion: payload.ver };
      if (user.role === 'admin' && req.method === 'GET') {
        recordAudit(db, {
          req,
          category: 'admin',
          event: 'admin.resource_accessed',
          metadata: { method: req.method, path: `${req.baseUrl}${req.path}` },
        });
      }
      return next();
    } catch {
      return next(unauthorized('Invalid or expired access token'));
    }
  };
}

export function requireAdmin(req, _res, next) {
  if (req.auth?.user?.role !== 'admin') return next(forbidden('Administrator access is required'));
  return next();
}

export function requireSelfOrAdmin(userId) {
  return (req, _res, next) => {
    const actor = req.auth.user;
    if (actor.role !== 'admin' && actor.id !== Number(userId)) return next(forbidden());
    return next();
  };
}
