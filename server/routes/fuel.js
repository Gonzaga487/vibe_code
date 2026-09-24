import { Router } from 'express';
import { z } from 'zod';
import { MAX_MONEY_CENTS, getPagination, money, nonNegativeMoney, paginated, parseId, positiveMoney, roundLitres } from '../lib/http.js';
import { badRequest, notFound } from '../lib/errors.js';
import { validate } from '../middleware/validate.js';
import { recordAudit } from '../services/audit.js';
import {
  addRestockInventory,
  applyAdjustmentInventory,
  getFuelOrThrow,
  getLowStockAlerts,
  getPumpOrThrow,
  removeRestock,
  reviseRestock,
} from '../services/inventory.js';

const fuelCreateSchema = z.object({
  fuelType: z.enum(['DIESEL', 'PETROL']),
  sellingPriceKsh: z.number().finite().positive(),
  tankCapacityLitres: z.number().finite().positive().max(10000000).optional(),
}).strict();

const fuelPatchSchema = z.object({
  sellingPriceKsh: z.number().finite().positive().optional(),
  tankCapacityLitres: z.number().finite().positive().max(10000000).nullable().optional(),
  isActive: z.boolean().optional(),
}).strict().refine((value) => Object.keys(value).length > 0, 'At least one field is required');

const restockSchema = z.object({
  fuelId: z.coerce.number().int().positive().safe(),
  quantityLitres: z.number().finite().positive().max(1000000).refine(
    (value) => Math.abs(value * 1000 - Math.round(value * 1000)) < 0.000001,
    'quantityLitres supports at most 3 decimal places',
  ),
  unitCostKsh: z.number().finite().nonnegative(),
  supplier: z.string().trim().min(2).max(120),
  reference: z.string().trim().min(1).max(100).optional(),
  notes: z.string().trim().max(1000).optional(),
}).strict();

const restockPatchSchema = restockSchema.partial().refine((value) => Object.keys(value).length > 0, 'At least one field is required');

const adjustmentSchema = z.object({
  fuelId: z.coerce.number().int().positive().safe(),
  newStockLitres: z.number().finite().nonnegative().max(10000000).refine(
    (value) => Math.abs(value * 1000 - Math.round(value * 1000)) < 0.000001,
    'newStockLitres supports at most 3 decimal places',
  ).optional(),
  quantityLitres: z.number().finite().min(-1000000).max(1000000).refine(
    (value) => Math.abs(value * 1000 - Math.round(value * 1000)) < 0.000001,
    'quantityLitres supports at most 3 decimal places',
  ).optional(),
  reason: z.string().trim().min(3).max(500),
  notes: z.string().trim().max(1000).optional(),
  unitCostKsh: z.number().finite().nonnegative().optional(),
}).strict().refine((value) => (value.newStockLitres === undefined) !== (value.quantityLitres === undefined), 'Provide newStockLitres or legacy quantityLitres, not both');

const listSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(25),
  fuelId: z.coerce.number().int().positive().optional(),
  supplier: z.string().trim().max(120).optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
}).strict().refine((value) => !value.from || !value.to || value.from <= value.to, 'from cannot be after to');

const pumpCreateSchema = z.object({
  fuelId: z.coerce.number().int().positive().safe(),
  pumpCode: z.string().trim().min(1).max(50).regex(/^[A-Za-z0-9._-]+$/, 'pumpCode contains invalid characters'),
}).strict();

const pumpPatchSchema = z.object({ isActive: z.boolean() }).strict();

