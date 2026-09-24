import { badRequest, conflict, tooLarge } from './errors';
import { first } from './db';
import { SETTING_KEYS } from './settings';
import type { AuthUser, DbRow } from './types';

export const SNAPSHOT_TABLES = [
  'schema_migrations', 'users', 'app_settings', 'fuel_management', 'pumps', 'shifts', 'restocks',
  'stock_adjustments', 'sales', 'expenses', 'pump_readings', 'sales_readings', 'inventory_lots',
  'inventory_movements', 'inventory_allocations', 'audit_logs',
] as const;

export type SnapshotTable = typeof SNAPSHOT_TABLES[number];
export const INSERT_ORDER: SnapshotTable[] = [
  'app_settings', 'users', 'fuel_management', 'pumps', 'shifts', 'restocks', 'stock_adjustments',
  'sales', 'expenses', 'pump_readings', 'sales_readings', 'inventory_lots', 'inventory_movements',
  'inventory_allocations', 'audit_logs',
];
export const DELETE_ORDER: SnapshotTable[] = [
  'inventory_allocations', 'inventory_movements', 'inventory_lots', 'sales_readings', 'pump_readings',
  'expenses', 'sales', 'stock_adjustments', 'restocks', 'shifts', 'pumps', 'fuel_management',
  'users', 'app_settings', 'audit_logs',
];

export interface ColumnMeta { name: string; type: string; notNull: boolean; primaryKey: boolean; defaultValue: string | null }
export interface Snapshot {
  format: 'zenenergies-sqlite-json';
  formatVersion: 1;
  schemaVersion: number;
  exportedAt: string;
  tables: Record<string, { columns: ColumnMeta[]; rows: DbRow[] }>;
  checksum: string;
}

const encoder = new TextEncoder();

export async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', encoder.encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function tableMetadata(db: D1Database, table: string): Promise<ColumnMeta[]> {
  if (!(SNAPSHOT_TABLES as readonly string[]).includes(table)) throw new Error('Unsafe snapshot table');
  const result = await db.prepare(`PRAGMA table_info("${table}")`).all<{
    name: string; type: string; notnull: number; pk: number; dflt_value: string | null;
  }>();
  return result.results.map((row) => ({
    name: row.name, type: row.type, notNull: Boolean(row.notnull), primaryKey: Boolean(row.pk), defaultValue: row.dflt_value,
  }));
}

export async function createSnapshot(db: D1Database, schemaVersion: number): Promise<Snapshot> {
  let rowCount = 0;
  for (const table of SNAPSHOT_TABLES) {
    const count = await first<DbRow>(db, `SELECT COUNT(*) AS count FROM "${table}"`);
    rowCount += Number(count?.count || 0);
    if (rowCount > 20_000) throw tooLarge('Snapshot exceeds the 20,000-row safe D1 backup limit');
  }
  const tables: Snapshot['tables'] = {};
  for (const table of SNAPSHOT_TABLES) {
    const [columns, result] = await Promise.all([
      tableMetadata(db, table),
      db.prepare(`SELECT * FROM "${table}"`).all<DbRow>(),
    ]);
    tables[table] = { columns, rows: result.results };
  }
  const snapshotBase = { format: 'zenenergies-sqlite-json' as const, formatVersion: 1 as const, schemaVersion, exportedAt: new Date().toISOString(), tables };
  return { ...snapshotBase, checksum: await sha256Hex(JSON.stringify({ schemaVersion, tables })) };
}

function plainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function validateCell(value: unknown, column: ColumnMeta, table: string, index: number): void {
  if (value === null) {
    if (column.notNull && !column.primaryKey) throw badRequest(`Snapshot ${table} row ${index} has null ${column.name}`);
    return;
  }
  if (column.type === 'INTEGER' && !Number.isSafeInteger(value)) throw badRequest(`Snapshot ${table} row ${index} has invalid integer ${column.name}`);
  if (column.type === 'REAL' && (typeof value !== 'number' || !Number.isFinite(value))) throw badRequest(`Snapshot ${table} row ${index} has invalid number ${column.name}`);
  if (column.type === 'TEXT' && typeof value !== 'string') throw badRequest(`Snapshot ${table} row ${index} has invalid text ${column.name}`);
}

function requireReference(value: unknown, ids: Set<number>, label: string): void {
  if (value !== null && (!Number.isSafeInteger(value) || !ids.has(Number(value)))) throw badRequest(`Snapshot contains ${label}`);
}

