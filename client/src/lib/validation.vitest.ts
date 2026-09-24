import { describe, expect, it } from 'vitest';
import { dateRangeError, firstError, nonNegativeNumber, passwordError, usernameError } from '@/lib/validation';

describe('client-side validation', () => {
  it('enforces the backend-aligned password policy', () => {
    expect(passwordError('short')).toMatch(/12 characters/);
    expect(passwordError('alllowercase1!')).toMatch(/upper and lower/);
    expect(passwordError('Valid!Station73')).toBeNull();
  });

  it('enforces the server username character set', () => {
    expect(usernameError('ab')).toMatch(/3–32/);
    expect(usernameError('attendant.one')).toBeNull();
  });

  it('rejects negative operational values and reversed date ranges', () => {
    expect(nonNegativeNumber('-1', 'Amount')).toMatch(/cannot be negative/);
    expect(nonNegativeNumber('0', 'Amount')).toBeNull();
    expect(dateRangeError('2026-09-23', '2026-09-22')).toMatch(/cannot be before/);
    expect(firstError(null, 'Second problem', null)).toBe('Second problem');
  });
});
