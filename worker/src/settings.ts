import { all, first } from './db';
import { parseJson } from './http';
import type { AuthUser, DbRow } from './types';

export interface StationSettings {
  stationName: string;
  currency: 'KSh';
  timezone: string;
  dateFormat: 'yyyy-MM-dd' | 'dd/MM/yyyy' | 'MM/dd/yyyy';
  language: 'en' | 'sw';
  lowStockThresholdLitres: number;
  auditRetentionDays: number;
  interfaceOptions: {
    theme: 'system' | 'light' | 'dark';
    compactTables: boolean;
    showStationClock: boolean;
  };
  notifications: {
    lowStock: boolean;
    shiftReminders: boolean;
    dailySummary: boolean;
    salesAlerts: boolean;
  };
}

export const DEFAULT_SETTINGS: Readonly<StationSettings> = Object.freeze({
  stationName: 'ZENENERGIES Station',
  currency: 'KSh',
  timezone: 'Africa/Nairobi',
  dateFormat: 'yyyy-MM-dd',
  language: 'en',
  lowStockThresholdLitres: 400,
  auditRetentionDays: 365,
  interfaceOptions: Object.freeze({ theme: 'system', compactTables: false, showStationClock: true }),
  notifications: Object.freeze({ lowStock: true, shiftReminders: true, dailySummary: true, salesAlerts: false }),
});

export const SETTING_KEYS = {
  stationName: 'station_name',
  timezone: 'timezone',
  dateFormat: 'date_format',
  language: 'language',
  lowStockThresholdLitres: 'low_stock_threshold_litres',
  auditRetentionDays: 'audit_retention_days',
  interfaceOptions: 'interface_options',
  notifications: 'notifications',
} as const;

export async function getSettings(db: D1Database): Promise<StationSettings> {
  const rows = await all<DbRow>(db, 'SELECT key, value_json FROM app_settings');
  const values = new Map(rows.map((row) => [String(row.key), String(row.value_json)]));
  const parsed = <T>(key: string, fallback: T): T => parseJson(values.get(key), fallback);
  return {
    stationName: parsed(SETTING_KEYS.stationName, DEFAULT_SETTINGS.stationName),
    currency: 'KSh',
    timezone: parsed(SETTING_KEYS.timezone, DEFAULT_SETTINGS.timezone),
    dateFormat: parsed(SETTING_KEYS.dateFormat, DEFAULT_SETTINGS.dateFormat),
    language: parsed(SETTING_KEYS.language, DEFAULT_SETTINGS.language),
    lowStockThresholdLitres: parsed(SETTING_KEYS.lowStockThresholdLitres, DEFAULT_SETTINGS.lowStockThresholdLitres),
    auditRetentionDays: parsed(SETTING_KEYS.auditRetentionDays, DEFAULT_SETTINGS.auditRetentionDays),
    interfaceOptions: {
      ...DEFAULT_SETTINGS.interfaceOptions,
      ...parsed<Partial<StationSettings['interfaceOptions']>>(SETTING_KEYS.interfaceOptions, {}),
    },
    notifications: {
      ...DEFAULT_SETTINGS.notifications,
      ...parsed<Partial<StationSettings['notifications']>>(SETTING_KEYS.notifications, {}),
    },
  };
}

export function publicSettings(settings: StationSettings) {
  return {
    stationName: settings.stationName,
    currency: settings.currency,
    timezone: settings.timezone,
    dateFormat: settings.dateFormat,
    language: settings.language,
    interfaceOptions: settings.interfaceOptions,
  };
}

export function userSettings(settings: StationSettings, user: AuthUser) {
  return { ...publicSettings(settings), role: user.role, username: user.username };
}

export function settingUpsertStatement(key: string, value: unknown, actorId: number, operationId: string) {
  return {
    sql: `
      INSERT INTO app_settings (key, value_json, updated_by, updated_at)
      SELECT ?, ?, ?, ?
      WHERE EXISTS (SELECT 1 FROM api_operations WHERE id = ?)
      ON CONFLICT(key) DO UPDATE SET
        value_json = excluded.value_json,
        updated_by = excluded.updated_by,
        updated_at = excluded.updated_at
    `,
    bindings: [key, JSON.stringify(value), actorId, new Date().toISOString(), operationId],
  };
}

export async function currentAdminCount(db: D1Database, excludingId?: number): Promise<number> {
  const row = excludingId
    ? await first<DbRow>(db, "SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND is_active = 1 AND id != ?", excludingId)
    : await first<DbRow>(db, "SELECT COUNT(*) AS count FROM users WHERE role = 'admin' AND is_active = 1");
  return Number(row?.count || 0);
}