export async function validateSnapshot(db: D1Database, candidate: unknown, schemaVersion: number, requiredAdmin: AuthUser): Promise<Snapshot> {
  if (!plainObject(candidate)) throw badRequest('snapshot must be a JSON object');
  const topKeys = ['format', 'formatVersion', 'schemaVersion', 'exportedAt', 'tables', 'checksum'];
  if (Object.keys(candidate).length !== topKeys.length || Object.keys(candidate).some((key) => !topKeys.includes(key))) {
    throw badRequest('Snapshot has unknown or missing top-level fields');
  }
  if (candidate.format !== 'zenenergies-sqlite-json' || candidate.formatVersion !== 1) throw badRequest('Unsupported backup format');
  if (candidate.schemaVersion !== schemaVersion) throw badRequest(`Snapshot schema version must be ${schemaVersion}`);
  if (typeof candidate.exportedAt !== 'string' || Number.isNaN(Date.parse(candidate.exportedAt))) throw badRequest('Snapshot exportedAt is invalid');
  if (!plainObject(candidate.tables)) throw badRequest('Snapshot tables must be an object');
  const names = Object.keys(candidate.tables);
  if (names.length !== SNAPSHOT_TABLES.length || names.some((name) => !(SNAPSHOT_TABLES as readonly string[]).includes(name))) {
    throw badRequest('Snapshot tables do not exactly match the server table allowlist');
  }
  const tables = candidate.tables as unknown as Snapshot['tables'];
  if (candidate.checksum !== await sha256Hex(JSON.stringify({ schemaVersion: candidate.schemaVersion, tables }))) {
    throw badRequest('Snapshot checksum verification failed');
  }
  let totalRows = 0;
  for (const table of SNAPSHOT_TABLES) {
    const supplied = tables[table];
    const expected = await tableMetadata(db, table);
    if (!plainObject(supplied) || !Array.isArray(supplied.columns) || !Array.isArray(supplied.rows)) throw badRequest(`Snapshot table ${table} is malformed`);
    if (supplied.columns.length !== expected.length) throw badRequest(`Snapshot table ${table} has the wrong column count`);
    for (let index = 0; index < expected.length; index += 1) {
      if (JSON.stringify(supplied.columns[index]) !== JSON.stringify(expected[index])) throw badRequest(`Snapshot table ${table} column metadata does not match the server schema`);
    }
    const names = expected.map((column) => column.name);
    const allowed = new Set(names);
    const primaryKeys = new Set<string>();
    for (let rowIndex = 0; rowIndex < supplied.rows.length; rowIndex += 1) {
      const row = supplied.rows[rowIndex];
      if (!plainObject(row) || Object.keys(row).length !== names.length || Object.keys(row).some((key) => !allowed.has(key))) {
        throw badRequest(`Snapshot ${table} row ${rowIndex} has unknown or missing columns`);
      }
      for (const column of expected) validateCell(row[column.name], column, table, rowIndex);
      const keyValues = expected.filter((column) => column.primaryKey).map((column) => row[column.name]);
      if (keyValues.length) {
        const key = JSON.stringify(keyValues);
        if (primaryKeys.has(key)) throw badRequest(`Snapshot ${table} contains a duplicate primary key`);
        primaryKeys.add(key);
      }
    }
    totalRows += supplied.rows.length;
    if (totalRows > 20_000) throw tooLarge('Snapshot restore is limited to 20,000 rows per atomic D1 batch');
  }

  const migrationRows = tables.schema_migrations.rows;
  const versions = migrationRows.map((row) => Number(row.version));
  if (versions.at(-1) !== schemaVersion || new Set(versions).size !== versions.length) throw badRequest('Snapshot migration metadata is invalid');
  const users = tables.users.rows;
  if (!users.some((row) => row.role === 'admin' && row.is_active === 1)) throw badRequest('Snapshot must contain at least one active administrator');
  if (users.some((row) => typeof row.password_hash !== 'string' || !/^\$2[aby]\$\d{2}\$/.test(row.password_hash))) throw badRequest('Snapshot contains an invalid authentication password record');
  const restoringAdmin = users.find((row) => Number(row.id) === requiredAdmin.id);
  if (!restoringAdmin || restoringAdmin.username !== requiredAdmin.username || restoringAdmin.role !== 'admin'
    || restoringAdmin.is_active !== 1 || Number(restoringAdmin.session_version) !== requiredAdmin.session_version) {
    throw badRequest('Snapshot does not contain the current administrator with a matching session; restore would invalidate this request session');
  }

  const ids = Object.fromEntries(SNAPSHOT_TABLES.map((table) => [table, new Set(tables[table].rows.map((row) => Number(row.id)))])) as Record<string, Set<number>>;
  for (const row of users) requireReference(row.created_by, ids.users || new Set(), 'an orphaned user creator');
  const allowedSettings = new Set<string>(Object.values(SETTING_KEYS));
  for (const setting of tables.app_settings.rows) {
    requireReference(setting.updated_by, ids.users || new Set(), 'an orphaned setting editor');
    if (!allowedSettings.has(String(setting.key))) throw badRequest('Snapshot contains an unknown application setting');
    let value: unknown;
    try { value = JSON.parse(String(setting.value_json)); } catch { throw badRequest('Snapshot contains invalid setting JSON'); }
    if (setting.key === SETTING_KEYS.stationName && (typeof value !== 'string' || value.length < 2 || value.length > 100)) throw badRequest('Snapshot station name setting is invalid');
    if (setting.key === SETTING_KEYS.timezone && (typeof value !== 'string' || value.length < 1 || value.length > 100)) throw badRequest('Snapshot timezone setting is invalid');
    if (setting.key === SETTING_KEYS.dateFormat && !['yyyy-MM-dd', 'dd/MM/yyyy', 'MM/dd/yyyy'].includes(String(value))) throw badRequest('Snapshot date format setting is invalid');
    if (setting.key === SETTING_KEYS.language && !['en', 'sw'].includes(String(value))) throw badRequest('Snapshot language setting is invalid');
    if (setting.key === SETTING_KEYS.lowStockThresholdLitres && (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 10_000_000)) throw badRequest('Snapshot low-stock threshold setting is invalid');
    if (setting.key === SETTING_KEYS.auditRetentionDays && (!Number.isInteger(value) || Number(value) < 30 || Number(value) > 3650)) throw badRequest('Snapshot audit retention setting is invalid');
  }
  for (const row of tables.audit_logs.rows) {
    requireReference(row.actor_id, ids.users || new Set(), 'an orphaned audit actor');
    requireReference(row.user_id, ids.users || new Set(), 'an orphaned audit user');
  }
  for (const row of tables.fuel_management.rows) {
    if (!['PETROL', 'DIESEL'].includes(String(row.fuel_type))) throw badRequest('Snapshot contains an unsupported fuel type');
    if (Math.abs(Number(row.quantity) - Number(row.stock_litres)) > 0.001 || Math.abs(Number(row.selling_price_cents) / 100 - Number(row.price_per_litre)) > 0.001) throw badRequest('Snapshot fuel aliases do not reconcile');
  }
  for (const row of tables.pumps.rows) requireReference(row.fuel_id, ids.fuel_management || new Set(), 'an orphaned pump');
  for (const row of tables.shifts.rows) { requireReference(row.user_id, ids.users || new Set(), 'an orphaned shift user'); requireReference(row.attendant_id, ids.users || new Set(), 'an orphaned shift attendant'); }
  for (const row of tables.restocks.rows) {
    requireReference(row.fuel_id, ids.fuel_management || new Set(), 'an orphaned restock');
    requireReference(row.created_by, ids.users || new Set(), 'an orphaned restock creator');
    if (Math.abs(Number(row.quantity) - Number(row.litres_added)) > 0.001 || Number(row.total_cost_cents) !== Math.round(Number(row.quantity) * Number(row.unit_cost_cents))) throw badRequest('Snapshot restock totals do not reconcile');
  }
  for (const row of tables.stock_adjustments.rows) {
    requireReference(row.fuel_id, ids.fuel_management || new Set(), 'an orphaned adjustment');
    requireReference(row.created_by, ids.users || new Set(), 'an orphaned adjustment creator');
    if (Math.abs(Number(row.new_stock) - Number(row.old_stock) - Number(row.quantity)) > 0.001) throw badRequest('Snapshot stock adjustment totals do not reconcile');
  }
  for (const row of tables.sales.rows) {
    requireReference(row.shift_id, ids.shifts || new Set(), 'an orphaned sale shift');
    requireReference(row.user_id, ids.users || new Set(), 'an orphaned sale user');
    if (row.fuel_id !== null) requireReference(row.fuel_id, ids.fuel_management || new Set(), 'an orphaned sale fuel');
    if (row.pump_id !== null) requireReference(row.pump_id, ids.pumps || new Set(), 'an orphaned sale pump');
    if (Number(row.amount_cents) !== Number(row.total_cents) || Number(row.cash_cents) + Number(row.mpesa_cents) !== Number(row.amount_cents)) throw badRequest('Snapshot sale totals do not reconcile');
  }
  for (const table of ['expenses', 'pump_readings', 'sales_readings'] as const) {
    for (const row of tables[table].rows) {
      requireReference(row.user_id, ids.users || new Set(), 'an orphaned operational actor');
      if (table === 'expenses') requireReference(row.shift_id, ids.shifts || new Set(), 'an orphaned expense shift');
      else requireReference(row.fuel_id, ids.fuel_management || new Set(), 'an orphaned operational fuel');
    }
  }
  const lotsById = new Map(tables.inventory_lots.rows.map((lot) => [Number(lot.id), lot]));
  for (const lot of tables.inventory_lots.rows) {
    requireReference(lot.fuel_id, ids.fuel_management || new Set(), 'an orphaned inventory lot');
    if (lot.restock_id !== null) requireReference(lot.restock_id, ids.restocks || new Set(), 'an orphaned restock lot');
    if (lot.adjustment_id !== null) requireReference(lot.adjustment_id, ids.stock_adjustments || new Set(), 'an orphaned adjustment lot');
  }
  const movementsById = new Map(tables.inventory_movements.rows.map((movement) => [Number(movement.id), movement]));
  const lotQuantity = new Map<number, number>();
  for (const lot of tables.inventory_lots.rows) lotQuantity.set(Number(lot.fuel_id), (lotQuantity.get(Number(lot.fuel_id)) || 0) + Number(lot.remaining_quantity));
  for (const fuel of tables.fuel_management.rows) {
    if (Math.abs(Number(fuel.quantity) - (lotQuantity.get(Number(fuel.id)) || 0)) > 0.01) throw badRequest('Snapshot fuel quantities do not reconcile with inventory lots');
  }
  for (const movement of tables.inventory_movements.rows) {
    requireReference(movement.fuel_id, ids.fuel_management || new Set(), 'an orphaned inventory movement');
    requireReference(movement.created_by, ids.users || new Set(), 'an orphaned inventory actor');
    if (movement.reversal_movement_id !== null) requireReference(movement.reversal_movement_id, ids.inventory_movements || new Set(), 'an orphaned inventory reversal');
    if (Math.abs(Number(movement.stock_after) - Number(movement.stock_before) - Number(movement.signed_quantity)) > 0.01) throw badRequest('Snapshot inventory movement quantities do not reconcile');
  }
  const allocationTotals = new Map<number, { quantity: number; costCents: number }>();
  for (const allocation of tables.inventory_allocations.rows) {
    const movement = movementsById.get(Number(allocation.movement_id));
    const lot = lotsById.get(Number(allocation.lot_id));
    if (!movement || !lot || Number(movement.fuel_id) !== Number(lot.fuel_id)) throw badRequest('Snapshot contains an orphaned inventory allocation');
    const value = allocationTotals.get(Number(allocation.movement_id)) || { quantity: 0, costCents: 0 };
    value.quantity += Number(allocation.quantity);
    value.costCents += Math.round(Number(allocation.quantity) * Number(allocation.unit_cost_cents));
    allocationTotals.set(Number(allocation.movement_id), value);
  }
  for (const movement of tables.inventory_movements.rows) {
    if (Number(movement.signed_quantity) >= 0 || movement.source_type === 'restock') continue;
    const allocation = allocationTotals.get(Number(movement.id));
    if (!allocation || Math.abs(allocation.quantity + Number(movement.signed_quantity)) > 0.01 || allocation.costCents !== Math.abs(Number(movement.signed_cost_cents))) {
      throw badRequest('Snapshot consumption movement does not reconcile to its FIFO allocations');
    }
  }
  return { ...(candidate as unknown as Snapshot), tables };
}

