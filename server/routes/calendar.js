import { Router } from 'express';
import { z } from 'zod';
import { DateTime } from 'luxon';
import { money } from '../lib/http.js';
import { validate } from '../middleware/validate.js';
import { recordAudit } from '../services/audit.js';
import { getDateRange, getSettings } from '../services/settings.js';

const querySchema = z.object({
  from: z.iso.date(),
  to: z.iso.date(),
}).strict().superRefine((value, context) => {
  if (value.from > value.to) context.addIssue({ code: 'custom', path: ['to'], message: 'to cannot be before from' });
  else if (DateTime.fromISO(value.to).diff(DateTime.fromISO(value.from), 'days').days > 92) context.addIssue({ code: 'custom', path: ['to'], message: 'Calendar range cannot exceed 93 days' });
});

function dayKey(date, zone) {
  return DateTime.fromISO(date).setZone(zone).toISODate();
}

function baseEvent(type, id, occurredAt, date, label, status, color, role) {
  return {
    id: `${type}:${id}`,
    type,
    event: type === 'shift' ? label.event : 'created',
    occurredAt,
    date,
    label: label.text,
    status,
    color,
    financialHidden: role !== 'admin',
  };
}

export function createCalendarRouter({ db }) {
  const router = Router();

  router.get('/', validate(querySchema, 'query'), (req, res) => {
    const actor = req.auth.user;
    const { from, to } = req.validatedQuery;
    const settings = getSettings(db);
    const { startUtc, endUtc, zone } = getDateRange(db, from, to);
    const days = new Map();
    for (const date of (() => { const list = []; let cursor = DateTime.fromISO(from); const end = DateTime.fromISO(to); while (cursor <= end) { list.push(cursor.toISODate()); cursor = cursor.plus({ days: 1 }); } return list; })()) {
      days.set(date, { date, sales: 0, restocks: 0, expenses: 0, shiftOpened: 0, shiftClosed: 0, financialHidden: actor.role !== 'admin' });
    }
    const events = [];
    const roleClause = actor.role === 'admin' ? '' : ' AND user_id = ?';
    const roleParams = actor.role === 'admin' ? [] : [actor.id];

    const sales = db.prepare(`
      SELECT id, sold_at, user_id, fuel_id, fuel_type, amount_cents, mode, pump_id, payment_method
      FROM sales
      WHERE sold_at >= ? AND sold_at <= ?${roleClause}
      ORDER BY sold_at, id
    `).all(startUtc, endUtc, ...roleParams);
    for (const row of sales) {
      const date = dayKey(row.sold_at, zone);
      if (!days.has(date)) continue;
      const event = baseEvent('sale', row.id, row.sold_at, date, { text: `Sale #${row.id}` }, 'recorded', 'orange', actor.role);
      event.mode = row.mode;
      event.fuelType = row.fuel_type;
      event.pumpId = row.pump_id;
      if (actor.role === 'admin') event.financialData = { amountKsh: money(row.amount_cents), paymentMethod: row.payment_method };
      events.push(event);
      const day = days.get(date);
      day.sales += 1;
      if (actor.role === 'admin') day.salesKsh = money((day.salesKsh || 0) + row.amount_cents / 100);
    }

    if (actor.role === 'admin') {
      const restocks = db.prepare(`
        SELECT id, timestamp, fuel_id, fuel_type, litres_added, total_cost_cents
        FROM restocks WHERE timestamp >= ? AND timestamp <= ? ORDER BY timestamp, id
      `).all(startUtc, endUtc);
      for (const row of restocks) {
        const date = dayKey(row.timestamp, zone);
        if (!days.has(date)) continue;
        const event = baseEvent('restock', row.id, row.timestamp, date, { text: `Restock #${row.id}` }, 'recorded', 'green', actor.role);
        event.fuelType = row.fuel_type;
        event.litresAdded = row.litres_added;
        event.financialData = { amountKsh: money(row.total_cost_cents) };
        events.push(event);
        const day = days.get(date);
        day.restocks += 1;
        day.restockKsh = money((day.restockKsh || 0) + row.total_cost_cents / 100);
      }
    }

    const expenses = db.prepare(`
      SELECT id, timestamp, expense_date, user_id, category, amount_cents, payment_method
      FROM expenses WHERE expense_date >= ? AND expense_date <= ?${roleClause}
      ORDER BY timestamp, id
    `).all(from, to, ...roleParams);
    for (const row of expenses) {
      const date = row.expense_date;
      if (!days.has(date)) continue;
      const event = baseEvent('expense', row.id, row.timestamp, date, { text: `Expense #${row.id}` }, 'recorded', 'red', actor.role);
      event.category = row.category;
      if (actor.role === 'admin') event.financialData = { amountKsh: money(row.amount_cents), paymentMethod: row.payment_method };
      events.push(event);
      const day = days.get(date);
      day.expenses += 1;
      if (actor.role === 'admin') day.expensesKsh = money((day.expensesKsh || 0) + row.amount_cents / 100);
    }

    const shifts = db.prepare(`
      SELECT s.*, u.username
      FROM shifts s JOIN users u ON u.id = s.user_id
      WHERE (s.opened_at >= ? AND s.opened_at <= ?) OR (s.closed_at >= ? AND s.closed_at <= ?)${actor.role === 'admin' ? '' : ' AND s.user_id = ?'}
      ORDER BY s.opened_at, s.id
    `).all(startUtc, endUtc, startUtc, endUtc, ...roleParams);
    for (const row of shifts) {
      if (row.opened_at >= startUtc && row.opened_at <= endUtc) {
        const date = dayKey(row.opened_at, zone);
        if (days.has(date)) {
          const event = baseEvent('shift', `${row.id}:opened`, row.opened_at, date, { text: `Shift #${row.id} opened`, event: 'opened' }, 'open', 'purple', actor.role);
          if (actor.role === 'admin') event.financialData = { expectedCashKsh: row.expected_cash, expectedMpesaKsh: row.expected_mpesa };
          events.push(event);
          days.get(date).shiftOpened += 1;
        }
      }
      if (row.closed_at && row.closed_at >= startUtc && row.closed_at <= endUtc) {
        const date = dayKey(row.closed_at, zone);
        if (days.has(date)) {
          const event = baseEvent('shift', `${row.id}:closed`, row.closed_at, date, { text: `Shift #${row.id} closed`, event: 'closed' }, 'closed', 'purple', actor.role);
          if (actor.role === 'admin') event.financialData = { discrepancyKsh: row.total_difference_cents === null ? null : row.total_difference_cents / 100 };
          events.push(event);
          days.get(date).shiftClosed += 1;
        }
      }
    }

    events.sort((a, b) => String(a.occurredAt).localeCompare(String(b.occurredAt)) || String(a.id).localeCompare(String(b.id)));
    const daily = [...days.values()];
    if (actor.role === 'admin') recordAudit(db, { req, category: 'admin', event: 'admin.calendar_viewed', metadata: { from, to, eventCount: events.length } });
    res.json({ period: { from, to, timezone: zone }, role: actor.role, events, timeline: events, daily });
  });

  return router;
}
