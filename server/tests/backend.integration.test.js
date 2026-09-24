import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DateTime } from 'luxon';
import request from 'supertest';
import { loadConfig } from '../config.js';
import { createDatabase, closeDatabase } from '../db/index.js';
import { createLogger } from '../logger.js';
import { bootstrapAdmin } from '../services/bootstrap.js';
import { createApp } from '../app.js';

const ADMIN_PASSWORD = 'Vivid!Harbor73#Q';
const ATTENDANT_PASSWORD = 'Bright!Cedar82#M';
const FORCED_PASSWORD = 'Golden!Lantern48#R';
const CHANGED_PASSWORD = 'Ocean!Meadow84#K';
const TODAY = DateTime.now().setZone('Africa/Nairobi').toISODate();

let tempDir;
let db;
let app;
let adminToken;
let attendantToken;
let forcedToken;
let attendantId;
let fuelId;
let pumpId;
let shiftId;

function bearer(token) {
  return { Authorization: `Bearer ${token}` };
}

function refreshChecksum(snapshot) {
  snapshot.checksum = crypto.createHash('sha256')
    .update(JSON.stringify({ schemaVersion: snapshot.schemaVersion, tables: snapshot.tables }))
    .digest('hex');
  return snapshot;
}

async function login(body) {
  return request(app).post('/api/auth/login').send(body);
}

before(async () => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zenenergies-backend-'));
  const databasePath = path.join(tempDir, 'test.sqlite');
  const config = loadConfig({
    NODE_ENV: 'test',
    JWT_SECRET: 'Test-Only!Secret-42-Strong-Character-Value-2026#Secure',
    DATABASE_URL: databasePath,
    FRONTEND_ORIGINS: 'http://localhost:5173',
    ADMIN_USERNAME: 'station.admin',
    ADMIN_PASSWORD: ADMIN_PASSWORD,
    ADMIN_FULL_NAME: 'Test Station Admin',
    LOG_LEVEL: 'silent',
  });
  db = createDatabase(databasePath);
  await bootstrapAdmin(db, config, createLogger({ test: true }));
  db.prepare('UPDATE users SET must_change_password = 0 WHERE role = ?').run('admin');
  app = createApp({ db, config, logger: createLogger({ test: true }) });

  assert.equal(db.prepare('SELECT MAX(version) AS version FROM schema_migrations').get().version, 2);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM fuel_management').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM restocks').get().count, 0);
  assert.equal(db.prepare('SELECT COUNT(*) AS count FROM sales').get().count, 0);

  const response = await login({ username: 'station.admin', password: ADMIN_PASSWORD, role: 'admin' });
  assert.equal(response.status, 200, JSON.stringify(response.body));
  adminToken = response.body.token;
});

after(() => {
  if (db?.open) closeDatabase(db);
  if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
});

