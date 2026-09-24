import bcrypt from 'bcryptjs';
import { Router } from 'express';
import { z } from 'zod';
import { asyncHandler, getPagination, paginated } from '../lib/http.js';
import { badRequest, conflict, notFound } from '../lib/errors.js';
import { validate } from '../middleware/validate.js';
import { safeUser } from '../middleware/auth.js';
import { recordAudit } from '../services/audit.js';
import { passwordSchema, usernameSchema } from '../services/bootstrap.js';

const listSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  role: z.enum(['admin', 'attendant']).optional(),
  isActive: z.enum(['true', 'false']).transform((value) => value === 'true').optional(),
  search: z.string().trim().max(100).optional(),
}).strict();

const createSchema = z.object({
  username: usernameSchema,
  password: passwordSchema,
  fullName: z.string().trim().min(2).max(100),
  role: z.enum(['admin', 'attendant']),
  mustChangePassword: z.boolean().default(true),
}).strict();

const updateSchema = z.object({
  fullName: z.string().trim().min(2).max(100).optional(),
  role: z.enum(['admin', 'attendant']).optional(),
  isActive: z.boolean().optional(),
  mustChangePassword: z.boolean().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, 'At least one field is required');

const passwordResetSchema = z.object({ newPassword: passwordSchema }).strict();

function userById(db, id) {
  const user = db.prepare(`
    SELECT id, username, full_name, role, is_active, session_version, must_change_password, created_at, updated_at, last_login_at
    FROM users WHERE id = ?
  `).get(id);
  if (!user) throw notFound('User was not found');
  return user;
}

function activeAdminCount(db, excludingId) {
  return db.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND is_active = 1 AND id != ?").get(excludingId).count;
}

export function createUsersRouter({ db }) {
  const router = Router();

  router.get('/', validate(listSchema, 'query'), (req, res) => {
    const { page, pageSize, role, isActive, search } = req.validatedQuery;
    const pagination = getPagination(req.validatedQuery);
    const where = [];
    const params = [];
    if (role) { where.push('role = ?'); params.push(role); }
    if (isActive !== undefined) { where.push('is_active = ?'); params.push(isActive ? 1 : 0); }
    if (search) { where.push('(username LIKE ? ESCAPE \'\\\' OR full_name LIKE ? ESCAPE \'\\\')'); params.push(`%${search.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`, `%${search.replaceAll('\\', '\\\\').replaceAll('%', '\\%').replaceAll('_', '\\_')}%`); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const rows = db.prepare(`SELECT * FROM users ${clause} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...params, pageSize, pagination.offset);
    const total = db.prepare(`SELECT COUNT(*) AS count FROM users ${clause}`).get(...params).count;
    recordAudit(db, { req, category: 'admin', event: 'admin.users_listed', metadata: { page, pageSize, role: role || null } });
    res.json(paginated(rows, total, pagination, safeUser));
  });

  router.get('/:id', (req, res) => {
    const user = userById(db, Number(req.params.id));
    recordAudit(db, { req, category: 'admin', event: 'admin.user_viewed', metadata: { targetUserId: user.id } });
    res.json({ user: safeUser(user) });
  });

  router.post('/', validate(createSchema), asyncHandler(async (req, res) => {
    const body = req.body;
    if (db.prepare('SELECT 1 FROM users WHERE username = ? COLLATE NOCASE').get(body.username)) {
      throw conflict('Username is already in use');
    }
    const passwordHash = await bcrypt.hash(body.password, 12);
    const id = db.transaction(() => {
      const result = db.prepare(`
        INSERT INTO users (username, password_hash, full_name, role, is_active, must_change_password, created_by, password_changed_at)
        VALUES (?, ?, ?, ?, 1, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
      `).run(body.username, passwordHash, body.fullName, body.role, body.mustChangePassword ? 1 : 0, req.auth.user.id);
      const userId = Number(result.lastInsertRowid);
      recordAudit(db, { req, category: 'admin', event: 'admin.user_created', metadata: { targetUserId: userId, role: body.role } });
      return userId;
    })();
    res.status(201).json({ user: safeUser(userById(db, id)) });
  }));

  router.patch('/:id', validate(updateSchema), (req, res) => {
    const id = Number(req.params.id);
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!user) throw notFound('User was not found');
    const nextRole = req.body.role ?? user.role;
    const nextActive = req.body.isActive ?? Boolean(user.is_active);
    if (user.id === req.auth.user.id && (nextRole !== 'admin' || !nextActive)) {
      throw badRequest('You cannot remove your own administrator access');
    }
    if (user.role === 'admin' && user.is_active && (nextRole !== 'admin' || !nextActive) && activeAdminCount(db, user.id) === 0) {
      throw conflict('At least one active administrator is required');
    }

    db.transaction(() => {
      db.prepare(`
        UPDATE users
        SET full_name = ?, role = ?, is_active = ?, must_change_password = ?,
            session_version = CASE WHEN role != ? OR is_active != ? THEN session_version + 1 ELSE session_version END,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ?
      `).run(
        req.body.fullName ?? user.full_name,
        nextRole,
        nextActive ? 1 : 0,
        req.body.mustChangePassword === undefined ? user.must_change_password : (req.body.mustChangePassword ? 1 : 0),
        nextRole,
        nextActive ? 1 : 0,
        id,
      );
      recordAudit(db, { req, category: 'admin', event: 'admin.user_updated', metadata: { targetUserId: id, fields: Object.keys(req.body) } });
    })();
    res.json({ user: safeUser(userById(db, id)) });
  });

  router.delete('/:id', (req, res) => {
    const id = Number(req.params.id);
    if (id === req.auth.user.id) throw badRequest('You cannot delete your own account');
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!user) throw notFound('User was not found');
    if (user.role === 'admin' && user.is_active && activeAdminCount(db, id) === 0) {
      throw conflict('At least one active administrator is required');
    }
    db.transaction(() => {
      db.prepare(`
        UPDATE users SET is_active = 0, session_version = session_version + 1,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?
      `).run(id);
      recordAudit(db, {
        req,
        category: 'admin',
        event: 'admin.user_deleted',
        metadata: { targetUserId: id, targetUsername: user.username, mode: 'deactivated_to_preserve_history' },
      });
    })();
    res.json({ deleted: true, softDeleted: true, user: safeUser(userById(db, id)) });
  });

  router.post('/:id/reset-password', validate(passwordResetSchema), asyncHandler(async (req, res) => {
    const id = Number(req.params.id);
    const user = userById(db, id);
    const passwordHash = await bcrypt.hash(req.body.newPassword, 12);
    db.transaction(() => {
      db.prepare(`
        UPDATE users
        SET password_hash = ?, session_version = session_version + 1, must_change_password = 1,
            password_changed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ?
      `).run(passwordHash, id);
      recordAudit(db, { req, category: 'admin', event: 'admin.user_password_reset', metadata: { targetUserId: id, targetUsername: user.username } });
    })();
    res.json({ user: safeUser(userById(db, id)), sessionsTerminated: true });
  }));

  router.post('/:id/terminate', (req, res) => {
    const id = Number(req.params.id);
    const user = userById(db, id);
    db.transaction(() => {
      db.prepare(`
        UPDATE users
        SET session_version = session_version + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ?
      `).run(id);
      recordAudit(db, { req, category: 'admin', event: 'admin.user_sessions_terminated', metadata: { targetUserId: id, targetUsername: user.username } });
    })();
    res.json({ user: safeUser(userById(db, id)), sessionsTerminated: true });
  });

  return router;
}
