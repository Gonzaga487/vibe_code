import { afterEach, describe, expect, it, vi } from 'vitest';
import { request } from '@/lib/api';
import { stationApi } from '@/lib/stationApi';

vi.mock('@/lib/api', () => ({ request: vi.fn() }));

const mockedRequest = vi.mocked(request);

afterEach(() => mockedRequest.mockReset());

describe('station API v2 normalization', () => {
  it('accepts protected fuel records without prices', async () => {
    mockedRequest.mockResolvedValue({ data: [{ id: 1, fuelType: 'DIESEL', isActive: true }] });
    const fuels = await stationApi.fuels.list();
    expect(fuels).toEqual([expect.objectContaining({ id: 1, fuelType: 'DIESEL', sellingPriceKsh: null })]);
  });

  it('normalizes amount-only quick sales without inventing fuel', async () => {
    mockedRequest.mockResolvedValue({
      sale: {
        id: 9,
        shiftId: 2,
        user: { id: 3, username: 'attendant', fullName: 'Station Attendant' },
        mode: 'quick',
        amountKsh: 333.33,
        totalKsh: 333.33,
        fuel: null,
        pumpId: null,
        litres: null,
        payment: { method: 'cash', cashKsh: 333.33, mpesaKsh: 0 },
        soldAt: '2026-09-24T10:00:00.000Z',
        timestamp: '2026-09-24T10:00:00.000Z',
        createdAt: '2026-09-24T10:00:00.000Z',
      },
    });
    const sale = await stationApi.sales.create({ mode: 'quick', cashAmountKsh: 333.33, mpesaAmountKsh: 0 });
    expect(sale.amountKsh).toBe(333.33);
    expect(sale.fuel).toBeNull();
    expect(mockedRequest).toHaveBeenCalledWith('/sales', expect.objectContaining({
      method: 'POST',
      body: expect.objectContaining({ amountKsh: 333.33, mode: 'quick', paymentMethod: 'cash' }),
    }));
  });

  it('normalizes explicit pump and sales-meter units', async () => {
    mockedRequest.mockResolvedValue({
      reading: {
        id: 4,
        date: '2026-09-24',
        fuel: { id: 1, type: 'DIESEL' },
        user: { id: 3, username: 'attendant', fullName: 'Station Attendant' },
        opening: 800,
        closing: 890,
        previousClosing: 800,
        meterReference: 'SALES-A',
        reconciliationKsh: 90,
        consumptionKsh: 90,
        createdAt: '2026-09-24T10:00:00.000Z',
        updatedAt: '2026-09-24T10:00:00.000Z',
      },
    });
    const reading = await stationApi.readings.save('sales', null, {
      fuelId: 1,
      readingDate: '2026-09-24',
      opening: 800,
      previousClosing: 800,
      closingReading: 890,
      meterReference: 'SALES-A',
    });
    expect(reading.readingUnit).toBe('KSH');
    expect(reading.reconciliationKsh).toBe(90);
    expect(mockedRequest).toHaveBeenCalledWith('/sales-readings', expect.objectContaining({
      body: expect.objectContaining({ openingKsh: 800, closingKsh: 890, prevClosingKsh: 800 }),
    }));
  });
});
