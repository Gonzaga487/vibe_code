/// <reference types="@cloudflare/vitest-plugin/types" />
import { env } from 'cloudflare:test';
import bcrypt from 'bcryptjs';
import migrationSql from '../../migrations/0001_canonical_schema_v2.sql?raw';
import { beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app';
import { randomId } from '../../src/http';

const d1 = () => (env as unknown as { DB: D1Database }).DB;

function splitSql(sql: string): string[] {
  const output: string[] = [];
  let start = 0;
  let quote: "'" | '"' | null = null;
  let triggerDepth = 0;
  let lineComment = false;
  let blockComment = false;
  for (let index = 0; index < sql.length; index += 1) {
    const character = sql[index];
    const next = sql[index + 1];
    if (lineComment) {
      if (character === '\n') lineComment = false;
      continue;
    }
    if (blockComment) {
      if (character === '*' && next === '/') { blockComment = false; index += 1; }
      continue;
    }
    if (!quote && character === '-' && next === '-') { lineComment = true; index += 1; continue; }
    if (!quote && character === '/' && next === '*') { blockComment = true; index += 1; continue; }
    if (quote) {
      if (character === quote) {
        if (sql[index + 1] === quote) index += 1;
        else if (previousCharacter(sql, index) !== '\\') quote = null;
      }
      continue;
    }
    if (character === "'" || character === '"') { quote = character; continue; }
    if (/[A-Za-z]/.test(character) && (index === 0 || !/[A-Za-z0-9_]/.test(sql[index - 1] || ''))) {
      let end = index + 1;
      while (end < sql.length && /[A-Za-z0-9_]/.test(sql[end] || '')) end += 1;
      const token = sql.slice(index, end).toUpperCase();
      if (token === 'BEGIN') triggerDepth += 1;
      if (token === 'END') triggerDepth = Math.max(0, triggerDepth - 1);
      index = end - 1;
    }
    if (character === ';' && triggerDepth === 0) {
      const statement = sql.slice(start, index + 1).trim();
      if (statement && !/^PRAGMA\s+foreign_keys/i.test(statement)) output.push(statement);
      start = index + 1;
    }
  }
  return output;
}

function previousCharacter(value: string, index: number): string {
  return index > 0 ? value[index - 1] || '' : '';
}

const executionContext = { waitUntil() {}, passThroughOnException() {} } as unknown as ExecutionContext;

async function api(app: ReturnType<typeof createApp>, path: string, options: RequestInit = {}): Promise<Response> {
  return app.fetch(new Request(`https://worker.test${path}`, options), env as never, executionContext);
}

async function json<T>(response: Response): Promise<T> {
  return await response.json() as T;
}

beforeAll(async () => {
  const statements = splitSql(migrationSql);
  await d1().batch(statements.map((statement) => d1().prepare(statement)));
});

describe('Worker + local D1 contract', () => {
  it('applies the canonical migration without operational seed rows', async () => {
    const version = await d1().prepare('SELECT MAX(version) AS version FROM schema_migrations').first<{ version: number }>();
    expect(Number(version?.version)).toBe(2);
    for (const table of ['users', 'fuel_management', 'sales', 'pump_readings', 'inventory_lots']) {
      const row = await d1().prepare(`SELECT COUNT(*) AS count FROM "${table}"`).first<{ count: number }>();
      expect(Number(row?.count)).toBe(0);
    }
  });

  it('serves public settings and reports degraded readiness before bootstrap', async () => {
    const app = createApp(env as never);
    const publicResponse = await api(app, '/api/settings/public');
    expect(publicResponse.status).toBe(200);
    const body = await json<{ currency: string }>(publicResponse);
    expect(body.currency).toBe('KSh');
    const health = await api(app, '/api/health');
    expect(health.status).toBe(503);
  });

  it('bootstraps, enforces roles, records Quick Tally, and reconciles FIFO readings', async () => {
    const app = createApp(env as never);
    const adminUsername = `it-${crypto.randomUUID().slice(0, 8)}`;
    const bootstrapPassword = `Zephyr!${crypto.randomUUID()}9Q`;
    const now = new Date().toISOString();
    await d1().prepare(`
      INSERT INTO users
        (id, username, password_hash, full_name, role, is_active, must_change_password, created_at, updated_at, password_changed_at)
      VALUES (?, ?, ?, ?, 'admin', 1, 1, ?, ?, ?)
    `).bind(randomId(), adminUsername, await bcrypt.hash(bootstrapPassword, 10), 'Integration Administrator', now, now, now).run();
    const login = await api(app, '/api/auth/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: adminUsername, password: bootstrapPassword, role: 'admin' }),
    });
    expect(login.status, await login.clone().text()).toBe(200);
    const session = await json<{ token: string }>(login);
    const adminHeaders = { authorization: `Bearer ${session.token}`, 'content-type': 'application/json' };
    const changedPassword = `Cobalt!${crypto.randomUUID()}4Q`;
    const passwordChange = await api(app, '/api/auth/change-password', {
      method: 'POST', headers: adminHeaders,
      body: JSON.stringify({ currentPassword: bootstrapPassword, newPassword: changedPassword, confirmPassword: changedPassword }),
    });
    expect(passwordChange.status, await passwordChange.clone().text()).toBe(200);
    const changedSession = await json<{ token: string }>(passwordChange);
    adminHeaders.authorization = `Bearer ${changedSession.token}`;

    const fuelResponse = await api(app, '/api/fuel', {
      method: 'POST', headers: adminHeaders,
      body: JSON.stringify({ fuelType: 'DIESEL', sellingPriceKsh: 150, tankCapacityLitres: 5000 }),
    });
    expect(fuelResponse.status).toBe(201);
    const fuel = await json<{ fuel: { id: number } }>(fuelResponse);
    const fuelRows = await d1().prepare('SELECT id FROM fuel_management WHERE fuel_type = ?').bind('DIESEL').first<{ id: number }>();
    const fuelId = fuelRows?.id || fuel.fuel.id;
    expect(fuelId).toBeGreaterThan(0);
    const fuelPatch = await api(app, `/api/fuel/${fuelId}`, { method: 'PATCH', headers: adminHeaders, body: JSON.stringify({ sellingPriceKsh: 151 }) });
    expect(fuelPatch.status).toBe(200);
    const priceUpdate = await api(app, `/api/fuel/${fuelId}/selling-price`, { method: 'POST', headers: adminHeaders, body: JSON.stringify({ sellingPriceKsh: 150 }) });
    expect(priceUpdate.status, await priceUpdate.clone().text()).toBe(200);

    const pump = await api(app, '/api/pumps', {
      method: 'POST', headers: adminHeaders, body: JSON.stringify({ fuelId, pumpCode: 'PUMP-A' }),
    });
    expect(pump.status).toBe(201);
    const pumpBody = await json<{ pump: { id: number } }>(pump);
    const pumpId = pumpBody.pump.id;
    const pumpUpdate = await api(app, `/api/pumps/${pumpId}`, { method: 'PATCH', headers: adminHeaders, body: JSON.stringify({ isActive: true }) });
    expect(pumpUpdate.status).toBe(200);

    const attendantUsername = `ia-${crypto.randomUUID().slice(0, 8)}`;
    const attendantPassword = `Cedar!${crypto.randomUUID()}7M`;
    const attendantResponse = await api(app, '/api/users', {
      method: 'POST', headers: adminHeaders,
      body: JSON.stringify({ username: attendantUsername, password: attendantPassword, fullName: 'Integration Attendant', role: 'attendant', mustChangePassword: false }),
    });
    expect(attendantResponse.status).toBe(201);
    const attendantLogin = await api(app, '/api/auth/login', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: attendantUsername, password: attendantPassword, role: 'attendant' }),
    });
    expect(attendantLogin.status).toBe(200);
    const attendantSession = await json<{ token: string }>(attendantLogin);
    const attendantHeaders = { authorization: `Bearer ${attendantSession.token}`, 'content-type': 'application/json' };

    const shift = await api(app, '/api/shifts/open', { method: 'POST', headers: attendantHeaders, body: JSON.stringify({ openingCashKsh: 1000, openingMpesaKsh: 0 }) });
    expect(shift.status, await shift.clone().text()).toBe(201);
    const shiftBody = await json<{ shift: { id: number } }>(shift);
    const quick = await api(app, '/api/sales', { method: 'POST', headers: attendantHeaders, body: JSON.stringify({ mode: 'quick', paymentMethod: 'cash', amountKsh: 333.33 }) });
    expect(quick.status).toBe(201);
    expect((await json<{ sale: { amountKsh: number; fuel: null } }>(quick)).sale.amountKsh).toBe(333.33);

    const settingsPatch = await api(app, '/api/settings', { method: 'PATCH', headers: adminHeaders, body: JSON.stringify({ stationName: 'Integration Station' }) });
    expect(settingsPatch.status).toBe(200);
    const attendantSettings = await api(app, '/api/settings', { method: 'PATCH', headers: attendantHeaders, body: JSON.stringify({ stationName: 'Should Fail' }) });
    expect(attendantSettings.status).toBe(403);
    const expense = await api(app, '/api/expenses', { method: 'POST', headers: attendantHeaders, body: JSON.stringify({ category: 'OTHER', description: 'Integration supplies', amountKsh: 20, paymentMethod: 'cash' }) });
    expect(expense.status).toBe(201);
    const expenseBody = await json<{ expense: { id: number } }>(expense);
    const expenseUpdate = await api(app, `/api/expenses/${expenseBody.expense.id}`, { method: 'PATCH', headers: attendantHeaders, body: JSON.stringify({ description: 'Updated integration supplies' }) });
    expect(expenseUpdate.status).toBe(200);

    const restock = await api(app, '/api/restock', {
      method: 'POST', headers: adminHeaders,
      body: JSON.stringify({ fuelId, quantityLitres: 1000, unitCostKsh: 100, supplier: 'Integration Supplier' }),
    });
    expect(restock.status).toBe(201);
    const restockBody = await json<{ restock: { id: number } }>(restock);
    const restockUpdate = await api(app, `/api/restock/${restockBody.restock.id}`, { method: 'PATCH', headers: adminHeaders, body: JSON.stringify({ notes: 'Updated integration note' }) });
    expect(restockUpdate.status, await restockUpdate.clone().text()).toBe(200);
    const date = new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Nairobi' }).format(new Date());
    const pumpReading = await api(app, '/api/pump-readings', {
      method: 'POST', headers: attendantHeaders,
      body: JSON.stringify({ fuelId, readingDate: date, openingLitres: 5000, prevClosingLitres: 5000, closingLitres: 5090, meterReference: 'PUMP-A' }),
    });
    expect(pumpReading.status).toBe(201);
    const pumpReadingBody = await json<{ reading: { id: number; consumptionLitres?: number; fuel: { type: string } } }>(pumpReading);
    expect(pumpReadingBody.reading.fuel.type).toBe('DIESEL');
    const pumpReadingId = pumpReadingBody.reading.id;

    const salesReading = await api(app, '/api/sales-readings', {
      method: 'POST', headers: attendantHeaders,
      body: JSON.stringify({ fuelId, readingDate: date, openingKsh: 800, prevClosingKsh: 800, closingKsh: 890, meterReference: 'SALES-A' }),
    });
    expect(salesReading.status).toBe(201);
    const salesReadingBody = await json<{ reading: { id: number } }>(salesReading);
    const salesReadingId = salesReadingBody.reading.id;
    const report = await api(app, `/api/reports?from=${date}&to=${date}`, { headers: adminHeaders });
    expect(report.status).toBe(200);
    const reportBody = await json<{ report: { totals: { recordedSaleRevenueKsh: number; cogsKsh: number; litres: number } } }>(report);
    expect(reportBody.report.totals.recordedSaleRevenueKsh).toBe(333.33);
    expect(reportBody.report.totals.cogsKsh).toBe(9000);
    expect(reportBody.report.totals.litres).toBe(90);
    const pumpReadingUpdate = await api(app, `/api/pump-readings/${pumpReadingId}`, {
      method: 'PATCH', headers: attendantHeaders,
      body: JSON.stringify({ closingLitres: 5095, prevClosingLitres: 5000 }),
    });
    expect(pumpReadingUpdate.status, await pumpReadingUpdate.clone().text()).toBe(200);
    const salesReadingDelete = await api(app, `/api/sales-readings/${salesReadingId}`, { method: 'DELETE', headers: attendantHeaders });
    expect(salesReadingDelete.status).toBe(200);
    const adjustment = await api(app, '/api/stock-adjustments', {
      method: 'POST', headers: adminHeaders,
      body: JSON.stringify({ fuelId, newStockLitres: 900, reason: 'Integration physical count' }),
    });
    expect(adjustment.status).toBe(201);

    const close = await api(app, `/api/shifts/${shiftBody.shift.id}/close`, { method: 'POST', headers: attendantHeaders, body: JSON.stringify({ countedCashKsh: 1313.33, countedMpesaKsh: 0 }) });
    expect(close.status).toBe(200);
    expect((await json<{ shift: { discrepancy: { cashKsh: number } } }>(close)).shift.discrepancy.cashKsh).toBe(0);
    const saleAfterClose = await api(app, '/api/sales', { method: 'POST', headers: attendantHeaders, body: JSON.stringify({ mode: 'quick', paymentMethod: 'cash', amountKsh: 10 }) });
    expect(saleAfterClose.status).toBe(400);
    const year = date.slice(0, 4);
    const month = date.slice(5, 7);
    const calendar = await api(app, `/api/calendar?from=${date}&to=${date}`, { headers: adminHeaders });
    expect(calendar.status).toBe(200);
    expect((await json<{ events: unknown[] }>(calendar)).events.length).toBeGreaterThan(0);
    const monthly = await api(app, `/api/reports/monthly?year=${year}&month=${Number(month)}`, { headers: adminHeaders });
    expect(monthly.status).toBe(200);
    const csv = await api(app, `/api/reports/export.csv?from=${date}&to=${date}`, { headers: adminHeaders });
    expect(csv.status).toBe(200);
    expect(csv.headers.get('content-type')).toContain('text/csv');
    await csv.text();
    const backup = await api(app, '/api/admin/backup', { headers: adminHeaders });
    expect(backup.status).toBe(200);
    const snapshot = await json<{ schemaVersion: number; tables: Record<string, { rows: unknown[] }> }>(backup);
    expect(snapshot.schemaVersion).toBe(2);
    const clear = await api(app, '/api/admin/clear-operational-data', { method: 'POST', headers: adminHeaders, body: JSON.stringify({ confirmation: 'CLEAR OPERATIONAL DATA' }) });
    expect(clear.status).toBe(200);
    const zeroStock = await d1().prepare('SELECT stock_litres FROM fuel_management WHERE id = ?').bind(fuelId).first<{ stock_litres: number }>();
    expect(Number(zeroStock?.stock_litres)).toBe(0);
    const restore = await api(app, '/api/admin/restore', { method: 'POST', headers: adminHeaders, body: JSON.stringify({ snapshot }) });
    expect(restore.status, await restore.clone().text()).toBe(200);
    const restoredStock = await d1().prepare('SELECT stock_litres FROM fuel_management WHERE id = ?').bind(fuelId).first<{ stock_litres: number }>();
    expect(Number(restoredStock?.stock_litres)).toBe(900);
    const metrics = await api(app, '/api/admin/metrics', { headers: adminHeaders });
    expect(metrics.status).toBe(200);
    expect((await json<{ metrics: { database: { integrity: string } } }>(metrics)).metrics.database.integrity).toBe('ok');
    const auditList = await api(app, '/api/audit?event=restore_completed', { headers: adminHeaders });
    expect(auditList.status).toBe(200);
    expect((await json<{ data: unknown[] }>(auditList)).data.length).toBeGreaterThan(0);
    const auditWipe = await api(app, '/api/audit/wipe', { method: 'POST', headers: adminHeaders, body: JSON.stringify({ confirmation: 'WIPE AUDIT LOGS', wipeAll: true }) });
    expect(auditWipe.status).toBe(200);
    expect((await json<{ deleted: number }>(auditWipe)).deleted).toBeGreaterThan(0);
    expect(pumpId).toBeGreaterThan(0);
  });
});
