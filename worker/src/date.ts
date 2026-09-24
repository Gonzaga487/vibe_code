import { badRequest } from './errors';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function utcMilliseconds(year: number, month: number, day: number, hour = 0, minute = 0, second = 0, millisecond = 0): number {
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  date.setUTCHours(hour, minute, second, millisecond);
  return date.getTime();
}

export function isIsoDate(value: string): boolean {
  if (!DATE_RE.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  if (year === undefined || month === undefined || day === undefined) return false;
  const date = new Date(utcMilliseconds(year, month, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function assertDateRange(from: string, to: string): void {
  if (!isIsoDate(from) || !isIsoDate(to)) throw badRequest('from and to must be valid ISO dates');
  if (from > to) throw badRequest('to cannot be before from');
}

export function dateDifferenceDays(from: string, to: string): number {
  assertDateRange(from, to);
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}

export function enumerateDates(from: string, to: string): string[] {
  assertDateRange(from, to);
  const dates: string[] = [];
  let cursor = `${from}T00:00:00Z`;
  const end = `${to}T00:00:00Z`;
  while (Date.parse(cursor) <= Date.parse(end)) {
    dates.push(cursor.slice(0, 10));
    cursor = new Date(Date.parse(cursor) + 86_400_000).toISOString();
  }
  return dates;
}

export function isValidTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat('en', { timeZone: timezone }).format();
    return true;
  } catch {
    return false;
  }
}

function zonedParts(date: Date, timezone: string): Record<string, number> {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const output: Record<string, number> = {};
  for (const part of parts) {
    if (part.type !== 'literal') output[part.type] = Number(part.value);
  }
  return output;
}

export function dateKey(value: string | Date, timezone: string): string {
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) throw badRequest('Timestamp is invalid');
  if (!isValidTimezone(timezone)) throw badRequest('Configured station timezone is invalid');
  const parts = zonedParts(date, timezone);
  return `${String(parts.year).padStart(4, '0')}-${String(parts.month).padStart(2, '0')}-${String(parts.day).padStart(2, '0')}`;
}

export function todayInTimezone(timezone: string, now = new Date()): string {
  return dateKey(now, timezone);
}

export function zonedBoundaryUtc(date: string, timezone: string, endOfDay = false): string {
  if (!isIsoDate(date)) throw badRequest('Date is invalid');
  if (!isValidTimezone(timezone)) throw badRequest('Configured station timezone is invalid');
  const [year, month, day] = date.split('-').map(Number);
  if (endOfDay) {
    const next = new Date(utcMilliseconds(year ?? 1970, month ?? 1, (day ?? 1) + 1));
    const nextDate = `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-${String(next.getUTCDate()).padStart(2, '0')}`;
    return new Date(Date.parse(zonedBoundaryUtc(nextDate, timezone, false)) - 1).toISOString();
  }
  const target = utcMilliseconds(year ?? 1970, month ?? 1, day ?? 1);
  let guess = target;
  for (let iteration = 0; iteration < 4; iteration += 1) {
    const parts = zonedParts(new Date(guess), timezone);
    const represented = utcMilliseconds(
      parts.year ?? year ?? 1970,
      parts.month ?? month ?? 1,
      parts.day ?? day ?? 1,
      parts.hour ?? 0,
      parts.minute ?? 0,
      parts.second ?? 0,
    );
    guess += target - represented;
  }
  return new Date(guess).toISOString();
}

export interface DateRange {
  startUtc: string;
  endUtc: string;
  zone: string;
}

export function getDateRange(from: string, to: string, timezone: string): DateRange {
  assertDateRange(from, to);
  return {
    startUtc: zonedBoundaryUtc(from, timezone, false),
    endUtc: zonedBoundaryUtc(to, timezone, true),
    zone: timezone,
  };
}

export function monthRange(year: number, month: number, timezone: string): { from: string; to: string } {
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    throw badRequest('Monthly report year or month is invalid');
  }
  const from = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-01`;
  const next = new Date(Date.UTC(year, month, 1));
  const last = new Date(next.getTime() - 86_400_000).getUTCDate();
  return { from, to: `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(last).padStart(2, '0')}` };
}

export function previousMonth(year: number, month: number): { year: number; month: number } {
  const date = new Date(Date.UTC(year, month - 2, 1));
  return { year: date.getUTCFullYear(), month: date.getUTCMonth() + 1 };
}
