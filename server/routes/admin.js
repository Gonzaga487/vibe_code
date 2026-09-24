import fs from 'node:fs';
import { Router } from 'express';
import { AppError } from '../lib/errors.js';
import { z } from 'zod';
import { money } from '../lib/http.js';
import { validate } from '../middleware/validate.js';
import { recordAudit } from '../services/audit.js';
import { createSnapshot, restoreSnapshot, validateSnapshot } from '../services/backup.js';
import { databaseIntegrityCheck } from '../db/index.js';

const restoreBodySchema = z.object({ snapshot: z.unknown() }).strict();
const clearSchema = z.object({
  confirmation: z.literal('CLEAR OPERATIONAL DATA'),
  force: z.boolean().default(false),
  forceConfirmation: z.literal('FORCE CLEAR OPERATIONAL DATA').optional(),
}).strict();

export function createAdminRouter({ db, config }) {
  const router = Router();

  router.get('/backup', (req, res) => {
    recordAudit(db, { req, category: 'admin', event: 'admin.backup_downloaded', metadata: {} });
    const snapshot = createSnapshot(db, config.schemaVersion);
    const serialized = JSON.stringify(snapshot, null, 2);
    if (Buffer.byteLength(serialized, 'utf8') > 24 * 1024 * 1024) {
      throw new AppError(413, 'BACKUP_TOO_LARGE', 'The snapshot exceeds the 24 MB safe backup/restore limit');
    }
    const date = snapshot.exportedAt.slice(0, 10);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="zenenergies-backup-${date}.json"`);
    res.send(serialized);
  });

  router.post('/restore', validate(restoreBodySchema), (req, res) => {
    const snapshot = validateSnapshot(db, req.body.snapshot, {
      schemaVersion: config.schemaVersion,
      requiredAdmin: {
        id: req.auth.user.id,
        username: req.auth.user.username,
        role: req.auth.user.role,
        sessionVersion: req.auth.user.session_version,
      },
    });
    const counts = restoreSnapshot(db, snapshot, { req, schemaVersion: config.schemaVersion });
    res.json({ restored: true, schemaVersion: config.schemaVersion, counts });
  });

  router.post('/clear-operational-data', validate(clearSchema), (req, res) => {
    const openShiftCount = db.prepare("SELECT COUNT(*) AS count FROM shifts WHERE status = 'open'").get().count;
    if (openShiftCount && (!req.body.force || req.body.forceConfirmation !== 'FORCE CLEAR OPERATIONAL DATA')) {
      throw new AppError(409, 'OPEN_SHIFTS_EXIST', 'Close open shifts before clearing operational data, or provide forceConfirmation explicitly');
    }
    const tables = [
      'inventory_allocations',
      'inventory_movements',
      'inventory_lots',
      'sales_readings',
      'pump_readings',
      'expenses',
      'sales',
      'stock_adjustments',
      'restocks',
      'shifts',
    ];
    const sequenceTables = [...tables];
    const counts = db.transaction(() => {
      const removed = {};
      for (const table of tables) removed[table] = Number(db.prepare(`DELETE FROM "${table}"`).run().changes);
      db.prepare('UPDATE fuel_management SET quantity = 0, stock_litres = 0, weighted_average_cost_cents = 0, updated_at = strftime(\'%Y-%m-%dT%H:%M:%fZ\', \'now\')').run();
      const placeholders = sequenceTables.map(() => '?').join(',');
      db.prepare(`DELETE FROM sqlite_sequence WHERE name IN (${placeholders})`).run(...sequenceTables);
      recordAudit(db, {
        req,
        category: 'admin',
        event: 'admin.operational_data_cleared',
        metadata: { deleted: removed, forced: Boolean(req.body.force), openShiftCount },
      });
      return removed;
    })();
    res.json({ cleared: true, excluded: ['users', 'app_settings', 'audit_logs', 'fuel_management', 'pumps'], counts });
  });

  router.get('/metrics', (req, res) => {
    const users = db.prepare(`
      SELECT COUNT(*) AS total,
        SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) AS active,
        SUM(CASE WHEN role = 'admin' AND is_active = 1 THEN 1 ELSE 0 END) AS active_admins
      FROM users
    `).get();
    const sales = db.prepare('SELECT COUNT(*) AS count, COALESCE(SUM(total_cents), 0) AS total_cents, COALESCE(SUM(litres), 0) AS litres FROM sales').get();
    const shifts = db.prepare("SELECT COUNT(*) AS total, SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) AS open FROM shifts").get();
    const fuel = db.prepare(`
      SELECT COUNT(*) AS fuel_types, COALESCE(SUM(quantity), 0) AS litres,
        COALESCE(SUM(CAST(ROUND(quantity * weighted_average_cost_cents) AS INTEGER)), 0) AS value_cents
      FROM fuel_management WHERE is_active = 1
    `).get();
    let databaseBytes = null;
    if (config.databasePath !== ':memory:') {
      try { databaseBytes = fs.statSync(config.databasePath).size; } catch { databaseBytes = null; }
    }
    const metrics = {
      application: { environment: config.nodeEnv, schemaVersion: config.schemaVersion, uptimeSeconds: Math.round(process.uptime()) },
      database: { path: config.databasePath === ':memory:' ? ':memory:' : 'configured SQLite file', bytes: databaseBytes, integrity: databaseIntegrityCheck(db) },
      users: { total: users.total, active: users.active, activeAdmins: users.active_admins },
      operations: {
        salesCount: sales.count,
        lifetimeSalesKsh: money(sales.total_cents),
        lifetimeLitresSold: sales.litres,
        shifts: { total: shifts.total, open: shifts.open },
        fuel: { fuelTypes: fuel.fuel_types, litres: fuel.litres, inventoryValueKsh: money(fuel.value_cents) },
      },
      auditLogCount: db.prepare('SELECT COUNT(*) AS count FROM audit_logs').get().count,
    };
    recordAudit(db, { req, category: 'admin', event: 'admin.platform_metrics_viewed', metadata: {} });
    res.json({ metrics });
  });

  return router;
}
