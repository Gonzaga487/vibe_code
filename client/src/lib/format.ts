import type { DateFormat, FuelType } from '@/types/api';

const kshFormatter = new Intl.NumberFormat('en-KE', {
  style: 'currency',
  currency: 'KES',
  currencyDisplay: 'code',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const numberFormatter = new Intl.NumberFormat('en-KE', {
  minimumFractionDigits: 0,
  maximumFractionDigits: 3,
});

export function formatKsh(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  const formatted = kshFormatter.format(value).replace('KES', 'KSh');
  return formatted.replace(/\s/g, ' ');
}

export function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return numberFormatter.format(value);
}

export function formatLitres(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return '—';
  return `${numberFormatter.format(value)} L`;
}

export function formatPercent(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'No comparison';
  return `${value.toFixed(digits)}%`;
}

export function parseDateKey(value: string): Date {
  return new Date(`${value}T00:00:00`);
}

export function toDateKey(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

export function formatDateKey(value: string | null | undefined, pattern: DateFormat = 'yyyy-MM-dd'): string {
  if (!value) return '—';
  const parts = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!parts) return value;
  const [, year, month, day] = parts;
  if (!year || !month || !day) return value;
  if (pattern === 'dd/MM/yyyy') return `${day}/${month}/${year}`;
  if (pattern === 'MM/dd/yyyy') return `${month}/${day}/${year}`;
  return `${year}-${month}-${day}`;
}

export function formatDateTime(value: string | null | undefined, timezone?: string): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('en-KE', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: timezone,
  }).format(date);
}

export function formatTime(value: string | null | undefined, timezone?: string): string {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('en-KE', { timeStyle: 'short', timeZone: timezone }).format(date);
}

export function fuelLabel(value: FuelType | string): string {
  return value.charAt(0) + value.slice(1).toLowerCase();
}

export function titleCase(value: string): string {
  return value.replaceAll('_', ' ').toLowerCase().replace(/(^|\s)\S/g, (letter) => letter.toUpperCase());
}

export function initials(name: string): string {
  return name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() || '')
    .join('') || 'ZE';
}

export function todayKey(): string {
  return toDateKey(new Date());
}

export function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

export function startOfWeek(date = new Date()): Date {
  const result = new Date(date);
  const day = result.getDay();
  result.setDate(result.getDate() - (day === 0 ? 6 : day - 1));
  result.setHours(0, 0, 0, 0);
  return result;
}

export function endOfMonth(date = new Date()): Date {
  return new Date(date.getFullYear(), date.getMonth() + 1, 0);
}

export function greeting(date = new Date()): string {
  const hour = date.getHours();
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}
