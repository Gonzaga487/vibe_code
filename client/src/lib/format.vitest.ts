import { describe, expect, it } from 'vitest';
import { buildQuery } from '@/lib/api';
import { formatDateKey, formatKsh, formatLitres, toDateKey } from '@/lib/format';

describe('KSh and operational formatting', () => {
  it('always formats money as KSh and never as an unqualified currency symbol', () => {
    expect(formatKsh(0)).toContain('KSh');
    expect(formatKsh(1250.5)).toContain('KSh');
    expect(formatKsh(null)).toBe('—');
  });

  it('formats litres and configured date patterns', () => {
    expect(formatLitres(12.345)).toBe('12.345 L');
    expect(formatDateKey('2026-09-23', 'dd/MM/yyyy')).toBe('23/09/2026');
    expect(toDateKey(new Date(2026, 8, 23))).toBe('2026-09-23');
  });
});

describe('API query construction', () => {
  it('omits empty optional values and preserves booleans', () => {
    expect(buildQuery({ page: 1, search: '', active: false, fuelId: undefined })).toBe('?page=1&active=false');
  });
});
