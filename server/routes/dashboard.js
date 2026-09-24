import { Router } from 'express';
import { DateTime } from 'luxon';
import { money } from '../lib/http.js';
import { recordAudit } from '../services/audit.js';
import { getLowStockAlerts } from '../services/inventory.js';
import { getDateRange, getSettings } from '../services/settings.js';
import { getOpenShift, serializeShift } from './shifts.js';

export function createDashboardRouter({ db }) {
  const router = Router();

  router.get('/', (req, res) => {
    const actor = req.auth.user;
    const settings = getSettings(db);
    const date = DateTime.now().setZone(settings.timezone).toISODate();
    const { startUtc, endUtc } = getDateRange(db, date, date);

    if (actor.role === 'admin') {
      const sales = db.prepare(`
        SELECT COUNT(*) AS count, COALESCE(SUM(litres), 0) AS litres,
               COALESCE(SUM(total_cents), 0) AS total_cents,
               COALESCE(SUM(cash_cents), 0) AS cash_cents,
               COALESCE(SUM(mpesa_cents), 0) AS mpesa_cents,
               COALESCE(SUM(CAST(ROUND(litres * unit_cost_cents) AS INTEGER)), 0) AS cogs_cents
        FROM sales WHERE sold_at >= ? AND sold_at <= ?
      `).get(startUtc, endUtc);
      const expenses = db.prepare(`
        SELECT COALESCE(SUM(amount_cents), 0) AS total_cents
        FROM expenses WHERE expense_date = ?
      `).get(date).total_cents;
      const openShifts = db.prepare("SELECT COUNT(*) AS count FROM shifts WHERE status = 'open'").get().count;
      recordAudit(db, { req, category: 'admin', event: 'admin.dashboard_viewed', metadata: { date } });
      res.json({
        role: 'admin',
        date,
        financialHidden: false,
        currency: 'KSh',
        today: {
          salesCount: sales.count,
          litresSold: sales.litres,
          salesKsh: money(sales.total_cents),
          cashKsh: money(sales.cash_cents),
          mpesaKsh: money(sales.mpesa_cents),
          cogsKsh: money(sales.cogs_cents),
          expensesKsh: money(expenses),
          netKsh: money(sales.total_cents - sales.cogs_cents - expenses),
        },
        openShiftCount: openShifts,
        lowStockAlerts: getLowStockAlerts(db),
      });
      return;
    }

    const ownToday = db.prepare(`
      SELECT COUNT(*) AS count, COALESCE(SUM(litres), 0) AS litres
      FROM sales WHERE user_id = ? AND sold_at >= ? AND sold_at <= ?
    `).get(actor.id, startUtc, endUtc);
    const open = getOpenShift(db, actor.id);
    res.json({
      role: 'attendant',
      user: { id: actor.id, fullName: actor.full_name, status: actor.is_active ? 'active' : 'inactive' },
      date,
      financialHidden: true,
      openShift: open ? { id: open.id, status: open.status, openedAt: open.opened_at } : null,
      ownToday: { saleCount: ownToday.count, litresSold: ownToday.litres },
    });
  });

  return router;
}