test('authentication, Petrol/Diesel-only configuration, and backend role boundaries', async () => {
  const mismatch = await login({ username: 'station.admin', password: ADMIN_PASSWORD, role: 'attendant' });
  assert.equal(mismatch.status, 401);

  const created = await request(app)
    .post('/api/users')
    .set(bearer(adminToken))
    .send({
      username: 'attendant.one',
      password: ATTENDANT_PASSWORD,
      fullName: 'Station Attendant',
      role: 'attendant',
      mustChangePassword: false,
    });
  assert.equal(created.status, 201, JSON.stringify(created.body));
  assert.equal('password_hash' in created.body.user, false);
  attendantId = created.body.user.id;

  const attendantLogin = await login({ username: 'attendant.one', password: ATTENDANT_PASSWORD, role: 'attendant' });
  assert.equal(attendantLogin.status, 200, JSON.stringify(attendantLogin.body));
  attendantToken = attendantLogin.body.token;

  const forbiddenUsers = await request(app).get('/api/users').set(bearer(attendantToken));
  assert.equal(forbiddenUsers.status, 403);
  const forbiddenReports = await request(app)
    .get(`/api/reports?from=${TODAY}&to=${TODAY}`)
    .set(bearer(attendantToken));
  assert.equal(forbiddenReports.status, 403);

  const kerosene = await request(app)
    .post('/api/fuel')
    .set(bearer(adminToken))
    .send({ fuelType: 'KEROSENE', sellingPriceKsh: 100 });
  assert.equal(kerosene.status, 400);

  const fuel = await request(app)
    .post('/api/fuel')
    .set(bearer(adminToken))
    .send({ fuelType: 'DIESEL', sellingPriceKsh: 150, tankCapacityLitres: 5000 });
  assert.equal(fuel.status, 201, JSON.stringify(fuel.body));
  fuelId = fuel.body.fuel.id;

  const pump = await request(app)
    .post('/api/pumps')
    .set(bearer(adminToken))
    .send({ fuelId, pumpCode: 'PUMP-A' });
  assert.equal(pump.status, 201, JSON.stringify(pump.body));
  pumpId = pump.body.pump.id;

  const attendantFuel = await request(app).get('/api/fuel').set(bearer(attendantToken));
  assert.equal(attendantFuel.status, 200);
  assert.equal('sellingPriceKsh' in attendantFuel.body.data[0], false);
  assert.equal('stockLitres' in attendantFuel.body.data[0], false);

  const forcedUser = await request(app)
    .post('/api/users')
    .set(bearer(adminToken))
    .send({
      username: 'forced.change',
      password: FORCED_PASSWORD,
      fullName: 'Forced Change User',
      role: 'attendant',
      mustChangePassword: true,
    });
  assert.equal(forcedUser.status, 201, JSON.stringify(forcedUser.body));
  const forcedLogin = await login({ username: 'forced.change', password: FORCED_PASSWORD, role: 'attendant' });
  assert.equal(forcedLogin.status, 200);
  forcedToken = forcedLogin.body.token;
  const blocked = await request(app).get('/api/dashboard').set(bearer(forcedToken));
  assert.equal(blocked.status, 403);
  assert.equal(blocked.body.error.code, 'PASSWORD_CHANGE_REQUIRED');
  const changed = await request(app)
    .post('/api/auth/change-password')
    .set(bearer(forcedToken))
    .send({ currentPassword: FORCED_PASSWORD, newPassword: CHANGED_PASSWORD, confirmPassword: CHANGED_PASSWORD });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  assert.equal(changed.body.user.mustChangePassword, false);
});

test('amount-only Quick Tally preserves KSh exactly, requires an open shift, and restricts deletion', async () => {
  const noShift = await request(app)
    .post('/api/sales')
    .set(bearer(attendantToken))
    .send({ mode: 'quick', paymentMethod: 'cash', amountKsh: 333.33 });
  assert.equal(noShift.status, 400);

  const opened = await request(app)
    .post('/api/shifts/open')
    .set(bearer(attendantToken))
    .send({ openingCashKsh: 1000, openingMpesaKsh: 0 });
  assert.equal(opened.status, 201, JSON.stringify(opened.body));
  shiftId = opened.body.shift.id;

  const cashSale = await request(app)
    .post('/api/sales')
    .set(bearer(attendantToken))
    .send({ mode: 'quick', paymentMethod: 'cash', amountKsh: 333.33 });
  assert.equal(cashSale.status, 201, JSON.stringify(cashSale.body));
  assert.equal(cashSale.body.sale.amountKsh, 333.33);
  assert.equal(cashSale.body.sale.mode, 'quick');
  assert.equal(cashSale.body.sale.fuel, null);
  assert.equal('unitPriceKsh' in cashSale.body.sale, false);
  assert.equal('unitCostKsh' in cashSale.body.sale, false);

  const mpesaSale = await request(app)
    .post('/api/sales')
    .set(bearer(attendantToken))
    .send({ mode: 'quick', paymentMethod: 'mpesa', amountKsh: 100.01 });
  assert.equal(mpesaSale.status, 201);

  const mixedSale = await request(app)
    .post('/api/sales')
    .set(bearer(attendantToken))
    .send({ mode: 'quick', paymentMethod: 'mixed', amountKsh: 100.49, cashAmountKsh: 50, mpesaAmountKsh: 50.49 });
  assert.equal(mixedSale.status, 201, JSON.stringify(mixedSale.body));

  const detailed = await request(app)
    .post('/api/sales')
    .set(bearer(attendantToken))
    .send({ mode: 'detailed', paymentMethod: 'cash', amountKsh: 200, fuelId, pumpId, customerName: 'Walk-in' });
  assert.equal(detailed.status, 201, JSON.stringify(detailed.body));
  assert.equal(detailed.body.sale.amountKsh, 200);
  assert.equal(detailed.body.sale.pumpId, pumpId);
  assert.equal(detailed.body.sale.fuel.type, 'DIESEL');

  const attendantDelete = await request(app)
    .delete(`/api/sales/${cashSale.body.sale.id}`)
    .set(bearer(attendantToken));
  assert.equal(attendantDelete.status, 403);

  const expense = await request(app)
    .post('/api/expenses')
    .set(bearer(attendantToken))
    .send({ category: 'OTHER', description: 'Cleaning supplies', amountKsh: 20, paymentMethod: 'cash' });
  assert.equal(expense.status, 201, JSON.stringify(expense.body));

  const live = await request(app).get('/api/shifts/open').set(bearer(attendantToken));
  assert.equal(live.status, 200);
  assert.equal(live.body.shift.expected.cashKsh, 1563.33);
  assert.equal(live.body.shift.expected.mpesaKsh, 150.5);
  assert.equal('reconciliation' in live.body.shift, false);

  const closed = await request(app)
    .post(`/api/shifts/${shiftId}/close`)
    .set(bearer(attendantToken))
    .send({ countedCashKsh: 1560, countedMpesaKsh: 150 });
  assert.equal(closed.status, 200, JSON.stringify(closed.body));
  assert.equal(closed.body.shift.discrepancy.cashKsh, -3.33);
  assert.equal('reconciliation' in closed.body.shift, false);

  const afterClose = await request(app)
    .post('/api/sales')
    .set(bearer(attendantToken))
    .send({ mode: 'quick', paymentMethod: 'cash', amountKsh: 10 });
  assert.equal(afterClose.status, 400);
});

