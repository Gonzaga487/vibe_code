import crypto from 'node:crypto';
import { DateTime } from 'luxon';
import { badRequest } from '../lib/errors.js';
import { recordAudit } from './audit.js';
import { SETTING_KEYS } from './settings.js';

export const SNAPSHOT_TABLES = Object.freeze([
  'schema_migrations',
  'users',
  'app_settings',
  'fuel_management',
  'pumps',
  'shifts',
  'restocks',
  'stock_adjustments',
  'sales',
  'expenses',
  'pump_readings',
  'sales_readings',
  'inventory_lots',
  'inventory_movements',
  'inventory_allocations',
  'audit_logs',
]);

const INSERT_ORDER = [
  'app_settings',
  'users',
  'fuel_management',
  'pumps',
  'shifts',
  'restocks',
  'stock_adjustments',
  'sales',
  'expenses',
  'pump_readings',
  'sales_readings',
  'inventory_lots',
  'inventory_movements',
  'inventory_allocations',
  'audit_logs',
];

const DELETE_ORDER = [
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
  'pumps',
  'fuel_management',
  'users',
  'app_settings',
  'audit_logs',
];

function tableMetadata(db, table) {
  return db.pragma(`table_info("${table}")`).map((column) => ({
    name: column.name,
    type: column.type,
    notNull: Boolean(column.notnull),
    primaryKey: Boolean(column.pk),
    defaultValue: column.dflt_value,
  }));
}

function checksum(schemaVersion, tables) {
  return crypto.createHash('sha256').update(JSON.stringify({ schemaVersion, tables })).digest('hex');
}

