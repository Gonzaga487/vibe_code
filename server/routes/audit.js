import { Router } from 'express';
import { z } from 'zod';
import { DateTime } from 'luxon';
import { getPagination, paginated } from '../lib/http.js';
import { validate } from '../middleware/validate.js';
import { recordAudit, serializeAudit } from '../services/audit.js';
import { getSettings } from '../services/settings.js';

const listSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  category: z.enum(['auth', 'admin', 'sale', 'shift', 'inventory', 'reading', 'expense', 'settings', 'system']).optional(),
  event: z.string().trim().min(1).max(100).optional(),
  actorId: z.coerce.number().int().positive().optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
}).strict().refine((value) => !value.from || !value.to || value.from <= value.to, 'from cannot be after to');

const wipeSchema = z.object({
  confirmation: z.literal('WIPE AUDIT LOGS'),
  retentionDays: z.number().int().min(1).max(3650).optional(),
  wipeAll: z.boolean().default(false),
}).strict();

export function createAuditRouter({ db }) {
  const router = Router();

  router.get('/', validate(listSchema, 'query'), (req, res) => {
    const filters = req.validatedQuery;
    const pagination = getPagination(filters);
    const where = [];
    const params = [];
    if (filters.category) { where.push('category = ?'); params.push(filters.category); }
    if (filters.event) { where.push('event LIKE ?'); params.push(`%${filters.event}%`); }
    if (filters.actorId) { where.push('actor_id = ?'); params.push(filters.actorId); }
    if (filters.from) { where.push('date(created_at) >= ?'); params.push(filters.from); }
    if (filters.to) { where.push('date(created_at) <= ?'); params.push(filters.to); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const rows = db.prepare(`SELECT * FROM audit_logs ${clause} ORDER BY created_at DESC, id DESC LIMIT ? OFFSET ?`).all(...params, pagination.pageSize, pagination.offset);
    const total = db.prepare(`SELECT COUNT(*) AS count FROM audit_logs ${clause}`).get(...params).count;
    recordAudit(db, { req, category: 'admin', event: 'admin.audit_viewed', metadata: { page: filters.page, pageSize: filters.pageSize, category: filters.category || null } });
    res.json(paginated(rows, total, pagination, serializeAudit));
  });

  router.post('/wipe', validate(wipeSchema), (req, res) => {
    const configuredRetention = getSettings(db).auditRetentionDays;
    const retentionDays = req.body.retentionDays ?? configuredRetention;
    const cutoff = DateTime.utc().minus({ days: retentionDays }).toISO();
    const result = db.transaction(() => {
      const deleted = req.body.wipeAll
        ? db.prepare('DELETE FROM audit_logs').run()
        : db.prepare('DELETE FROM audit_logs WHERE created_at < ?').run(cutoff);
      recordAudit(db, {
        req,
        category: 'admin',
        event: 'admin.audit_wiped',
        metadata: { deleted: deleted.changes, retentionDays: req.body.wipeAll ? null : retentionDays, wipeAll: req.body.wipeAll },
        prune: false,
      });
      return Number(deleted.changes);
    })();
    res.json({ wiped: true, deleted: result, preservedActionEvent: true });
  });

  return router;
}