test('meter units, backdating, FIFO stock, physical counts, events, and reports are correct', async () => {
  const restock = await request(app)
    .post('/api/restock')
    .set(bearer(adminToken))
    .send({ fuelId, quantityLitres: 1000, unitCostKsh: 100, supplier: 'Test Fuel Supplier' });
  assert.equal(restock.status, 201, JSON.stringify(restock.body));

  const pumpReading = await request(app)
    .post('/api/pump-readings')
    .set(bearer(attendantToken))
    .send({
      fuelId,
      readingDate: TODAY,
      openingLitres: 5000,
      prevClosingLitres: 5000,
      closingLitres: 5090,
      meterReference: 'PUMP-A',
    });
  assert.equal(pumpReading.status, 201, JSON.stringify(pumpReading.body));
  assert.equal('consumptionLitres' in pumpReading.body.reading, false);
  assert.equal('reconciliationKsh' in pumpReading.body.reading, false);
  assert.equal(pumpReading.body.lowStockAlerts.length, 0);

  const backdated = await request(app)
    .post('/api/pump-readings')
    .set(bearer(attendantToken))
    .send({
      fuelId,
      readingDate: '2024-01-01',
      openingLitres: 4000,
      prevClosingLitres: 4000,
      closingLitres: 4005,
      meterReference: 'PUMP-A',
    });
  assert.equal(backdated.status, 201, JSON.stringify(backdated.body));

  const salesReading = await request(app)
    .post('/api/sales-readings')
    .set(bearer(attendantToken))
    .send({
      fuelId,
      readingDate: TODAY,
      openingKsh: 800,
      prevClosingKsh: 800,
      closingKsh: 890,
      meterReference: 'SALES-A',
    });
  assert.equal(salesReading.status, 201, JSON.stringify(salesReading.body));
  assert.equal('reconciliationKsh' in salesReading.body.reading, false);

  const adminReadings = await request(app).get(`/api/pump-readings?from=${TODAY}&to=${TODAY}`).set(bearer(adminToken));
  assert.equal(adminReadings.status, 200);
  assert.equal(adminReadings.body.data[0].consumptionLitres, 90);
  assert.equal(adminReadings.body.data[0].reconciliationKsh, 13500);

  const adminSalesReading = await request(app).get(`/api/sales-readings?from=${TODAY}&to=${TODAY}`).set(bearer(adminToken));
  assert.equal(adminSalesReading.status, 200);
  assert.equal(adminSalesReading.body.data[0].reconciliationKsh, 90);
  assert.equal(adminSalesReading.body.data[0].consumptionKsh, 90);

  const beforeCount = await request(app).get('/api/fuel').set(bearer(adminToken));
  assert.equal(beforeCount.body.data[0].quantityLitres, 905);

  const countDown = await request(app)
    .post('/api/stock-adjustments')
    .set(bearer(adminToken))
    .send({ fuelId, newStockLitres: 800, reason: 'Verified physical tank count' });
  assert.equal(countDown.status, 201, JSON.stringify(countDown.body));
  assert.equal(countDown.body.adjustment.oldStock, 905);
  assert.equal(countDown.body.adjustment.newStock, 800);

  const unchangedCount = await request(app)
    .post('/api/stock-adjustments')
    .set(bearer(adminToken))
    .send({ fuelId, newStockLitres: 800, reason: 'Second verified physical count' });
  assert.equal(unchangedCount.status, 201, JSON.stringify(unchangedCount.body));
  assert.equal(unchangedCount.body.adjustment.quantityLitres, 0);

  const calendar = await request(app)
    .get(`/api/calendar?from=${TODAY}&to=${TODAY}`)
    .set(bearer(adminToken));
  assert.equal(calendar.status, 200, JSON.stringify(calendar.body));
  const types = new Set(calendar.body.events.map((event) => event.type));
  for (const type of ['sale', 'restock', 'expense', 'shift']) assert.equal(types.has(type), true, `missing ${type} calendar event`);

  const ownCalendar = await request(app)
    .get(`/api/calendar?from=${TODAY}&to=${TODAY}`)
    .set(bearer(attendantToken));
  assert.equal(ownCalendar.status, 200);
  assert.equal(ownCalendar.body.events.every((event) => event.financialHidden === true), true);
  assert.equal(JSON.stringify(ownCalendar.body).includes('amountKsh'), false);

  const report = await request(app)
    .get(`/api/reports?from=${TODAY}&to=${TODAY}`)
    .set(bearer(adminToken));
  assert.equal(report.status, 200, JSON.stringify(report.body));
  assert.equal(report.body.report.totals.salesKsh, 90);
  assert.equal(report.body.report.totals.recordedSaleRevenueKsh, 733.83);
  assert.equal(report.body.report.totals.litres, 90);
  assert.equal(report.body.report.totals.cogsKsh, 9000);
  assert.equal(report.body.report.totals.grossMarginPercent, -9900);
  assert.equal(report.body.report.shiftGaps.signedKsh, -3.83);

  const monthly = await request(app)
    .get(`/api/reports/monthly?year=${TODAY.slice(0, 4)}&month=${Number(TODAY.slice(5, 7))}`)
    .set(bearer(adminToken));
  assert.equal(monthly.status, 200, JSON.stringify(monthly.body));
  assert.equal(monthly.body.report.bestDay.revenueKsh, 90);
  assert.equal(monthly.body.report.monthOverMonth.revenue.absoluteKsh, 90);
});

