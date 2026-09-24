import bcrypt from 'bcryptjs';
import { Router } from 'express';
import { DateTime } from 'luxon';
import { z } from 'zod';
import { asyncHandler } from '../lib/http.js';
import { badRequest, unauthorized, forbidden } from '../lib/errors.js';
import { validate } from '../middleware/validate.js';
import { recordAudit } from '../services/audit.js';
import { validatePassword } from '../services/bootstrap.js';
import { adminSettings, getSettings, publicSettings, upsertSettings, userSettings } from '../services/settings.js';
import { getLowStockAlerts } from '../services/inventory.js';

const updateSchema = z.object({
  stationName: z.string().trim().min(2).max(100).optional(),
  timezone: z.string().trim().min(1).max(100).optional(),
  dateFormat: z.enum(['yyyy-MM-dd', 'dd/MM/yyyy', 'MM/dd/yyyy']).optional(),
  language: z.enum(['en', 'sw']).optional(),
  lowStockThresholdLitres: z.number().finite().nonnegative().max(10000000).optional(),
  auditRetentionDays: z.number().int().min(30).max(3650).optional(),
  interfaceOptions: z.object({
    theme: z.enum(['system', 'light', 'dark']).optional(),
    compactTables: z.boolean().optional(),
    showStationClock: z.boolean().optional(),
  }).strict().optional(),
  notifications: z.object({
    lowStock: z.boolean().optional(),
    shiftReminders: z.boolean().optional(),
    dailySummary: z.boolean().optional(),
    salesAlerts: z.boolean().optional(),
  }).strict().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, 'At least one field is required').superRefine((value, context) => {
  if (value.timezone && !DateTime.local().setZone(value.timezone).isValid) {
    context.addIssue({ code: 'custom', path: ['timezone'], message: 'timezone must be a valid IANA timezone' });
  }
});

const resetSchema = z.object({
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

export function createPublicSettingsRouter({ db }) {
  const router = Router();
  router.get('/', (_req, res) => res.json({ settings: publicSettings(db), currency: 'KSh' }));
  return router;
}

export function createSettingsRouter({ db, config }) {
  const router = Router();

  router.get('/', (req, res) => {
    res.json({ settings: req.auth.user.role === 'admin' ? adminSettings(db) : userSettings(db, req.auth.user) });
  });

  router.post('/password', validate(resetSchema), asyncHandler(async (req, res) => {
    const user = db.prepare('SELECT * FROM users WHERE id = ?').get(req.auth.user.id);
    if (!await bcrypt.compare(req.body.currentPassword, user.password_hash)) throw unauthorized('Current password is incorrect');
    if (await bcrypt.compare(req.body.newPassword, user.password_hash)) throw badRequest('New password must be different from the current password');
    const hash = await bcrypt.hash(req.body.newPassword, 12);
    const updated = db.transaction(() => {
      db.prepare(`
        UPDATE users SET password_hash = ?, session_version = session_version + 1, must_change_password = 0,
          password_changed_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ?
      `).run(hash, user.id);
      recordAudit(db, { req, category: 'auth', event: 'auth.password_reset_completed', metadata: { targetUserId: user.id } });
      return db.prepare('SELECT id, username, full_name, role, is_active, session_version, must_change_password FROM users WHERE id = ?').get(user.id);
    })();
    res.json({ reset: true, user: { id: updated.id, username: updated.username, fullName: updated.full_name, role: updated.role }, tokenRequired: true });
  }));

  router.patch('/', validate(updateSchema), (req, res, next) => {
    if (req.auth.user.role !== 'admin') return next(forbidden('Administrator access is required'));
    const updates = { ...req.body };
    if (updates.interfaceOptions) {
      updates.interfaceOptions = { ...getSettings(db).interfaceOptions, ...updates.interfaceOptions };
    }
    if (updates.notifications) {
      updates.notifications = { ...getSettings(db).notifications, ...updates.notifications };
    }
    db.transaction(() => {
      upsertSettings(db, updates, req.auth.user.id);
      recordAudit(db, { req, category: 'settings', event: 'settings.updated', metadata: { fields: Object.keys(req.body) } });
    })();
    res.json({ settings: adminSettings(db), lowStockAlerts: getLowStockAlerts(db) });
  });

  return router;
}
