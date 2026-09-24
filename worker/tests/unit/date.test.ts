import { describe, expect, it } from 'vitest';
import { dateKey, getDateRange, monthRange, previousMonth } from '../../src/date';

describe('station date boundaries', () => {
  it('uses the configured IANA timezone for day keys', () => {
    expect(dateKey('2026-01-01T00:30:00.000Z', 'Africa/Nairobi')).toBe('2026-01-01');
    expect(dateKey('2026-01-01T23:30:00.000Z', 'Africa/Nairobi')).toBe('2026-01-02');
  });

  it('returns UTC boundaries and month arithmetic', () => {
    const range = getDateRange('2026-01-01', '2026-01-01', 'Africa/Nairobi');
    expect(range.startUtc).toBe('2025-12-31T21:00:00.000Z');
    expect(range.endUtc).toBe('2026-01-01T20:59:59.999Z');
    expect(monthRange(2026, 2, 'Africa/Nairobi')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(previousMonth(2026, 1)).toEqual({ year: 2025, month: 12 });
  });
});
