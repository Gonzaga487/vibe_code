import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';
import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { asyncHandler } from '../lib/http.js';
import { badRequest, unauthorized } from '../lib/errors.js';
import { validate } from '../middleware/validate.js';
import { safeUser, signAccessToken } from '../middleware/auth.js';
import { recordAudit } from '../services/audit.js';
import { validatePassword } from '../services/bootstrap.js';

const loginSchema = z.object({
  username: z.string().trim().min(1).max(32),
  password: z.string().min(1).max(128),
  role: z.enum(['admin', 'attendant']),
}).strict();

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1).max(128),
  newPassword: z.string().max(128),
  confirmPassword: z.string().max(128).optional(),
  confirmNewPassword: z.string().max(128).optional(),
}).strict().superRefine((value, context) => {
  try {
    validatePassword(value.newPassword);
  } catch (error) {
    context.addIssue({ code: 'custom', path: ['newPassword'], message: error.issues[0]?.message || 'New password is not strong enough' });
  }
  const confirmation = value.confirmPassword ?? value.confirmNewPassword;
  if (!confirmation) {
    context.addIssue({ code: 'custom', path: ['confirmPassword'], message: 'Password confirmation is required' });
  } else if (confirmation !== value.newPassword) {
    context.addIssue({ code: 'custom', path: ['confirmPassword'], message: 'Password confirmation does not match' });
  }
});

export function createAuthRouter({ db, config, authenticate }) {
  const router = Router();
  const dummyHash = bcrypt.hashSync(crypto.randomBytes(32).toString('hex'), 12);
  const selectLoginUser = db.prepare('SELECT * FROM users WHERE username = ? COLLATE NOCASE');
  const updateLogin = db.prepare(`
    UPDATE users SET last_login_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?
  `);

  router.post('/login', validate(loginSchema), asyncHandler(async (req, res) => {
    const { username, password, role } = req.body;
    const user = selectLoginUser.get(username);
    const passwordMatches = await bcrypt.compare(password, user?.password_hash || dummyHash);
    if (!user || !passwordMatches || !user.is_active || user.role !== role) {
      recordAudit(db, {
        req,
        actorId: user?.id || null,
        actorUsername: user?.username || username,
        category: 'auth',
        event: 'auth.login_failed',
        metadata: { submittedRole: role, reason: 'invalid_credentials_or_role' },
      });
      throw unauthorized('Invalid username, password, or role');
    }

    db.transaction(() => {
      updateLogin.run(user.id);
      recordAudit(db, { req, category: 'auth', event: 'auth.login_succeeded', metadata: { role: user.role } });
    })();
    const current = db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
    res.json({ token: signAccessToken(current, config.jwtSecret), expiresIn: 1800, user: safeUser(current) });
  }));

  router.get('/me', authenticate, (req, res) => {
    res.json({ user: safeUser(req.auth.user) });
  });

  router.post('/change-password', authenticate, validate(changePasswordSchema), asyncHandler(async (req, res) => {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.auth.user.id);
    if (!await bcrypt.compare(req.body.currentPassword, user.password_hash)) {
      recordAudit(db, { req, category: 'auth', event: 'auth.password_change_failed', metadata: {} });
      throw unauthorized('Current password is incorrect');
    }
    if (await bcrypt.compare(req.body.newPassword, user.password_hash)) {
      throw badRequest('New password must be different from the current password');
    }
    const passwordHash = await bcrypt.hash(req.body.newPassword, 12);
    const updated = db.transaction(() => {
      db.prepare(`
        UPDATE users
        SET password_hash = ?, session_version = session_version + 1, must_change_password = 0,
            password_changed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ?
      `).run(passwordHash, user.id);
      recordAudit(db, { req, category: 'auth', event: 'auth.password_changed', metadata: { targetUserId: user.id } });
      return db.prepare('SELECT * FROM users WHERE id = ?').get(user.id);
    })();
    res.json({ token: signAccessToken(updated, config.jwtSecret), expiresIn: 1800, user: safeUser(updated) });
  }));

  return router;
}
