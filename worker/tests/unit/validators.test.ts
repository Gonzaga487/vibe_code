import { describe, expect, it } from 'vitest';
import { saleSchema, settingsPatchSchema } from '../../src/validators';

describe('API validation contracts', () => {
  it('accepts amount-only Quick Tally and rejects unsupported fuel', () => {
    const result = saleSchema.safeParse({ mode: 'quick', paymentMethod: 'cash', amountKsh: 333.33 });
    expect(result.success).toBe(true);
    expect(saleSchema.safeParse({ mode: 'quick', paymentMethod: 'cash', amountKsh: 1, fuelType: 'KEROSENE' }).success).toBe(false);
  });

  it('requires a valid IANA timezone for settings changes', () => {
    expect(settingsPatchSchema.safeParse({ timezone: 'Africa/Nairobi' }).success).toBe(true);
    expect(settingsPatchSchema.safeParse({ timezone: 'not/a-zone' }).success).toBe(false);
  });
});