test('backup validation and operational clear preserve credentials, fuel configuration, prices, pumps, and audit evidence', async () => {
  const before = await request(app).get('/api/fuel').set(bearer(adminToken));
  const priceBefore = before.body.data[0].sellingPriceKsh;

  const backupResponse = await request(app).get('/api/admin/backup').set(bearer(adminToken));
  assert.equal(backupResponse.status, 200);
  const snapshot = backupResponse.body;
  assert.equal(snapshot.schemaVersion, 2);
  assert.equal(snapshot.tables.schema_migrations.rows.length, 2);

  const corrupt = refreshChecksum(structuredClone(snapshot));
  corrupt.tables.fuel_management.rows[0].stock_litres = 999;
  const rejected = await request(app)
    .post('/api/admin/restore')
    .set(bearer(adminToken))
    .send({ snapshot: corrupt });
  assert.equal(rejected.status, 400);

  const laterRestock = await request(app)
    .post('/api/restock')
    .set(bearer(adminToken))
    .send({ fuelId, quantityLitres: 10, unitCostKsh: 100, supplier: 'Post Snapshot Supplier' });
  assert.equal(laterRestock.status, 201);

  const restored = await request(app)
    .post('/api/admin/restore')
    .set(bearer(adminToken))
    .send({ snapshot });
  assert.equal(restored.status, 200, JSON.stringify(restored.body));
  const restoredFuel = await request(app).get('/api/fuel').set(bearer(adminToken));
  assert.equal(restoredFuel.body.data[0].quantityLitres, 800);
  assert.equal(restoredFuel.body.data[0].sellingPriceKsh, priceBefore);

  const cleared = await request(app)
    .post('/api/admin/clear-operational-data')
    .set(bearer(adminToken))
    .send({ confirmation: 'CLEAR OPERATIONAL DATA' });
  assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
  assert.deepEqual(cleared.body.excluded, ['users', 'app_settings', 'audit_logs', 'fuel_management', 'pumps']);

  const fuelAfterClear = await request(app).get('/api/fuel').set(bearer(adminToken));
  assert.equal(fuelAfterClear.body.data.length, 1);
  assert.equal(fuelAfterClear.body.data[0].fuelType, 'DIESEL');
  assert.equal(fuelAfterClear.body.data[0].quantityLitres, 0);
  assert.equal(fuelAfterClear.body.data[0].sellingPriceKsh, priceBefore);
  const pumpsAfterClear = await request(app).get('/api/pumps').set(bearer(adminToken));
  assert.equal(pumpsAfterClear.body.data.length, 1);
  assert.equal(pumpsAfterClear.body.data[0].pumpCode, 'PUMP-A');

  const stillAuthenticated = await request(app).get('/api/auth/me').set(bearer(adminToken));
  assert.equal(stillAuthenticated.status, 200);
  const audit = await request(app)
    .get('/api/audit?event=operational_data_cleared')
    .set(bearer(adminToken));
  assert.equal(audit.status, 200);
  assert.equal(audit.body.data.length, 1);
});