export function createSnapshot(db, schemaVersion) {
  const tables = {};
  for (const table of SNAPSHOT_TABLES) {
    tables[table] = {
      columns: tableMetadata(db, table),
      rows: db.prepare(`SELECT * FROM "${table}"`).all(),
    };
  }
  return {
    format: 'zenenergies-sqlite-json',
    formatVersion: 1,
    schemaVersion,
    exportedAt: new Date().toISOString(),
    tables,
    checksum: checksum(schemaVersion, tables),
  };
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validateColumnValue(value, column, table, rowIndex) {
  if (value === null) {
    if (column.notNull && !column.primaryKey) throw badRequest(`Snapshot ${table} row ${rowIndex} has null ${column.name}`);
    return;
  }
  if (column.type === 'INTEGER' && !Number.isSafeInteger(value)) {
    throw badRequest(`Snapshot ${table} row ${rowIndex} has invalid integer ${column.name}`);
  }
  if (column.type === 'REAL' && (typeof value !== 'number' || !Number.isFinite(value))) {
    throw badRequest(`Snapshot ${table} row ${rowIndex} has invalid number ${column.name}`);
  }
  if (column.type === 'TEXT' && typeof value !== 'string') {
    throw badRequest(`Snapshot ${table} row ${rowIndex} has invalid text ${column.name}`);
  }
  if (!['INTEGER', 'REAL', 'TEXT'].includes(column.type)) {
    throw badRequest(`Snapshot table ${table} uses unsupported column type ${column.type}`);
  }
}

export function validateSnapshot(db, candidate, { schemaVersion, requiredAdmin }) {
  if (!isPlainObject(candidate)) throw badRequest('snapshot must be a JSON object');
  const snapshotKeys = ['format', 'formatVersion', 'schemaVersion', 'exportedAt', 'tables', 'checksum'];
  if (Object.keys(candidate).length !== snapshotKeys.length || Object.keys(candidate).some((key) => !snapshotKeys.includes(key))) {
    throw badRequest('Snapshot has unknown or missing top-level fields');
  }
  if (candidate.format !== 'zenenergies-sqlite-json' || candidate.formatVersion !== 1) {
    throw badRequest('Unsupported backup format');
  }
  if (candidate.schemaVersion !== schemaVersion) {
    throw badRequest(`Snapshot schema version must be ${schemaVersion}`);
  }
  if (typeof candidate.exportedAt !== 'string' || Number.isNaN(Date.parse(candidate.exportedAt))) {
    throw badRequest('Snapshot exportedAt is invalid');
  }
  if (!isPlainObject(candidate.tables)) throw badRequest('Snapshot tables must be an object');
  const tableNames = Object.keys(candidate.tables);
  const allowed = [...SNAPSHOT_TABLES].sort();
  if (tableNames.length !== allowed.length || tableNames.some((name) => !allowed.includes(name))) {
    throw badRequest('Snapshot tables do not exactly match the server table allowlist');
  }
  if (candidate.checksum !== checksum(candidate.schemaVersion, candidate.tables)) {
    throw badRequest('Snapshot checksum verification failed');
  }

  let totalRows = 0;
  for (const table of SNAPSHOT_TABLES) {
    const expectedColumns = tableMetadata(db, table);
    const supplied = candidate.tables[table];
    if (!isPlainObject(supplied)
      || Object.keys(supplied).length !== 2
      || !Object.keys(supplied).every((key) => ['columns', 'rows'].includes(key))
      || !Array.isArray(supplied.columns)
      || !Array.isArray(supplied.rows)) {
      throw badRequest(`Snapshot table ${table} is malformed`);
    }
    if (supplied.columns.length !== expectedColumns.length) throw badRequest(`Snapshot table ${table} has the wrong column count`);
    for (let index = 0; index < expectedColumns.length; index += 1) {
      const actual = supplied.columns[index];
      const expected = expectedColumns[index];
      const columnKeys = ['name', 'type', 'notNull', 'primaryKey', 'defaultValue'];
      if (!isPlainObject(actual)
        || Object.keys(actual).length !== columnKeys.length
        || Object.keys(actual).some((key) => !columnKeys.includes(key))
        || actual.name !== expected.name
        || actual.type !== expected.type
        || actual.notNull !== expected.notNull
        || actual.primaryKey !== expected.primaryKey
        || actual.defaultValue !== expected.defaultValue) {
        throw badRequest(`Snapshot table ${table} column metadata does not match the server schema`);
      }
    }
    if (supplied.rows.length > 500000) throw badRequest(`Snapshot table ${table} has too many rows`);
    totalRows += supplied.rows.length;
    if (totalRows > 500000) throw badRequest('Snapshot has too many rows');
    const expectedNames = expectedColumns.map((column) => column.name);
    const expectedSet = new Set(expectedNames);
    const primaryKeys = new Set();
    for (let rowIndex = 0; rowIndex < supplied.rows.length; rowIndex += 1) {
      const row = supplied.rows[rowIndex];
      if (!isPlainObject(row)) throw badRequest(`Snapshot ${table} row ${rowIndex} must be an object`);
      const keys = Object.keys(row);
      if (keys.length !== expectedNames.length || keys.some((key) => !expectedSet.has(key))) {
        throw badRequest(`Snapshot ${table} row ${rowIndex} has unknown or missing columns`);
      }
      for (const column of expectedColumns) validateColumnValue(row[column.name], column, table, rowIndex);
      const keyValues = expectedColumns.filter((column) => column.primaryKey).map((column) => row[column.name]);
      if (keyValues.length) {
        const key = JSON.stringify(keyValues);
        if (primaryKeys.has(key)) throw badRequest(`Snapshot ${table} contains a duplicate primary key`);
        primaryKeys.add(key);
      }
    }
  }

  const migrationRows = candidate.tables.schema_migrations.rows;
  const migrationVersions = migrationRows.map((row) => row.version);
  if (migrationRows.length < 1
    || migrationRows.some((row) => !Number.isSafeInteger(row.version) || row.version < 1)
    || migrationVersions.at(-1) !== schemaVersion
    || new Set(migrationVersions).size !== migrationVersions.length) {
    throw badRequest('Snapshot migration metadata is invalid');
  }
  const users = candidate.tables.users.rows;
  const activeAdmins = users.filter((user) => user.role === 'admin' && user.is_active === 1);
  if (!activeAdmins.length) throw badRequest('Snapshot must contain at least one active administrator');
  if (users.some((user) => typeof user.password_hash !== 'string' || !/^\$2[aby]\$\d{2}\$/.test(user.password_hash))) {
    throw badRequest('Snapshot contains an invalid authentication password record');
  }
  if (users.some((user) => !Number.isSafeInteger(user.session_version) || user.session_version < 0)) {
    throw badRequest('Snapshot contains an invalid user session version');
  }
  const restoringAdmin = users.find((user) => user.id === requiredAdmin.id);
  if (!restoringAdmin
    || restoringAdmin.username !== requiredAdmin.username
    || restoringAdmin.role !== 'admin'
    || restoringAdmin.is_active !== 1
    || restoringAdmin.session_version !== requiredAdmin.sessionVersion) {
    throw badRequest('Snapshot does not contain the current administrator with a matching session; restore would invalidate this request session');
  }

  const allowedSettings = new Set(Object.values(SETTING_KEYS));
  const userIds = new Set(users.map((user) => user.id));
  for (const setting of candidate.tables.app_settings.rows) {
    if (!allowedSettings.has(setting.key)) throw badRequest('Snapshot contains an unknown application setting');
    if (setting.updated_by !== null && !userIds.has(setting.updated_by)) throw badRequest('Snapshot setting references an unknown user');
    let value;
    try {
      value = JSON.parse(setting.value_json);
    } catch {
      throw badRequest('Snapshot contains invalid setting JSON');
    }
    if (setting.key === SETTING_KEYS.stationName && (typeof value !== 'string' || value.length < 2 || value.length > 100)) {
      throw badRequest('Snapshot station name setting is invalid');
    }
    if (setting.key === SETTING_KEYS.timezone && (typeof value !== 'string' || !DateTime.local().setZone(value).isValid)) {
      throw badRequest('Snapshot timezone setting is invalid');
    }
    if (setting.key === SETTING_KEYS.dateFormat && !['yyyy-MM-dd', 'dd/MM/yyyy', 'MM/dd/yyyy'].includes(value)) {
      throw badRequest('Snapshot date format setting is invalid');
    }
    if (setting.key === SETTING_KEYS.language && !['en', 'sw'].includes(value)) {
      throw badRequest('Snapshot language setting is invalid');
    }
    if (setting.key === SETTING_KEYS.lowStockThresholdLitres && (!Number.isFinite(value) || value < 0 || value > 10000000)) {
      throw badRequest('Snapshot low-stock threshold setting is invalid');
    }
    if (setting.key === SETTING_KEYS.auditRetentionDays && (!Number.isInteger(value) || value < 30 || value > 3650)) {
      throw badRequest('Snapshot audit retention setting is invalid');
    }
    if (setting.key === SETTING_KEYS.interfaceOptions) {
      const valid = isPlainObject(value)
        && (value.theme === undefined || ['system', 'light', 'dark'].includes(value.theme))
        && (value.compactTables === undefined || typeof value.compactTables === 'boolean')
        && (value.showStationClock === undefined || typeof value.showStationClock === 'boolean');
      if (!valid) throw badRequest('Snapshot interface options setting is invalid');
    }
    if (setting.key === SETTING_KEYS.notifications) {
      const valid = isPlainObject(value)
        && ['lowStock', 'shiftReminders', 'dailySummary', 'salesAlerts']
          .every((key) => value[key] === undefined || typeof value[key] === 'boolean');
      if (!valid) throw badRequest('Snapshot notification settings are invalid');
    }
  }

  for (const fuel of candidate.tables.fuel_management.rows) {
    if (!['PETROL', 'DIESEL'].includes(fuel.fuel_type)) throw badRequest('Snapshot contains an unsupported fuel type');
    if (Math.abs(fuel.quantity - fuel.stock_litres) > 0.001) throw badRequest('Snapshot fuel stock aliases do not match');
    if (Math.abs(fuel.selling_price_cents / 100 - fuel.price_per_litre) > 0.001) throw badRequest('Snapshot fuel price aliases do not match');
  }
  for (const restock of candidate.tables.restocks.rows) {
    if (Math.abs(restock.quantity - restock.litres_added) > 0.001
      || Math.abs(restock.unit_cost_cents / 100 - restock.cost_per_litre) > 0.001
      || restock.total_cost_cents !== Math.round(restock.quantity * restock.unit_cost_cents)) {
      throw badRequest('Snapshot restock totals do not reconcile');
    }
  }
  for (const adjustment of candidate.tables.stock_adjustments.rows) {
    if (Math.abs((adjustment.new_stock - adjustment.old_stock) - adjustment.quantity) > 0.001
      || Math.abs(adjustment.old_stock - adjustment.previous_quantity) > 0.001
      || Math.abs(adjustment.new_stock - adjustment.new_quantity) > 0.001) {
      throw badRequest('Snapshot stock adjustment totals do not reconcile');
    }
  }
  for (const sale of candidate.tables.sales.rows) {
    if (sale.amount_cents !== sale.total_cents
      || Math.abs(sale.amount - sale.amount_cents / 100) > 0.001
      || sale.cash_cents + sale.mpesa_cents !== sale.amount_cents) {
      throw badRequest('Snapshot sale totals do not reconcile');
    }
  }

  const lotQuantities = new Map();
  for (const lot of candidate.tables.inventory_lots.rows) {
    lotQuantities.set(lot.fuel_id, (lotQuantities.get(lot.fuel_id) || 0) + lot.remaining_quantity);
  }
  for (const fuel of candidate.tables.fuel_management.rows) {
    const lotQuantity = lotQuantities.get(fuel.id) || 0;
    if (Math.abs(fuel.quantity - lotQuantity) > 0.01) {
      throw badRequest('Snapshot fuel quantities do not reconcile with inventory lots');
    }
  }
  const lotsById = new Map(candidate.tables.inventory_lots.rows.map((lot) => [lot.id, lot]));
  const movementsById = new Map(candidate.tables.inventory_movements.rows.map((movement) => [movement.id, movement]));
  for (const movement of candidate.tables.inventory_movements.rows) {
    if (Math.abs(movement.stock_after - (movement.stock_before + movement.signed_quantity)) > 0.01) {
      throw badRequest('Snapshot inventory movement quantities do not reconcile');
    }
    if (movement.reversal_movement_id !== null && !movementsById.has(movement.reversal_movement_id)) {
      throw badRequest('Snapshot contains an orphaned inventory reversal');
    }
  }
  const allocationTotals = new Map();
  for (const allocation of candidate.tables.inventory_allocations.rows) {
    const movement = movementsById.get(allocation.movement_id);
    const lot = lotsById.get(allocation.lot_id);
    if (!movement || !lot) throw badRequest('Snapshot contains an orphaned inventory allocation');
    if (movement.fuel_id !== lot.fuel_id) throw badRequest('Snapshot inventory allocation crosses fuel types');
    const total = allocationTotals.get(allocation.movement_id) || { quantity: 0, costCents: 0 };
    total.quantity += allocation.quantity;
    total.costCents += Math.round(allocation.quantity * allocation.unit_cost_cents);
    allocationTotals.set(allocation.movement_id, total);
  }
  for (const movement of candidate.tables.inventory_movements.rows) {
    if (movement.signed_quantity >= 0 || movement.source_type === 'restock') continue;
    const allocation = allocationTotals.get(movement.id);
    if (!allocation
      || Math.abs(allocation.quantity + movement.signed_quantity) > 0.01
      || allocation.costCents !== Math.abs(movement.signed_cost_cents)) {
      throw badRequest('Snapshot consumption movement does not reconcile to its FIFO allocations');
    }
  }
  return candidate;
}

export function restoreSnapshot(db, snapshot, { req, schemaVersion }) {
  const columnsByTable = Object.fromEntries(SNAPSHOT_TABLES.map((table) => [table, tableMetadata(db, table).map((column) => column.name)]));

  db.pragma('defer_foreign_keys = ON');
  try {
    const result = db.transaction(() => {
      for (const table of DELETE_ORDER) db.prepare(`DELETE FROM "${table}"`).run();
      for (const table of INSERT_ORDER) {
        const columns = columnsByTable[table];
        const statement = db.prepare(`
          INSERT INTO "${table}" (${columns.map((column) => `"${column}"`).join(', ')})
          VALUES (${columns.map(() => '?').join(', ')})
        `);
        for (const row of snapshot.tables[table].rows) statement.run(...columns.map((column) => row[column]));
      }
      // schema_migrations is verified above and intentionally not replaced.
      // Reset AUTOINCREMENT state so an empty restored table has the same identity sequence as its backup.
      db.prepare('DELETE FROM sqlite_sequence').run();
      const sequenceInsert = db.prepare('INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)');
      for (const table of INSERT_ORDER.filter((name) => columnsByTable[name].includes('id'))) {
        const maxId = db.prepare(`SELECT COALESCE(MAX(id), 0) AS max_id FROM "${table}"`).get().max_id;
        if (maxId > 0) sequenceInsert.run(table, maxId);
      }
      const foreignKeys = db.pragma('foreign_key_check');
      if (foreignKeys.length) throw badRequest('Snapshot would violate database relationships');
      const integrity = db.pragma('quick_check', { simple: true });
      if (integrity !== 'ok') throw badRequest('Restored database failed its integrity check');
      recordAudit(db, {
        req,
        category: 'admin',
        event: 'admin.restore_completed',
        metadata: { schemaVersion, tableCount: SNAPSHOT_TABLES.length },
        prune: false,
      });
      return Object.fromEntries(INSERT_ORDER.map((table) => [table, snapshot.tables[table].rows.length]));
    })();
    return result;
  } finally {
    db.pragma('defer_foreign_keys = OFF');
  }
}
