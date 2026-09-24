import { Router } from 'express';
import { z } from 'zod';
import { DateTime } from 'luxon';
import { getPagination, money, paginated, parseId, roundLitres } from '../lib/http.js';
import { badRequest, conflict, forbidden, notFound } from '../lib/errors.js';
import { validate } from '../middleware/validate.js';
import { recordAudit } from '../services/audit.js';
import { consumeInventory, getFuelOrThrow, inventoryAlertsForResponse, reverseConsumption } from '../services/inventory.js';
import { getSettings } from '../services/settings.js';

const readingBaseSchema = z.object({
  fuelId: z.coerce.number().int().positive().safe().optional(),
  fuelType: z.enum(['PETROL', 'DIESEL']).optional(),
  date: z.iso.date().optional(),
  readingDate: z.iso.date().optional(),
  openingLitres: z.number().finite().nonnegative().max(1000000000000).optional(),
  openingReading: z.number().finite().nonnegative().max(1000000000000).optional(),
  openingKsh: z.number().finite().nonnegative().max(1000000000000).optional(),
  closingLitres: z.number().finite().nonnegative().max(1000000000000).optional(),
  closingReading: z.number().finite().nonnegative().max(1000000000000).optional(),
  closingKsh: z.number().finite().nonnegative().max(1000000000000).optional(),
  previousClosing: z.number().finite().nonnegative().max(1000000000000).optional(),
  prevClosingLitres: z.number().finite().nonnegative().max(1000000000000).optional(),
  prevClosingKsh: z.number().finite().nonnegative().max(1000000000000).optional(),
  meterReference: z.string().trim().min(1).max(100).optional(),
  notes: z.string().trim().max(1000).optional(),
}).strict();

const readingCreateSchema = readingBaseSchema.superRefine((value, context) => {
  if (!value.fuelId && !value.fuelType) context.addIssue({ code: 'custom', path: ['fuelId'], message: 'A fuel type is required' });
  if (!value.date && !value.readingDate) context.addIssue({ code: 'custom', path: ['date'], message: 'A reading date is required' });
  const opening = value.openingLitres ?? value.openingReading ?? value.openingKsh;
  const closing = value.closingLitres ?? value.closingReading ?? value.closingKsh;
  if (opening === undefined) context.addIssue({ code: 'custom', path: ['openingLitres'], message: 'An opening reading is required' });
  if (closing === undefined) context.addIssue({ code: 'custom', path: ['closingLitres'], message: 'A closing reading is required' });
  if (value.openingLitres !== undefined && value.openingReading !== undefined && value.openingLitres !== value.openingReading) context.addIssue({ code: 'custom', path: ['openingReading'], message: 'Opening aliases do not match' });
  if (value.closingLitres !== undefined && value.closingReading !== undefined && value.closingLitres !== value.closingReading) context.addIssue({ code: 'custom', path: ['closingReading'], message: 'Closing aliases do not match' });
});

const readingPatchSchema = readingBaseSchema.partial().refine((value) => Object.keys(value).length > 0, 'At least one field is required');
const backdateSchema = readingBaseSchema.partial().refine((value) => value.date !== undefined || value.readingDate !== undefined, 'A reading date is required');

const listSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
  fuelId: z.coerce.number().int().positive().optional(),
  userId: z.coerce.number().int().positive().optional(),
}).strict().refine((value) => !value.from || !value.to || value.from <= value.to, 'from cannot be after to');

function assertNotFuture(db, date) {
  if (date > DateTime.now().setZone(getSettings(db).timezone).toISODate()) throw badRequest('reading date cannot be in the future');
}

function readingSelect(table) {
  return `
    SELECT r.*, u.username, u.full_name, COALESCE(r.fuel_type, f.fuel_type) AS fuel_type
    FROM ${table} r
    JOIN users u ON u.id = r.user_id
    JOIN fuel_management f ON f.id = r.fuel_id
  `;
}