export async function restoreSnapshot(
  db: D1Database,
  snapshot: Snapshot,
  audit: { id: number; sql: string; bindings: Array<string | number | null> },
): Promise<Record<string, number>> {
  const metadata = new Map<SnapshotTable, ColumnMeta[]>();
  for (const table of SNAPSHOT_TABLES) metadata.set(table, await tableMetadata(db, table));
  const statements = [
    db.prepare('PRAGMA defer_foreign_keys = ON'),
    db.prepare('DELETE FROM idempotency_records'),
    db.prepare('DELETE FROM api_operations'),
    ...DELETE_ORDER.map((table) => db.prepare(`DELETE FROM "${table}"`)),
  ];
  for (const table of INSERT_ORDER) {
    const columns = metadata.get(table) || [];
    for (const row of snapshot.tables[table]?.rows || []) {
      const names = columns.map((column) => `"${column.name}"`).join(', ');
      const placeholders = columns.map(() => '?').join(', ');
      statements.push(db.prepare(`INSERT INTO "${table}" (${names}) VALUES (${placeholders})`).bind(...columns.map((column) => row[column.name])));
    }
  }
  statements.push(db.prepare(audit.sql).bind(...audit.bindings));
  try {
    await db.batch(statements);
  } catch (error) {
    throw conflict(error instanceof Error && /constraint/i.test(error.message) ? 'Snapshot violates database constraints' : 'Snapshot restore failed');
  }
  const foreignKeys = await first(db, 'PRAGMA foreign_key_check');
  if (foreignKeys) throw conflict('Snapshot would violate database relationships');
  return Object.fromEntries(INSERT_ORDER.map((table) => [table, snapshot.tables[table]?.rows.length || 0]));
}
