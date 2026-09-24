import { Hono } from 'hono';
import { auditForContext } from './audit';
import { getDateRange, todayInTimezone } from './date';
import { first } from './db';
import { money } from './http';
import { lowStockAlerts } from './fuel';
import { getSettings } from './settings';
import { getOpenShift } from './shifts';
import type { AppEnv, AppContext, DbRow } from './types';

export function dashboardRouter(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.get('/', async (c) => {
    const actor = c.get('auth');
    const settings = await getSettings(c.env.DB);
    const date = todayInTimezone(settings.timezone);
    const range = getDateRange(date, date, settings.timezone);
    if (actor.role === 'admin') {
      const sales = await first<DbRow>(c.env.DB, `
        SELECT COUNT(*) AS count, COALESCE(SUM(litres), 0) AS litres,
          COALESCE(SUM(total_cents), 0) AS total_cents, COALESCE(SUM(cash_cents), 0) AS cash_cents,
          COALESCE(SUM(mpesa_cents), 0) AS mpesa_cents,
          COALESCE(SUM(CAST(ROUND(litres * unit_cost_cents) AS INTEGER)), 0) AS cogs_cents
        FROM sales WHERE sold_at >= ? AND sold_at <= ?
      `, range.startUtc, range.endUtc);
      const expenses = await first<DbRow>(c.env.DB, 'SELECT COALESCE(SUM(amount_cents), 0) AS total_cents FROM expenses WHERE expense_date = ?', date);
      const shifts = await first<DbRow>(c.env.DB, "SELECT COUNT(*) AS count FROM shifts WHERE status = 'open'");
      const audit = auditForContext(c, { category: 'admin', event: 'admin.dashboard_viewed', metadata: { date } });
      await c.env.DB.prepare(audit.sql).bind(...audit.bindings).run();
      return c.json({
        role: 'admin', date, financialHidden: false, currency: 'KSh',
        today: {
          salesCount: Number(sales?.count || 0), litresSold: Number(sales?.litres || 0),
          salesKsh: money(Number(sales?.total_cents || 0)), cashKsh: money(Number(sales?.cash_cents || 0)),
          mpesaKsh: money(Number(sales?.mpesa_cents || 0)), cogsKsh: money(Number(sales?.cogs_cents || 0)),
          expensesKsh: money(Number(expenses?.total_cents || 0)),
          netKsh: money(Number(sales?.total_cents || 0) - Number(sales?.cogs_cents || 0) - Number(expenses?.total_cents || 0)),
        },
        openShiftCount: Number(shifts?.count || 0), lowStockAlerts: await lowStockAlerts(c.env.DB),
      });
    }
    const own = await first<DbRow>(c.env.DB, `
      SELECT COUNT(*) AS count, COALESCE(SUM(litres), 0) AS litres FROM sales
      WHERE user_id = ? AND sold_at >= ? AND sold_at <= ?
    `, actor.id, range.startUtc, range.endUtc);
    const open = await getOpenShift(c.env.DB, actor.id);
    return c.json({
      role: 'attendant', date, financialHidden: true,
      user: { id: actor.id, fullName: actor.full_name, status: actor.is_active ? 'active' : 'inactive' },
      openShift: open ? { id: Number(open.id), status: open.status, openedAt: open.opened_at } : null,
      ownToday: { saleCount: Number(own?.count || 0), litresSold: Number(own?.litres || 0) },
    });
  });
  return app;
}