function serializeReading(row, role) {
  const isPump = row.__kind === 'pump';
  const response = {
    id: row.id,
    date: row.date,
    readingDate: row.date,
    fuel: { id: row.fuel_id, type: row.fuel_type },
    user: { id: row.user_id, username: row.username, fullName: row.full_name },
    opening: isPump ? row.opening_litres : row.opening_ksh,
    closing: isPump ? row.closing_litres : row.closing_ksh,
    previousClosing: isPump ? row.prev_closing_litres : row.prev_closing_ksh,
    openingLitres: isPump ? row.opening_litres : undefined,
    closingLitres: isPump ? row.closing_litres : undefined,
    previousClosingLitres: isPump ? row.prev_closing_litres : undefined,
    openingKsh: !isPump ? row.opening_ksh : undefined,
    closingKsh: !isPump ? row.closing_ksh : undefined,
    previousClosingKsh: !isPump ? row.prev_closing_ksh : undefined,
    meterReference: row.meter_reference,
    notes: row.notes,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (role === 'admin') {
    if (isPump) {
      response.consumptionLitres = row.consumption;
      response.unitPriceKsh = money(row.reconciliation_price_cents);
      response.reconciliationKsh = money(row.reconciliation_value_cents);
      if (row.stock_before !== null && row.stock_after !== null) response.stockImpact = { beforeLitres: row.stock_before, afterLitres: row.stock_after };
    } else {
      response.consumptionKsh = money(row.reconciliation_value_cents);
      response.reconciliationKsh = money(row.reconciliation_value_cents);
    }
  }
  return response;
}

function roundReadingValue(value, isPump) {
  return isPump ? roundLitres(value) : Math.round((Number(value) + Number.EPSILON) * 100) / 100;
}

function getFuelForInput(db, body, current) {
  if (body.fuelType && body.fuelId) {
    const fuel = getFuelOrThrow(db, body.fuelId, { active: true });
    if (fuel.fuel_type !== body.fuelType) throw badRequest('fuelType does not match fuelId');
    return fuel;
  }
  if (body.fuelType) {
    const fuel = db.prepare('SELECT * FROM fuel_management WHERE fuel_type = ? AND is_active = 1').get(body.fuelType);
    if (!fuel) throw notFound('Fuel type was not found');
    return fuel;
  }
  if (body.fuelId !== undefined) return getFuelOrThrow(db, body.fuelId, { active: true });
  if (current) return getFuelOrThrow(db, current.fuel_id, { active: true });
  throw badRequest('A fuel type is required');
}

function readCanonicalValue(body, current, kind, field) {
  const isPump = kind === 'pump';
  const aliases = isPump
    ? { opening: ['openingLitres', 'openingReading'], closing: ['closingLitres', 'closingReading'], previous: ['prevClosingLitres', 'previousClosing'] }
    : { opening: ['openingKsh'], closing: ['closingKsh', 'closingReading'], previous: ['prevClosingKsh', 'previousClosing'] };
  const currentValues = isPump
    ? { opening: current?.opening_litres, closing: current?.closing_litres, previous: current?.prev_closing_litres }
    : { opening: current?.opening_ksh, closing: current?.closing_ksh, previous: current?.prev_closing_ksh };
  const values = {};
  for (const [name, keys] of Object.entries(aliases)) {
    const supplied = keys.map((key) => body[key]).find((value) => value !== undefined);
    values[name] = supplied === undefined ? currentValues[name] : supplied;
  }
  void field;
  return values;
}

function previousForInput(db, table, fuelId, date, current, supplied) {
  if (supplied !== undefined) return supplied;
  const prior = current
    ? db.prepare(`SELECT closing_reading FROM ${table} WHERE fuel_id = ? AND reading_date < ? AND id != ? ORDER BY reading_date DESC, id DESC LIMIT 1`).get(fuelId, date, current.id)
    : db.prepare(`SELECT closing_reading FROM ${table} WHERE fuel_id = ? AND reading_date < ? ORDER BY reading_date DESC, id DESC LIMIT 1`).get(fuelId, date);
  return prior?.closing_reading;
}

function prepareReading(db, table, kind, body, current = null) {
  const isPump = kind === 'pump';
  const fuel = getFuelForInput(db, body, current);
  const date = body.date || body.readingDate || current?.date || current?.reading_date;
  if (!date) throw badRequest('A reading date is required');
  assertNotFuture(db, date);
  const values = readCanonicalValue(body, current, kind);
  let opening = values.opening;
  let closing = values.closing;
  let previous = values.previous;
  if (opening === undefined) throw badRequest(isPump ? 'openingLitres is required' : 'openingKsh is required');
  if (closing === undefined) throw badRequest(isPump ? 'closingLitres is required' : 'closingKsh is required');
  previous = previousForInput(db, table, fuel.id, date, current, previous);
  if (previous === undefined) throw badRequest(isPump ? 'prevClosingLitres is required' : 'prevClosingKsh is required');
  opening = roundReadingValue(opening, isPump);
  closing = roundReadingValue(closing, isPump);
  previous = roundReadingValue(previous, isPump);
  if (closing < previous) throw badRequest(isPump ? 'closingLitres cannot be lower than prevClosingLitres' : 'closingKsh cannot be lower than prevClosingKsh');
  const consumption = roundReadingValue(closing - previous, isPump);
  return {
    fuel,
    date,
    opening,
    closing,
    previous,
    consumption,
    meterReference: body.meterReference || `${fuel.fuel_type} METER`,
    notes: body.notes === undefined ? current?.notes ?? null : (body.notes || null),
  };
}

export function createReadingsRouter({ db, kind }) {
  const isPump = kind === 'pump';
  const table = isPump ? 'pump_readings' : 'sales_readings';
  const sourceType = isPump ? 'pump_reading' : 'sales_reading';
  const router = Router();
  const selectById = db.prepare(`${readingSelect(table)} WHERE r.id = ?`);

  function scopedReading(req) {
    const row = db.prepare(`${readingSelect(table)} WHERE r.id = ?`).get(parseId(req.params.id));
    if (!row) throw notFound('Reading was not found');
    if (req.auth.user.role !== 'admin' && row.user_id !== req.auth.user.id) throw forbidden('You can only access your own meter readings');
    row.__kind = kind;
    return row;
  }

  router.get('/', validate(listSchema, 'query'), (req, res) => {
    const filters = req.validatedQuery;
    const pagination = getPagination(filters);
    const where = [];
    const params = [];
    if (req.auth.user.role !== 'admin') {
      where.push('r.user_id = ?');
      params.push(req.auth.user.id);
    } else if (filters.userId) {
      where.push('r.user_id = ?');
      params.push(filters.userId);
    }
    if (filters.fuelId) { where.push('r.fuel_id = ?'); params.push(filters.fuelId); }
    if (filters.from) { where.push('r."date" >= ?'); params.push(filters.from); }
    if (filters.to) { where.push('r."date" <= ?'); params.push(filters.to); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const rows = db.prepare(`${readingSelect(table)} ${clause} ORDER BY r.date DESC, r.id DESC LIMIT ? OFFSET ?`).all(...params, pagination.pageSize, pagination.offset);
    const total = db.prepare(`SELECT COUNT(*) AS count FROM ${table} r ${clause}`).get(...params).count;
    res.json(paginated(rows.map((row) => ({ ...row, __kind: kind })), total, pagination, (row) => serializeReading(row, req.auth.user.role)));
  });

  router.post('/', validate(readingCreateSchema), (req, res) => {
    const prepared = prepareReading(db, table, kind, req.body);
    const id = db.transaction(() => {
      const result = db.prepare(`
        INSERT INTO ${table} (
          fuel_id, user_id, reading_date, previous_closing, closing_reading, consumption,
          reconciliation_price_cents, meter_reference, notes, "date", fuel_type,
          opening_litres, closing_litres, prev_closing_litres,
          opening_ksh, closing_ksh, prev_closing_ksh, reconciliation_value_cents
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const canonicalOpening = isPump ? prepared.opening : 0;
      const canonicalClosing = isPump ? prepared.closing : 0;
      const canonicalPrevious = isPump ? prepared.previous : 0;
      const reconciliationCents = isPump
        ? Math.round(prepared.consumption * prepared.fuel.selling_price_cents)
        : Math.round(prepared.consumption * 100);
      let insertResult;
      if (isPump) {
        insertResult = result.run(
          prepared.fuel.id, req.auth.user.id, prepared.date, prepared.previous, prepared.closing, prepared.consumption,
          prepared.fuel.selling_price_cents, prepared.meterReference, prepared.notes, prepared.date, prepared.fuel.fuel_type,
          canonicalOpening, canonicalClosing, canonicalPrevious, 0, 0, 0, reconciliationCents,
        );
      } else {
        insertResult = result.run(
          prepared.fuel.id, req.auth.user.id, prepared.date, prepared.previous, prepared.closing, prepared.consumption,
          prepared.fuel.selling_price_cents, prepared.meterReference, prepared.notes, prepared.date, prepared.fuel.fuel_type,
          0, 0, 0, prepared.opening, prepared.closing, prepared.previous, reconciliationCents,
        );
      }
      const readingId = Number(insertResult.lastInsertRowid);
      if (isPump && prepared.consumption > 0) {
        const impact = consumeInventory(db, { fuelId: prepared.fuel.id, quantity: prepared.consumption, sourceType, sourceId: readingId, actorId: req.auth.user.id });
        db.prepare('UPDATE pump_readings SET stock_before = ?, stock_after = ? WHERE id = ?').run(impact.stockBefore, impact.stockAfter, readingId);
      }
      recordAudit(db, {
        req,
        category: 'reading',
        event: isPump ? 'reading.pump_created' : 'reading.sales_meter_created',
        metadata: { readingId, fuelId: prepared.fuel.id, date: prepared.date, consumption: prepared.consumption },
      });
      return readingId;
    })();
    const row = { ...selectById.get(id), __kind: kind };
    res.status(201).json({ reading: serializeReading(row, req.auth.user.role), lowStockAlerts: inventoryAlertsForResponse(db, req.auth.user) });
  });

  function updateReading(req, res) {
    const current = scopedReading(req);
    const prepared = prepareReading(db, table, kind, req.body, current);
    const measurementChanged = prepared.fuel.id !== current.fuel_id
      || prepared.date !== current.date
      || prepared.opening !== (isPump ? current.opening_litres : current.opening_ksh)
      || prepared.closing !== (isPump ? current.closing_litres : current.closing_ksh)
      || prepared.previous !== (isPump ? current.prev_closing_litres : current.prev_closing_ksh);
    db.transaction(() => {
      if (isPump && measurementChanged) reverseConsumption(db, { sourceType, sourceId: current.id, actorId: req.auth.user.id });
      const reconciliationCents = isPump
        ? Math.round(prepared.consumption * prepared.fuel.selling_price_cents)
        : Math.round(prepared.consumption * 100);
      db.prepare(`
        UPDATE ${table}
        SET fuel_id = ?, reading_date = ?, previous_closing = ?, closing_reading = ?, consumption = ?,
            reconciliation_price_cents = ?, meter_reference = ?, notes = ?,
            stock_before = CASE WHEN ? THEN NULL ELSE stock_before END,
            stock_after = CASE WHEN ? THEN NULL ELSE stock_after END,
            "date" = ?, fuel_type = ?, opening_litres = ?, closing_litres = ?, prev_closing_litres = ?,
            opening_ksh = ?, closing_ksh = ?, prev_closing_ksh = ?, reconciliation_value_cents = ?,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ?
      `).run(
        prepared.fuel.id,
        prepared.date,
        prepared.previous,
        prepared.closing,
        prepared.consumption,
        prepared.fuel.selling_price_cents,
        prepared.meterReference,
        prepared.notes,
        isPump && measurementChanged ? 1 : 0,
        isPump && measurementChanged ? 1 : 0,
        prepared.date,
        prepared.fuel.fuel_type,
        isPump ? prepared.opening : 0,
        isPump ? prepared.closing : 0,
        isPump ? prepared.previous : 0,
        isPump ? 0 : prepared.opening,
        isPump ? 0 : prepared.closing,
        isPump ? 0 : prepared.previous,
        reconciliationCents,
        current.id,
      );
      if (isPump && measurementChanged && prepared.consumption > 0) {
        const impact = consumeInventory(db, { fuelId: prepared.fuel.id, quantity: prepared.consumption, sourceType, sourceId: current.id, actorId: req.auth.user.id });
        db.prepare('UPDATE pump_readings SET stock_before = ?, stock_after = ? WHERE id = ?').run(impact.stockBefore, impact.stockAfter, current.id);
      }
      recordAudit(db, {
        req,
        category: 'reading',
        event: isPump ? 'reading.pump_updated' : 'reading.sales_meter_updated',
        metadata: { readingId: current.id, fields: Object.keys(req.body), consumption: prepared.consumption },
      });
    })();
    const row = { ...selectById.get(current.id), __kind: kind };
    res.json({ reading: serializeReading(row, req.auth.user.role), lowStockAlerts: inventoryAlertsForResponse(db, req.auth.user) });
    return current.id;
  }

  router.patch('/:id', validate(readingPatchSchema), updateReading);
  router.post('/:id/backdate', validate(backdateSchema), updateReading);

  router.delete('/:id', (req, res) => {
    const current = scopedReading(req);
    db.transaction(() => {
      if (isPump) reverseConsumption(db, { sourceType, sourceId: current.id, actorId: req.auth.user.id });
      db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(current.id);
      recordAudit(db, {
        req,
        category: 'reading',
        event: isPump ? 'reading.pump_deleted' : 'reading.sales_meter_deleted',
        metadata: { readingId: current.id, fuelId: current.fuel_id, date: current.date },
      });
    })();
    res.json({ deleted: true, id: current.id, lowStockAlerts: inventoryAlertsForResponse(db, req.auth.user) });
  });

  return router;
}
