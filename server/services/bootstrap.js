import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { recordAudit } from './audit.js';

export const passwordSchema = z.string()
  .min(12, 'Password must be at least 12 characters')
  .max(128, 'Password cannot exceed 128 characters')
  .regex(/[a-z]/, 'Password must contain a lowercase letter')
  .regex(/[A-Z]/, 'Password must contain an uppercase letter')
  .regex(/\d/, 'Password must contain a number')
  .regex(/[^A-Za-z0-9]/, 'Password must contain a symbol')
  .refine((value) => !/(password|admin|station|welcome|qwerty)/i.test(value), 'Password is too predictable');

export const usernameSchema = z.string()
  .trim()
  .min(3)
  .max(32)
  .regex(/^[A-Za-z0-9._-]+$/, 'Username may contain letters, numbers, dots, underscores, and hyphens')
  .regex(/[A-Za-z]/, 'Username must contain a letter');

export function validateAdminCredentials(username, password) {
  return {
    username: usernameSchema.parse(username),
    password: passwordSchema.parse(password),
  };
}

export function validatePassword(password) {
  return passwordSchema.parse(password);
}

export async function bootstrapAdmin(db, config, logger) {
  if (db.prepare('SELECT 1 FROM users LIMIT 1').get()) return null;
  if (!config.adminUsername || !config.adminPassword) {
    if (config.isProduction) {
      logger?.warn('No users exist; set ADMIN_USERNAME and ADMIN_PASSWORD once to bootstrap the first administrator');
    }
    return null;
  }

  let credentials;
  try {
    credentials = validateAdminCredentials(config.adminUsername, config.adminPassword);
  } catch (error) {
    throw new Error(`ADMIN_USERNAME/ADMIN_PASSWORD bootstrap validation failed: ${error.message}`);
  }
  const fullName = z.string().trim().min(2).max(100).parse(config.adminFullName);
  const passwordHash = await bcrypt.hash(credentials.password, 12);

  return db.transaction(() => {
    if (db.prepare('SELECT 1 FROM users LIMIT 1').get()) return null;
    const result = db.prepare(`
      INSERT INTO users (username, password_hash, full_name, role, must_change_password, password_changed_at)
      VALUES (?, ?, ?, 'admin', 1, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    `).run(credentials.username, passwordHash, fullName);
    recordAudit(db, {
      actorId: Number(result.lastInsertRowid),
      actorUsername: credentials.username,
      category: 'admin',
      event: 'admin.bootstrap',
      metadata: { userId: Number(result.lastInsertRowid), username: credentials.username, source: 'environment' },
    });
    logger?.warn({ username: credentials.username }, 'First administrator bootstrapped; password change is required');
    return Number(result.lastInsertRowid);
  })();
}
