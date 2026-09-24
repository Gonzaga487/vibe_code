import { Hono } from 'hono';
import { auditForContext } from './audit';
import { dateDifferenceDays, dateKey, getDateRange } from './date';
import { badRequest } from './errors';
import { money } from './http';
import { getSettings } from './settings';
import { calendarQuerySchema, parseQuery } from './validators';
import type { AppEnv, AppContext, DbRow, Role } from './types';

function baseEvent(type: string, id: string | number, occurredAt: string, date: string, label: string, event: string, status: string, color: string, role: Role): Record<string, unknown> {
  return {
    id: `${type}:${id}`,
    type,
    event,
    occurredAt,
    date,
    label,
    status,
    color,
    financialHidden: role !== 'admin',
  };
}

export function calendarRouter(): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.get('/', async (c) => {
    const actor = c.get('auth');
    const { from, to } = parseQuery(c, calendarQuerySchema);
    if (dateDifferenceDays(from, to) > 92) throw badRequest('Calendar range cannot exceed 93 days');
    const settings = await getSettings(c.env.DB);
    const range = getDateRange(from, to, settings.timezone);
    const days = new Map<string, Record<string, unknown>>();
    for (const date of Array.from({ length: dateDifferenceDays(from, to) + 1 }, (_, index) => {
      const value = new Date(Date.parse(`${from}T00:00:00Z`) + index * 86_400_000).toISOString().slice(0, 10);
      return value;
    })) {
      days.set(date, { date, sales: 0, restocks: 0, expenses: 0, shiftOpened: 0, shiftClosed: 0, financialHidden: actor.role !== 'admin' });
    }
    const events: Array<Record<string, unknown>> = [];
    const roleClause = actor.role === 'admin' ? '' : ' AND user_id = ?';
    const roleBindings: number[] = actor.role === 'admin' ? [] : [actor.id];

    const sales = await c.env.DB.prepare(`
      SELECT id, sold_at, user_id, fuel_id, fuel_type, amount_cents, mode, pump_id, payment_method
      FROM sales WHERE sold_at >= ? AND sold_at <= ?${roleClause} ORDER BY sold_at, id
    `).bind(range.startUtc, range.endUtc, ...roleBindings).all<DbRow>();
    for (const row of sales.results) {
      const date = dateKey(String(row.sold_at), settings.timezone);
      if (!days.has(date)) continue;
      const event = baseEvent('sale', Number(row.id), String(row.sold_at), date, `Sale #${row.id}`, 'created', 'recorded', 'orange', actor.role);
      event.mode = row.mode;
      event.fuelType = row.fuel_type;
      event.pumpId = row.pump_id;
      if (actor.role === 'admin') event.financialData = { amountKsh: money(Number(row.amount_cents)), paymentMethod: row.payment_method };
      events.push(event);
      const day = days.get(date);
      if (day) day.sales = Number(day.sales) + 1;
    }

    if (actor.role === 'admin') {
      const restocks = await c.env.DB.prepare(`
        SELECT id, timestamp, fuel_id, fuel_type, litres_added, total_cost_cents
        FROM restocks WHERE timestamp >= ? AND timestamp <= ? ORDER BY timestamp, id
      `).bind(range.startUtc, range.endUtc).all<DbRow>();
      for (const row of restocks.results) {
        const date = dateKey(String(row.timestamp), settings.timezone);
        if (!days.has(date)) continue;
        const event = baseEvent('restock', Number(row.id), String(row.timestamp), date, `Restock #${row.id}`, 'created', 'recorded', 'green', actor.role);
        event.fuelType = row.fuel_type;
        event.litresAdded = Number(row.litres_added);
        event.financialData = { amountKsh: money(Number(row.total_cost_cents)) };
        events.push(event);
        const day = days.get(date);
        if (day) day.restocks = Number(day.restocks) + 1;
      }
    }

    const expenses = await c.env.DB.prepare(`
      SELECT id, timestamp, expense_date, user_id, category, amount_cents, payment_method
      FROM expenses WHERE expense_date >= ? AND expense_date <= ?${roleClause} ORDER BY timestamp, id
    `).bind(from, to, ...roleBindings).all<DbRow>();
    for (const row of expenses.results) {
      const date = String(row.expense_date);
      if (!days.has(date)) continue;
      const event = baseEvent('expense', Number(row.id), String(row.timestamp), date, `Expense #${row.id}`, 'created', 'recorded', 'red', actor.role);
      event.category = row.category;
      if (actor.role === 'admin') event.financialData = { amountKsh: money(Number(row.amount_cents)), paymentMethod: row.payment_method };
      events.push(event);
      const day = days.get(date);
      if (day) day.expenses = Number(day.expenses) + 1;
    }

    const shifts = await c.env.DB.prepare(`
      SELECT s.*, u.username FROM shifts s JOIN users u ON u.id = s.user_id
      WHERE (s.opened_at >= ? AND s.opened_at <= ?) OR (s.closed_at >= ? AND s.closed_at <= ?)
        ${actor.role === 'admin' ? '' : 'AND s.user_id = ?'}
      ORDER BY s.opened_at, s.id
    `).bind(range.startUtc, range.endUtc, range.startUtc, range.endUtc, ...roleBindings).all<DbRow>();
    for (const row of shifts.results) {
      if (String(row.opened_at) >= range.startUtc && String(row.opened_at) <= range.endUtc) {
        const date = dateKey(String(row.opened_at), settings.timezone);
        if (days.has(date)) {
          const event = baseEvent('shift', `${row.id}:opened`, String(row.opened_at), date, `Shift #${row.id} opened`, 'opened', 'open', 'purple', actor.role);
          if (actor.role === 'admin') event.financialData = { expectedCashKsh: Number(row.expected_cash), expectedMpesaKsh: Number(row.expected_mpesa) };
          events.push(event);
          const day = days.get(date);
          if (day) day.shiftOpened = Number(day.shiftOpened) + 1;
        }
      }
      if (row.closed_at && String(row.closed_at) >= range.startUtc && String(row.closed_at) <= range.endUtc) {
        const date = dateKey(String(row.closed_at), settings.timezone);
        if (days.has(date)) {
          const event = baseEvent('shift', `${row.id}:closed`, String(row.closed_at), date, `Shift #${row.id} closed`, 'closed', 'closed', 'purple', actor.role);
          if (actor.role === 'admin') event.financialData = { discrepancyKsh: row.total_difference_cents === null ? null : Number(row.total_difference_cents) / 100 };
          events.push(event);
          const day = days.get(date);
          if (day) day.shiftClosed = Number(day.shiftClosed) + 1;
        }
      }
    }

    events.sort((left, right) => String(left.occurredAt).localeCompare(String(right.occurredAt)) || String(left.id).localeCompare(String(right.id)));
    if (actor.role === 'admin') {
      const audit = auditForContext(c, { category: 'admin', event: 'admin.calendar_viewed', metadata: { from, to, eventCount: events.length } });
      await c.env.DB.prepare(audit.sql).bind(...audit.bindings).run();
    }
    return c.json({ period: { from, to, timezone: settings.timezone }, role: actor.role, events, timeline: events, daily: [...days.values()] });
  });
  return app;
}