function serializeFuel(row, role) {
  const base = {
    id: row.id,
    fuelType: row.fuel_type,
    isActive: Boolean(row.is_active),
  };
  if (role !== 'admin') return base;
  return {
    ...base,
    pricePerLitre: row.price_per_litre,
    sellingPriceKsh: money(row.selling_price_cents),
    stockLitres: row.stock_litres,
    quantityLitres: row.stock_litres,
    weightedAverageCostKsh: money(row.weighted_average_cost_cents),
    inventoryValueKsh: money(Math.round(row.stock_litres * row.weighted_average_cost_cents)),
    tankCapacityLitres: row.tank_capacity_litres,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function serializeRestock(row) {
  return {
    id: row.id,
    fuel: { id: row.fuel_id, type: row.fuel_type },
    fuelType: row.fuel_type,
    litresAdded: row.litres_added,
    quantityLitres: row.litres_added,
    costPerLitre: row.cost_per_litre,
    unitCostKsh: money(row.unit_cost_cents),
    totalCostKsh: money(row.total_cost_cents),
    supplier: row.supplier,
    reference: row.reference,
    notes: row.notes,
    stockBeforeLitres: row.stock_before,
    stockAfterLitres: row.stock_after,
    createdBy: row.created_by,
    createdAt: row.created_at,
    timestamp: row.timestamp,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at,
  };
}

function serializeAdjustment(row) {
  return {
    id: row.id,
    fuelId: row.fuel_id,
    fuelType: row.fuel_type,
    quantityLitres: row.quantity,
    reason: row.reason,
    notes: row.notes,
    unitCostKsh: money(row.unit_cost_cents),
    oldStock: row.old_stock,
    newStock: row.new_stock,
    previousQuantityLitres: row.previous_quantity,
    newQuantityLitres: row.new_quantity,
    createdBy: row.created_by,
    createdAt: row.created_at,
    timestamp: row.timestamp,
  };
}

function serializePump(row) {
  return {
    id: row.id,
    fuelId: row.fuel_id,
    fuelType: row.fuel_type,
    pumpCode: row.pump_code,
    isActive: Boolean(row.is_active),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function createFuelRouter({ db }) {
  const router = Router();

  router.get('/', (req, res) => {
    const rows = req.auth.user.role === 'admin'
      ? db.prepare('SELECT * FROM fuel_management ORDER BY fuel_type').all()
      : db.prepare('SELECT * FROM fuel_management WHERE is_active = 1 ORDER BY fuel_type').all();
    res.json({ data: rows.map((row) => serializeFuel(row, req.auth.user.role)) });
  });

  router.post('/', validate(fuelCreateSchema), (req, res) => {
    if (db.prepare('SELECT 1 FROM fuel_management WHERE fuel_type = ?').get(req.body.fuelType)) {
      throw badRequest('Fuel type already exists');
    }
    const priceCents = positiveMoney(req.body.sellingPriceKsh);
    const id = db.transaction(() => {
      const result = db.prepare(`
        INSERT INTO fuel_management
          (fuel_type, selling_price_cents, price_per_litre, stock_litres, tank_capacity_litres, created_by, updated_by)
        VALUES (?, ?, ?, 0, ?, ?, ?)
      `).run(req.body.fuelType, priceCents, priceCents / 100.0, req.body.tankCapacityLitres ?? null, req.auth.user.id, req.auth.user.id);
      recordAudit(db, { req, category: 'inventory', event: 'fuel.created', metadata: { fuelId: Number(result.lastInsertRowid), fuelType: req.body.fuelType } });
      return Number(result.lastInsertRowid);
    })();
    res.status(201).json({ fuel: serializeFuel(db.prepare('SELECT * FROM fuel_management WHERE id = ?').get(id), 'admin'), lowStockAlerts: getLowStockAlerts(db) });
  });

  router.patch('/:id', validate(fuelPatchSchema), (req, res) => {
    const id = parseId(req.params.id);
    const fuel = getFuelOrThrow(db, id);
    const priceCents = req.body.sellingPriceKsh === undefined ? fuel.selling_price_cents : positiveMoney(req.body.sellingPriceKsh);
    db.transaction(() => {
      db.prepare(`
        UPDATE fuel_management
        SET selling_price_cents = ?, price_per_litre = ?, tank_capacity_litres = ?, is_active = ?, updated_by = ?,
            updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
        WHERE id = ?
      `).run(
        priceCents,
        priceCents / 100.0,
        req.body.tankCapacityLitres === undefined ? fuel.tank_capacity_litres : req.body.tankCapacityLitres,
        req.body.isActive === undefined ? fuel.is_active : (req.body.isActive ? 1 : 0),
        req.auth.user.id,
        id,
      );
      recordAudit(db, { req, category: 'inventory', event: 'fuel.updated', metadata: { fuelId: id, fields: Object.keys(req.body) } });
    })();
    res.json({ fuel: serializeFuel(db.prepare('SELECT * FROM fuel_management WHERE id = ?').get(id), 'admin'), lowStockAlerts: getLowStockAlerts(db) });
  });

  router.post('/:id/selling-price', validate(z.object({ sellingPriceKsh: z.number().finite().positive() }).strict()), (req, res) => {
    const id = parseId(req.params.id);
    getFuelOrThrow(db, id);
    const priceCents = positiveMoney(req.body.sellingPriceKsh);
    db.transaction(() => {
      db.prepare(`
        UPDATE fuel_management SET selling_price_cents = ?, price_per_litre = ?, updated_by = ?,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?
      `).run(priceCents, priceCents / 100.0, req.auth.user.id, id);
      recordAudit(db, { req, category: 'inventory', event: 'fuel.selling_price_updated', metadata: { fuelId: id, sellingPriceKsh: req.body.sellingPriceKsh } });
    })();
    res.json({ fuel: serializeFuel(db.prepare('SELECT * FROM fuel_management WHERE id = ?').get(id), 'admin'), lowStockAlerts: getLowStockAlerts(db) });
  });

  return router;
}

export function createPumpsRouter({ db }) {
  const router = Router();

  router.get('/', (req, res) => {
    const filters = [];
    const params = [];
    if (req.query.fuelId) { filters.push('p.fuel_id = ?'); params.push(Number(req.query.fuelId)); }
    if (req.auth.user.role !== 'admin') filters.push('p.is_active = 1');
    const clause = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
    const rows = db.prepare(`
      SELECT p.*, f.fuel_type FROM pumps p JOIN fuel_management f ON f.id = p.fuel_id
      ${clause} ORDER BY p.pump_code
    `).all(...params);
    res.json({ data: rows.map(serializePump) });
  });

  router.post('/', validate(pumpCreateSchema), (req, res) => {
    const fuel = getFuelOrThrow(db, req.body.fuelId, { active: true });
    if (db.prepare('SELECT 1 FROM pumps WHERE pump_code = ? COLLATE NOCASE').get(req.body.pumpCode)) throw badRequest('Pump code already exists');
    const result = db.prepare(`
      INSERT INTO pumps (fuel_id, pump_code, created_by) VALUES (?, ?, ?)
    `).run(fuel.id, req.body.pumpCode, req.auth.user.id);
    const pump = db.prepare('SELECT p.*, f.fuel_type FROM pumps p JOIN fuel_management f ON f.id = p.fuel_id WHERE p.id = ?').get(Number(result.lastInsertRowid));
    recordAudit(db, { req, category: 'inventory', event: 'pump.created', metadata: { pumpId: pump.id, fuelId: fuel.id, pumpCode: pump.pump_code } });
    res.status(201).json({ pump: serializePump(pump) });
  });

  router.patch('/:id', validate(pumpPatchSchema), (req, res) => {
    const id = parseId(req.params.id);
    const pump = db.prepare('SELECT * FROM pumps WHERE id = ?').get(id);
    if (!pump) throw notFound('Pump was not found');
    db.prepare('UPDATE pumps SET is_active = ?, updated_at = strftime(\'%Y-%m-%dT%H:%M:%fZ\', \'now\') WHERE id = ?').run(req.body.isActive ? 1 : 0, id);
    const updated = db.prepare('SELECT p.*, f.fuel_type FROM pumps p JOIN fuel_management f ON f.id = p.fuel_id WHERE p.id = ?').get(id);
    recordAudit(db, { req, category: 'inventory', event: 'pump.updated', metadata: { pumpId: id, fields: Object.keys(req.body) } });
    res.json({ pump: serializePump(updated) });
  });

  return router;
}

export function createRestockRouter({ db }) {
  const router = Router();

  router.get('/', validate(listSchema, 'query'), (req, res) => {
    const filters = req.validatedQuery;
    const pagination = getPagination(filters);
    const where = [];
    const params = [];
    if (filters.fuelId) { where.push('r.fuel_id = ?'); params.push(filters.fuelId); }
    if (filters.supplier) { where.push('r.supplier LIKE ?'); params.push(`%${filters.supplier}%`); }
    if (filters.from) { where.push('date(r.timestamp) >= ?'); params.push(filters.from); }
    if (filters.to) { where.push('date(r.timestamp) <= ?'); params.push(filters.to); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const rows = db.prepare(`SELECT r.* FROM restocks r ${clause} ORDER BY r.timestamp DESC, r.id DESC LIMIT ? OFFSET ?`).all(...params, pagination.pageSize, pagination.offset);
    const total = db.prepare(`SELECT COUNT(*) AS count FROM restocks r ${clause}`).get(...params).count;
    res.json(paginated(rows, total, pagination, serializeRestock));
  });

  router.get('/:id', (req, res) => {
    const row = db.prepare('SELECT * FROM restocks WHERE id = ?').get(parseId(req.params.id));
    if (!row) throw notFound('Restock was not found');
    res.json({ restock: serializeRestock(row) });
  });

  router.post('/', validate(restockSchema), (req, res) => {
    const body = req.body;
    const fuel = getFuelOrThrow(db, body.fuelId, { active: true });
    const restock = {
      fuel_id: fuel.id,
      fuel_type: fuel.fuel_type,
      quantity: roundLitres(body.quantityLitres),
      unit_cost_cents: nonNegativeMoney(body.unitCostKsh, 'unitCostKsh'),
      total_cost_cents: 0,
      supplier: body.supplier,
      reference: body.reference || null,
      notes: body.notes || null,
      created_by: req.auth.user.id,
      updated_by: req.auth.user.id,
    };
    restock.total_cost_cents = Math.round(restock.quantity * restock.unit_cost_cents);
    if (!Number.isSafeInteger(restock.total_cost_cents) || restock.total_cost_cents > MAX_MONEY_CENTS) throw badRequest('Restock total cost is outside the supported range');
    const id = db.transaction(() => {
      const result = db.prepare(`
        INSERT INTO restocks
          (fuel_id, fuel_type, quantity, litres_added, unit_cost_cents, cost_per_litre, total_cost_cents, supplier, reference, notes, stock_after, created_by, updated_by, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)
      `).run(
        restock.fuel_id,
        restock.fuel_type,
        restock.quantity,
        restock.quantity,
        restock.unit_cost_cents,
        restock.unit_cost_cents / 100.0,
        restock.total_cost_cents,
        restock.supplier,
        restock.reference,
        restock.notes,
        req.auth.user.id,
        req.auth.user.id,
        new Date().toISOString(),
      );
      restock.id = Number(result.lastInsertRowid);
      addRestockInventory(db, restock, req.auth.user.id);
      recordAudit(db, { req, category: 'inventory', event: 'inventory.restocked', metadata: { restockId: restock.id, fuelId: restock.fuel_id, litresAdded: restock.quantity } });
      return restock.id;
    })();
    res.status(201).json({ restock: serializeRestock(db.prepare('SELECT * FROM restocks WHERE id = ?').get(id)), lowStockAlerts: getLowStockAlerts(db) });
  });

  router.patch('/:id', validate(restockPatchSchema), (req, res) => {
    const current = db.prepare('SELECT * FROM restocks WHERE id = ?').get(parseId(req.params.id));
    if (!current) throw notFound('Restock was not found');
    const next = {
      id: current.id,
      fuel_id: req.body.fuelId ?? current.fuel_id,
      quantity: req.body.quantityLitres === undefined ? current.quantity : roundLitres(req.body.quantityLitres),
      unit_cost_cents: req.body.unitCostKsh === undefined ? current.unit_cost_cents : nonNegativeMoney(req.body.unitCostKsh),
      supplier: req.body.supplier ?? current.supplier,
      reference: req.body.reference === undefined ? current.reference : (req.body.reference || null),
      notes: req.body.notes === undefined ? current.notes : (req.body.notes || null),
    };
    const fuel = getFuelOrThrow(db, next.fuel_id, { active: true });
    next.fuel_type = fuel.fuel_type;
    db.transaction(() => {
      reviseRestock(db, current, next, req.auth.user.id);
      recordAudit(db, { req, category: 'inventory', event: 'inventory.restock_updated', metadata: { restockId: current.id, fields: Object.keys(req.body) } });
    })();
    res.json({ restock: serializeRestock(db.prepare('SELECT * FROM restocks WHERE id = ?').get(current.id)), lowStockAlerts: getLowStockAlerts(db) });
  });

  router.delete('/:id', (req, res) => {
    const id = parseId(req.params.id);
    const row = db.prepare('SELECT * FROM restocks WHERE id = ?').get(id);
    if (!row) throw notFound('Restock was not found');
    db.transaction(() => {
      removeRestock(db, row, req.auth.user.id);
      recordAudit(db, { req, category: 'inventory', event: 'inventory.restock_deleted', metadata: { restockId: id, fuelId: row.fuel_id, litresAdded: row.quantity } });
    })();
    res.json({ deleted: true, id, lowStockAlerts: getLowStockAlerts(db) });
  });

  return router;
}

export function createAdjustmentsRouter({ db }) {
  const router = Router();

  router.get('/', validate(listSchema, 'query'), (req, res) => {
    const filters = req.validatedQuery;
    const pagination = getPagination(filters);
    const where = [];
    const params = [];
    if (filters.fuelId) { where.push('a.fuel_id = ?'); params.push(filters.fuelId); }
    if (filters.from) { where.push('date(a.timestamp) >= ?'); params.push(filters.from); }
    if (filters.to) { where.push('date(a.timestamp) <= ?'); params.push(filters.to); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const rows = db.prepare(`SELECT a.* FROM stock_adjustments a ${clause} ORDER BY a.timestamp DESC, a.id DESC LIMIT ? OFFSET ?`).all(...params, pagination.pageSize, pagination.offset);
    const total = db.prepare(`SELECT COUNT(*) AS count FROM stock_adjustments a ${clause}`).get(...params).count;
    res.json(paginated(rows, total, pagination, serializeAdjustment));
  });

  router.post('/', validate(adjustmentSchema), (req, res) => {
    const body = req.body;
    const id = db.transaction(() => {
      const fuel = getFuelOrThrow(db, body.fuelId, { active: true });
      const oldStock = roundLitres(fuel.stock_litres ?? fuel.quantity);
      const newStock = body.newStockLitres === undefined ? roundLitres(oldStock + body.quantityLitres) : roundLitres(body.newStockLitres);
      const quantity = roundLitres(newStock - oldStock);
      let unitCost = body.unitCostKsh === undefined ? null : nonNegativeMoney(body.unitCostKsh, 'unitCostKsh');
      if (quantity > 0 && unitCost === null && fuel.weighted_average_cost_cents === 0) throw badRequest('unitCostKsh is required for a positive adjustment when no cost basis exists');
      const timestamp = new Date().toISOString();
      const result = db.prepare(`
        INSERT INTO stock_adjustments
          (fuel_id, fuel_type, quantity, reason, notes, unit_cost_cents, previous_quantity, new_quantity, old_stock, new_stock, created_by, timestamp)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(fuel.id, fuel.fuel_type, quantity, body.reason, body.notes || null, unitCost, oldStock, newStock, oldStock, newStock, req.auth.user.id, timestamp);
      const adjustment = { id: Number(result.lastInsertRowid), fuel_id: fuel.id, quantity, unit_cost_cents: unitCost };
      const inventory = applyAdjustmentInventory(db, adjustment, req.auth.user.id);
      recordAudit(db, { req, category: 'inventory', event: 'inventory.stock_adjusted', metadata: { adjustmentId: adjustment.id, fuelId: fuel.id, oldStock, newStock, reason: body.reason } });
      void inventory;
      return adjustment.id;
    })();
    const row = db.prepare('SELECT * FROM stock_adjustments WHERE id = ?').get(id);
    res.status(201).json({ adjustment: serializeAdjustment(row), lowStockAlerts: getLowStockAlerts(db) });
  });

  return router;
}
