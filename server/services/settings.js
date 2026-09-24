import { DateTime } from 'luxon';

export const DEFAULT_SETTINGS = Object.freeze({
  stationName: 'ZENENERGIES Station',
  currency: 'KSh',
  timezone: 'Africa/Nairobi',
  dateFormat: 'yyyy-MM-dd',
  language: 'en',
  lowStockThresholdLitres: 400,
  auditRetentionDays: 365,
  interfaceOptions: Object.freeze({
    theme: 'system',
    compactTables: false,
    showStationClock: true,
  }),
  notifications: Object.freeze({
    lowStock: true,
    shiftReminders: true,
    dailySummary: true,
    salesAlerts: false,
  }),
});

export const SETTING_KEYS = Object.freeze({
  stationName: 'station_name',
  timezone: 'timezone',
  dateFormat: 'date_format',
  language: 'language',
  lowStockThresholdLitres: 'low_stock_threshold_litres',
  auditRetentionDays: 'audit_retention_days',
  interfaceOptions: 'interface_options',
  notifications: 'notifications',
});

export function getSettings(db) {
  const rows = db.prepare('SELECT key, value_json FROM app_settings').all();
  const settings = structuredClone(DEFAULT_SETTINGS);
  const byKey = new Map(rows.map((row) => [row.key, row.value_json]));
  const parse = (key, fallback) => {
    if (!byKey.has(key)) return fallback;
    try {
      return JSON.parse(byKey.get(key));
    } catch {
      return fallback;
    }
  };

  settings.stationName = parse(SETTING_KEYS.stationName, settings.stationName);
  settings.timezone = parse(SETTING_KEYS.timezone, settings.timezone);
  settings.dateFormat = parse(SETTING_KEYS.dateFormat, settings.dateFormat);
  settings.language = parse(SETTING_KEYS.language, settings.language);
  settings.lowStockThresholdLitres = parse(SETTING_KEYS.lowStockThresholdLitres, settings.lowStockThresholdLitres);
  settings.auditRetentionDays = parse(SETTING_KEYS.auditRetentionDays, settings.auditRetentionDays);
  settings.interfaceOptions = parse(SETTING_KEYS.interfaceOptions, settings.interfaceOptions);
  settings.notifications = parse(SETTING_KEYS.notifications, settings.notifications);
  return settings;
}

export function upsertSettings(db, updates, actorId, tx = db) {
  const statement = tx.prepare(`
    INSERT INTO app_settings (key, value_json, updated_by, updated_at)
    VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
    ON CONFLICT(key) DO UPDATE SET
      value_json = excluded.value_json,
      updated_by = excluded.updated_by,
      updated_at = excluded.updated_at
  `);
  for (const [property, value] of Object.entries(updates)) {
    const key = SETTING_KEYS[property];
    if (!key || value === undefined) continue;
    statement.run(key, JSON.stringify(value), actorId);
  }
}

export function publicSettings(db) {
  const settings = getSettings(db);
  return {
    stationName: settings.stationName,
    currency: settings.currency,
    timezone: settings.timezone,
    dateFormat: settings.dateFormat,
    language: settings.language,
    interfaceOptions: settings.interfaceOptions,
  };
}

export function userSettings(db, user) {
  const settings = publicSettings(db);
  return { ...settings, role: user.role, username: user.username };
}

export function adminSettings(db) {
  return getSettings(db);
}

export function getDateRange(db, from, to) {
  const settings = getSettings(db);
  const zone = settings.timezone;
  if (!DateTime.local().setZone(zone).isValid) throw new Error('Configured station timezone is invalid');
  const start = DateTime.fromISO(from, { zone }).startOf('day');
  const end = DateTime.fromISO(to, { zone }).endOf('day');
  if (!start.isValid || !end.isValid || start > end) throw new Error('Invalid report date range');
  return { startUtc: start.toUTC().toISO(), endUtc: end.toUTC().toISO(), zone };
}