test('production configuration is fail-fast and the readiness endpoint validates schema v2', async () => {
  assert.throws(() => loadConfig({
    NODE_ENV: 'production',
    PORT: '3000',
    JWT_SECRET: 'Vivid!Harbor73#Q-Production-Smoke-2026-Strong-42#Secure',
    DATABASE_URL: 'data/relative.sqlite',
    FRONTEND_ORIGINS: 'https://station.example.test',
  }), /absolute persistent SQLite path/);
  assert.throws(() => loadConfig({
    NODE_ENV: 'production',
    PORT: '3000',
    JWT_SECRET: 'Vivid!Harbor73#Q-Production-Smoke-2026-Strong-42#Secure',
    DATABASE_URL: ':memory:',
    FRONTEND_ORIGINS: 'https://station.example.test',
  }), /in-memory|absolute persistent SQLite path/);
  assert.throws(() => loadConfig({
    NODE_ENV: 'production',
    PORT: '3000',
    JWT_SECRET: 'Vivid!Harbor73#Q-Production-Smoke-2026-Strong-42#Secure',
    DATABASE_URL: 'C:/data/station.sqlite',
    FRONTEND_ORIGINS: 'http://station.example.test',
  }), /HTTPS/);

  const productionDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zenenergies-production-'));
  const productionPath = path.join(productionDir, 'production.sqlite');
  let productionDb;
  try {
    const productionConfig = loadConfig({
      NODE_ENV: 'production',
      PORT: '3000',
      JWT_SECRET: 'Vivid!Harbor73#Q-Production-Smoke-2026-Strong-42#Secure',
      DATABASE_URL: productionPath,
      FRONTEND_ORIGINS: 'https://station.example.test',
      ADMIN_USERNAME: 'production.admin',
      ADMIN_PASSWORD: 'Cobalt!Harbor29#Q',
      ADMIN_FULL_NAME: 'Production Admin',
      LOG_LEVEL: 'silent',
    });
    productionDb = createDatabase(productionPath);
    await bootstrapAdmin(productionDb, productionConfig, createLogger({ test: true }));
    const productionApp = createApp({ db: productionDb, config: productionConfig, logger: createLogger({ test: true }) });
    const health = await request(productionApp).get('/api/health');
    assert.equal(health.status, 200, JSON.stringify(health.body));
    assert.equal(health.body.status, 'ok');
    assert.equal(health.body.schemaVersion, 2);
    assert.equal(productionDb.prepare("SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND is_active = 1").get().count, 1);
    assert.equal(productionDb.prepare('SELECT COUNT(*) AS count FROM sales').get().count, 0);
  } finally {
    if (productionDb?.open) closeDatabase(productionDb);
    fs.rmSync(productionDir, { recursive: true, force: true });
  }
});
