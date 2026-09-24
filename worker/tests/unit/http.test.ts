import { describe, expect, it } from 'vitest';
import { csv, money, nonNegativeMoney, positiveMoney, roundLitres, toCents } from '../../src/http';

describe('KSh money and CSV helpers', () => {
  it('converts decimal KSh to exact integer cents without floating point drift', () => {
    expect(toCents(333.33)).toBe(33333);
    expect(toCents(100.49)).toBe(10049);
    expect(money(33333)).toBe(333.33);
    expect(positiveMoney(0.01)).toBe(1);
    expect(nonNegativeMoney(0)).toBe(0);
  });

  it('rejects unsupported money and rounds litres to three decimals', () => {
    expect(() => positiveMoney(-0.01)).toThrow();
    expect(() => toCents(Number.POSITIVE_INFINITY)).toThrow();
    expect(roundLitres(12.3456)).toBe(12.346);
  });

  it('escapes spreadsheet formulas in CSV cells', () => {
    expect(csv([['=HYPERLINK("bad")', 'plain']])).toContain('"\'=HYPERLINK');
  });
});
