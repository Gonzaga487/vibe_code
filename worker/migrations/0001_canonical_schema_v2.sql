-- ZENENERGIES canonical schema v2 for Cloudflare D1.
-- This migration intentionally contains no operational or demonstration seed data.
PRAGMA foreign_keys = ON;

CREATE TABLE schema_migrations (
  version INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

INSERT INTO schema_migrations (version, name) VALUES
  (1, 'initial_station_schema'),
  (2, 'canonical_station_contract');

CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL COLLATE NOCASE UNIQUE,
  password_hash TEXT NOT NULL,
  full_name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('admin', 'attendant')),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  session_version INTEGER NOT NULL DEFAULT 0 CHECK (session_version >= 0),
  must_change_password INTEGER NOT NULL DEFAULT 0 CHECK (must_change_password IN (0, 1)),
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  last_login_at TEXT,
  password_changed_at TEXT,
  CHECK (length(username) BETWEEN 3 AND 32),
  CHECK (length(full_name) BETWEEN 2 AND 100)
) STRICT;

CREATE TABLE app_settings (
  key TEXT PRIMARY KEY,
  value_json TEXT NOT NULL CHECK (json_valid(value_json)),
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE TABLE fuel_management (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fuel_type TEXT NOT NULL UNIQUE CHECK (fuel_type IN ('DIESEL', 'PETROL')),
  quantity REAL NOT NULL DEFAULT 0 CHECK (quantity >= 0 AND typeof(quantity) IN ('real', 'integer')),
  weighted_average_cost_cents INTEGER NOT NULL DEFAULT 0 CHECK (weighted_average_cost_cents >= 0 AND typeof(weighted_average_cost_cents) = 'integer'),
  selling_price_cents INTEGER NOT NULL CHECK (selling_price_cents > 0 AND typeof(selling_price_cents) = 'integer'),
  price_per_litre REAL NOT NULL DEFAULT 0 CHECK (price_per_litre > 0 AND typeof(price_per_litre) IN ('real', 'integer')),
  stock_litres REAL NOT NULL DEFAULT 0 CHECK (stock_litres >= 0 AND typeof(stock_litres) IN ('real', 'integer')),
  tank_capacity_litres REAL CHECK (tank_capacity_litres IS NULL OR (tank_capacity_litres > 0 AND typeof(tank_capacity_litres) IN ('real', 'integer'))),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (ABS(stock_litres - quantity) < 0.000001)
) STRICT;

CREATE TABLE pumps (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fuel_id INTEGER NOT NULL REFERENCES fuel_management(id) ON DELETE RESTRICT,
  pump_code TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK (length(pump_code) BETWEEN 1 AND 50),
  is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE TABLE shifts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  attendant_id INTEGER REFERENCES users(id) ON DELETE RESTRICT,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
  status_label TEXT NOT NULL DEFAULT 'Open',
  opened_at TEXT NOT NULL,
  closed_at TEXT,
  opening_float_cents INTEGER NOT NULL DEFAULT 0 CHECK (opening_float_cents >= 0 AND typeof(opening_float_cents) = 'integer'),
  opening_float_mpesa_cents INTEGER NOT NULL DEFAULT 0 CHECK (opening_float_mpesa_cents >= 0 AND typeof(opening_float_mpesa_cents) = 'integer'),
  expected_cash_cents INTEGER NOT NULL DEFAULT 0 CHECK (typeof(expected_cash_cents) = 'integer'),
  expected_mpesa_cents INTEGER NOT NULL DEFAULT 0 CHECK (typeof(expected_mpesa_cents) = 'integer'),
  counted_cash_cents INTEGER CHECK (counted_cash_cents IS NULL OR (counted_cash_cents >= 0 AND typeof(counted_cash_cents) = 'integer')),
  counted_mpesa_cents INTEGER CHECK (counted_mpesa_cents IS NULL OR (counted_mpesa_cents >= 0 AND typeof(counted_mpesa_cents) = 'integer')),
  cash_difference_cents INTEGER CHECK (cash_difference_cents IS NULL OR typeof(cash_difference_cents) = 'integer'),
  mpesa_difference_cents INTEGER CHECK (mpesa_difference_cents IS NULL OR typeof(mpesa_difference_cents) = 'integer'),
  total_difference_cents INTEGER CHECK (total_difference_cents IS NULL OR typeof(total_difference_cents) = 'integer'),
  opening_cash REAL NOT NULL DEFAULT 0 CHECK (typeof(opening_cash) IN ('real', 'integer')),
  opening_mpesa REAL NOT NULL DEFAULT 0 CHECK (typeof(opening_mpesa) IN ('real', 'integer')),
  expected_cash REAL NOT NULL DEFAULT 0 CHECK (typeof(expected_cash) IN ('real', 'integer')),
  expected_mpesa REAL NOT NULL DEFAULT 0 CHECK (typeof(expected_mpesa) IN ('real', 'integer')),
  closing_cash REAL CHECK (closing_cash IS NULL OR (closing_cash >= 0 AND typeof(closing_cash) IN ('real', 'integer'))),
  closing_mpesa REAL CHECK (closing_mpesa IS NULL OR (closing_mpesa >= 0 AND typeof(closing_mpesa) IN ('real', 'integer'))),
  reconciliation_json TEXT CHECK (reconciliation_json IS NULL OR json_valid(reconciliation_json)),
  closing_notes TEXT CHECK (closing_notes IS NULL OR length(closing_notes) <= 1000),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (status = 'open' OR closed_at IS NOT NULL),
  CHECK (status = 'open' OR (counted_cash_cents IS NOT NULL AND counted_mpesa_cents IS NOT NULL)),
  CHECK (attendant_id IS NULL OR attendant_id = user_id)
) STRICT;

CREATE UNIQUE INDEX idx_shifts_one_open_per_user ON shifts(user_id) WHERE status = 'open';
CREATE INDEX idx_shifts_user_opened ON shifts(user_id, opened_at DESC);
CREATE INDEX idx_shifts_status ON shifts(status);

CREATE TABLE restocks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fuel_id INTEGER NOT NULL REFERENCES fuel_management(id) ON DELETE RESTRICT,
  quantity REAL NOT NULL CHECK (quantity > 0 AND typeof(quantity) IN ('real', 'integer')),
  unit_cost_cents INTEGER NOT NULL CHECK (unit_cost_cents >= 0 AND typeof(unit_cost_cents) = 'integer'),
  total_cost_cents INTEGER NOT NULL CHECK (total_cost_cents >= 0 AND typeof(total_cost_cents) = 'integer'),
  supplier TEXT NOT NULL CHECK (length(supplier) BETWEEN 2 AND 120),
  reference TEXT CHECK (reference IS NULL OR length(reference) BETWEEN 1 AND 100),
  notes TEXT CHECK (notes IS NULL OR length(notes) <= 1000),
  stock_before REAL CHECK (stock_before IS NULL OR (stock_before >= 0 AND typeof(stock_before) IN ('real', 'integer'))),
  stock_after REAL NOT NULL CHECK (stock_after >= 0 AND typeof(stock_after) IN ('real', 'integer')),
  created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  updated_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  fuel_type TEXT NOT NULL CHECK (fuel_type IN ('PETROL', 'DIESEL')),
  litres_added REAL NOT NULL CHECK (litres_added > 0 AND typeof(litres_added) IN ('real', 'integer')),
  cost_per_litre REAL NOT NULL CHECK (cost_per_litre >= 0 AND typeof(cost_per_litre) IN ('real', 'integer')),
  timestamp TEXT NOT NULL,
  CHECK (ABS(quantity - litres_added) < 0.000001),
  CHECK (ABS(unit_cost_cents / 100.0 - cost_per_litre) < 0.000001),
  CHECK (total_cost_cents = CAST(ROUND(quantity * unit_cost_cents) AS INTEGER))
) STRICT;

CREATE INDEX idx_restock_fuel_date ON restocks(fuel_id, created_at DESC);

CREATE TABLE stock_adjustments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fuel_id INTEGER NOT NULL REFERENCES fuel_management(id) ON DELETE RESTRICT,
  fuel_type TEXT NOT NULL CHECK (fuel_type IN ('PETROL', 'DIESEL')),
  quantity REAL NOT NULL CHECK (typeof(quantity) IN ('real', 'integer')),
  reason TEXT NOT NULL CHECK (length(reason) BETWEEN 3 AND 500),
  notes TEXT CHECK (notes IS NULL OR length(notes) <= 1000),
  unit_cost_cents INTEGER CHECK (unit_cost_cents IS NULL OR (unit_cost_cents >= 0 AND typeof(unit_cost_cents) = 'integer')),
  previous_quantity REAL CHECK (previous_quantity IS NULL OR (previous_quantity >= 0 AND typeof(previous_quantity) IN ('real', 'integer'))),
  new_quantity REAL NOT NULL CHECK (new_quantity >= 0 AND typeof(new_quantity) IN ('real', 'integer')),
  old_stock REAL NOT NULL CHECK (old_stock >= 0 AND typeof(old_stock) IN ('real', 'integer')),
  new_stock REAL NOT NULL CHECK (new_stock >= 0 AND typeof(new_stock) IN ('real', 'integer')),
  created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  timestamp TEXT NOT NULL,
  CHECK (ABS((new_stock - old_stock) - quantity) < 0.000001)
) STRICT;

CREATE INDEX idx_adjustments_fuel_date ON stock_adjustments(fuel_id, created_at DESC);

CREATE TABLE sales (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shift_id INTEGER NOT NULL REFERENCES shifts(id) ON DELETE RESTRICT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  fuel_id INTEGER REFERENCES fuel_management(id) ON DELETE RESTRICT,
  fuel_type TEXT CHECK (fuel_type IS NULL OR fuel_type IN ('PETROL', 'DIESEL')),
  litres REAL CHECK (litres IS NULL OR (litres > 0 AND typeof(litres) IN ('real', 'integer'))),
  unit_price_cents INTEGER CHECK (unit_price_cents IS NULL OR (unit_price_cents > 0 AND typeof(unit_price_cents) = 'integer')),
  unit_cost_cents INTEGER CHECK (unit_cost_cents IS NULL OR (unit_cost_cents >= 0 AND typeof(unit_cost_cents) = 'integer')),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0 AND typeof(amount_cents) = 'integer'),
  amount REAL NOT NULL CHECK (amount > 0 AND typeof(amount) IN ('real', 'integer')),
  total_cents INTEGER NOT NULL CHECK (total_cents > 0 AND typeof(total_cents) = 'integer'),
  cash_cents INTEGER NOT NULL CHECK (cash_cents >= 0 AND typeof(cash_cents) = 'integer'),
  mpesa_cents INTEGER NOT NULL CHECK (mpesa_cents >= 0 AND typeof(mpesa_cents) = 'integer'),
  payment_method TEXT NOT NULL CHECK (payment_method IN ('cash', 'mpesa', 'mixed')),
  mode TEXT NOT NULL CHECK (mode IN ('quick', 'detailed')),
  pump_id INTEGER REFERENCES pumps(id) ON DELETE SET NULL,
  customer_name TEXT CHECK (customer_name IS NULL OR length(customer_name) BETWEEN 1 AND 120),
  notes TEXT CHECK (notes IS NULL OR length(notes) <= 1000),
  sold_at TEXT NOT NULL,
  timestamp TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (amount_cents = total_cents),
  CHECK (ABS(amount - amount_cents / 100.0) < 0.000001),
  CHECK (cash_cents + mpesa_cents = amount_cents),
  CHECK (mode = 'quick' OR (fuel_id IS NOT NULL AND fuel_type IS NOT NULL)),
  CHECK (
    (payment_method = 'cash' AND cash_cents = amount_cents AND mpesa_cents = 0)
    OR (payment_method = 'mpesa' AND cash_cents = 0 AND mpesa_cents = amount_cents)
    OR (payment_method = 'mixed' AND cash_cents > 0 AND mpesa_cents > 0)
  )
) STRICT;

CREATE INDEX idx_sales_shift ON sales(shift_id, sold_at DESC);
CREATE INDEX idx_sales_user_date ON sales(user_id, sold_at DESC);
CREATE INDEX idx_sales_fuel_date ON sales(fuel_id, sold_at DESC);
CREATE INDEX idx_sales_mode_date ON sales(mode, sold_at DESC);

CREATE TABLE expenses (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  shift_id INTEGER REFERENCES shifts(id) ON DELETE SET NULL,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  category TEXT NOT NULL CHECK (category IN ('FUEL', 'UTILITIES', 'SALARY', 'MAINTENANCE', 'TRANSPORT', 'OTHER')),
  description TEXT NOT NULL CHECK (length(description) BETWEEN 2 AND 500),
  amount_cents INTEGER NOT NULL CHECK (amount_cents > 0 AND typeof(amount_cents) = 'integer'),
  amount REAL NOT NULL CHECK (amount > 0 AND typeof(amount) IN ('real', 'integer')),
  payment_method TEXT NOT NULL CHECK (payment_method IN ('cash', 'mpesa')),
  expense_date TEXT NOT NULL,
  notes TEXT CHECK (notes IS NULL OR length(notes) <= 1000),
  timestamp TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  CHECK (ABS(amount - amount_cents / 100.0) < 0.000001),
  CHECK (date(expense_date) = expense_date)
) STRICT;

CREATE INDEX idx_expenses_shift ON expenses(shift_id);
CREATE INDEX idx_expenses_user_date ON expenses(user_id, expense_date DESC);

CREATE TABLE pump_readings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fuel_id INTEGER NOT NULL REFERENCES fuel_management(id) ON DELETE RESTRICT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reading_date TEXT NOT NULL,
  previous_closing REAL CHECK (previous_closing IS NULL OR (previous_closing >= 0 AND typeof(previous_closing) IN ('real', 'integer'))),
  closing_reading REAL NOT NULL CHECK (closing_reading >= 0 AND typeof(closing_reading) IN ('real', 'integer')),
  consumption REAL NOT NULL DEFAULT 0 CHECK (consumption >= 0 AND typeof(consumption) IN ('real', 'integer')),
  reconciliation_price_cents INTEGER NOT NULL CHECK (reconciliation_price_cents > 0 AND typeof(reconciliation_price_cents) = 'integer'),
  meter_reference TEXT NOT NULL CHECK (length(meter_reference) BETWEEN 1 AND 100),
  stock_before REAL CHECK (stock_before IS NULL OR (stock_before >= 0 AND typeof(stock_before) IN ('real', 'integer'))),
  stock_after REAL CHECK (stock_after IS NULL OR (stock_after >= 0 AND typeof(stock_after) IN ('real', 'integer'))),
  notes TEXT CHECK (notes IS NULL OR length(notes) <= 1000),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  "date" TEXT NOT NULL,
  fuel_type TEXT NOT NULL CHECK (fuel_type IN ('PETROL', 'DIESEL')),
  opening_litres REAL NOT NULL DEFAULT 0 CHECK (opening_litres >= 0 AND typeof(opening_litres) IN ('real', 'integer')),
  closing_litres REAL NOT NULL DEFAULT 0 CHECK (closing_litres >= 0 AND typeof(closing_litres) IN ('real', 'integer')),
  prev_closing_litres REAL NOT NULL DEFAULT 0 CHECK (prev_closing_litres >= 0 AND typeof(prev_closing_litres) IN ('real', 'integer')),
  reconciliation_value_cents INTEGER NOT NULL DEFAULT 0 CHECK (typeof(reconciliation_value_cents) = 'integer'),
  opening_ksh REAL NOT NULL DEFAULT 0,
  closing_ksh REAL NOT NULL DEFAULT 0,
  prev_closing_ksh REAL NOT NULL DEFAULT 0,
  CHECK (date(reading_date) = reading_date),
  CHECK (date("date") = "date"),
  CHECK (previous_closing IS NULL OR closing_reading >= previous_closing)
) STRICT;

CREATE UNIQUE INDEX idx_pump_reading_date_fuel ON pump_readings(reading_date, fuel_id);
CREATE INDEX idx_pump_user_date ON pump_readings(user_id, reading_date DESC);
CREATE INDEX idx_pump_fuel_date ON pump_readings(fuel_id, reading_date DESC);

CREATE TABLE sales_readings (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fuel_id INTEGER NOT NULL REFERENCES fuel_management(id) ON DELETE RESTRICT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  reading_date TEXT NOT NULL,
  previous_closing REAL CHECK (previous_closing IS NULL OR (previous_closing >= 0 AND typeof(previous_closing) IN ('real', 'integer'))),
  closing_reading REAL NOT NULL CHECK (closing_reading >= 0 AND typeof(closing_reading) IN ('real', 'integer')),
  consumption REAL NOT NULL DEFAULT 0 CHECK (consumption >= 0 AND typeof(consumption) IN ('real', 'integer')),
  reconciliation_price_cents INTEGER NOT NULL CHECK (reconciliation_price_cents > 0 AND typeof(reconciliation_price_cents) = 'integer'),
  meter_reference TEXT NOT NULL CHECK (length(meter_reference) BETWEEN 1 AND 100),
  stock_before REAL,
  stock_after REAL,
  notes TEXT CHECK (notes IS NULL OR length(notes) <= 1000),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  "date" TEXT NOT NULL,
  fuel_type TEXT NOT NULL CHECK (fuel_type IN ('PETROL', 'DIESEL')),
  opening_ksh REAL NOT NULL DEFAULT 0 CHECK (opening_ksh >= 0 AND typeof(opening_ksh) IN ('real', 'integer')),
  closing_ksh REAL NOT NULL DEFAULT 0 CHECK (closing_ksh >= 0 AND typeof(closing_ksh) IN ('real', 'integer')),
  prev_closing_ksh REAL NOT NULL DEFAULT 0 CHECK (prev_closing_ksh >= 0 AND typeof(prev_closing_ksh) IN ('real', 'integer')),
  reconciliation_value_cents INTEGER NOT NULL DEFAULT 0 CHECK (typeof(reconciliation_value_cents) = 'integer'),
  opening_litres REAL NOT NULL DEFAULT 0,
  closing_litres REAL NOT NULL DEFAULT 0,
  prev_closing_litres REAL NOT NULL DEFAULT 0,
  CHECK (date(reading_date) = reading_date),
  CHECK (date("date") = "date"),
  CHECK (previous_closing IS NULL OR closing_reading >= previous_closing)
) STRICT;

CREATE UNIQUE INDEX idx_sales_reading_date_fuel ON sales_readings(reading_date, fuel_id);
CREATE INDEX idx_sales_reading_user_date ON sales_readings(user_id, reading_date DESC);
CREATE INDEX idx_sales_reading_fuel_date ON sales_readings(fuel_id, reading_date DESC);

CREATE TABLE inventory_lots (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fuel_id INTEGER NOT NULL REFERENCES fuel_management(id) ON DELETE RESTRICT,
  restock_id INTEGER UNIQUE REFERENCES restocks(id) ON DELETE SET NULL,
  adjustment_id INTEGER UNIQUE REFERENCES stock_adjustments(id) ON DELETE SET NULL,
  original_quantity REAL NOT NULL CHECK (original_quantity > 0 AND typeof(original_quantity) IN ('real', 'integer')),
  remaining_quantity REAL NOT NULL CHECK (remaining_quantity >= 0 AND remaining_quantity <= original_quantity AND typeof(remaining_quantity) IN ('real', 'integer')),
  unit_cost_cents INTEGER NOT NULL CHECK (unit_cost_cents >= 0 AND typeof(unit_cost_cents) = 'integer'),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
) STRICT;

CREATE INDEX idx_inventory_lots_fifo ON inventory_lots(fuel_id, remaining_quantity, id) WHERE remaining_quantity > 0;

CREATE TABLE inventory_movements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  fuel_id INTEGER NOT NULL REFERENCES fuel_management(id) ON DELETE RESTRICT,
  source_type TEXT NOT NULL CHECK (source_type IN ('restock', 'stock_adjustment', 'pump_reading', 'sales_reading')),
  source_id INTEGER NOT NULL,
  signed_quantity REAL NOT NULL CHECK (signed_quantity != 0 AND typeof(signed_quantity) IN ('real', 'integer')),
  signed_cost_cents INTEGER NOT NULL CHECK (typeof(signed_cost_cents) = 'integer'),
  stock_before REAL NOT NULL CHECK (stock_before >= 0 AND typeof(stock_before) IN ('real', 'integer')),
  stock_after REAL NOT NULL CHECK (stock_after >= 0 AND typeof(stock_after) IN ('real', 'integer')),
  created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  reversed_at TEXT,
  reversal_movement_id INTEGER REFERENCES inventory_movements(id) ON DELETE SET NULL,
  CHECK (ABS(stock_after - (stock_before + signed_quantity)) < 0.000001)
) STRICT;

CREATE INDEX idx_movements_source ON inventory_movements(source_type, source_id, reversed_at);
CREATE INDEX idx_movements_fuel_date ON inventory_movements(fuel_id, created_at DESC);

CREATE TABLE inventory_allocations (
  movement_id INTEGER NOT NULL REFERENCES inventory_movements(id) ON DELETE CASCADE,
  lot_id INTEGER NOT NULL REFERENCES inventory_lots(id) ON DELETE RESTRICT,
  quantity REAL NOT NULL CHECK (quantity > 0 AND typeof(quantity) IN ('real', 'integer')),
  unit_cost_cents INTEGER NOT NULL CHECK (unit_cost_cents >= 0 AND typeof(unit_cost_cents) = 'integer'),
  UNIQUE(movement_id, lot_id)
) STRICT;

CREATE INDEX idx_allocations_lot ON inventory_allocations(lot_id);

CREATE TABLE audit_logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  actor_username TEXT,
  category TEXT NOT NULL CHECK (category IN ('auth', 'admin', 'sale', 'shift', 'inventory', 'reading', 'expense', 'settings', 'system')),
  event TEXT NOT NULL CHECK (length(event) BETWEEN 1 AND 100),
  metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
  ip_address TEXT,
  user_agent TEXT,
  request_id TEXT,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  user_id INTEGER,
  timestamp TEXT NOT NULL
) STRICT;

CREATE INDEX idx_audit_created ON audit_logs(created_at DESC);
CREATE INDEX idx_audit_actor ON audit_logs(actor_id, created_at DESC);
CREATE INDEX idx_audit_category_event ON audit_logs(category, event, created_at DESC);
CREATE INDEX idx_audit_user_date ON audit_logs(user_id, timestamp DESC);

CREATE TRIGGER fuel_management_reject_unsupported_insert
BEFORE INSERT ON fuel_management
WHEN NEW.fuel_type NOT IN ('PETROL', 'DIESEL')
BEGIN
  SELECT RAISE(ABORT, 'Only Petrol and Diesel are supported');
END;

CREATE TRIGGER fuel_management_reject_unsupported_update
BEFORE UPDATE OF fuel_type ON fuel_management
WHEN NEW.fuel_type NOT IN ('PETROL', 'DIESEL')
BEGIN
  SELECT RAISE(ABORT, 'Only Petrol and Diesel are supported');
END;

-- Worker-only operational support. These tables contain no seed rows and are
-- intentionally excluded from canonical application JSON snapshots.
CREATE TABLE login_rate_limits (
  key_hash TEXT PRIMARY KEY,
  window_started_at INTEGER NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  blocked_until INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL
) STRICT;

CREATE TABLE api_operations (
  id TEXT PRIMARY KEY,
  operation_kind TEXT NOT NULL CHECK (length(operation_kind) BETWEEN 1 AND 80),
  entity_table TEXT NOT NULL CHECK (length(entity_table) BETWEEN 1 AND 80),
  entity_id TEXT,
  request_id TEXT,
  guard_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(guard_json)),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
) STRICT;

CREATE INDEX idx_api_operations_expiry ON api_operations(expires_at);
CREATE INDEX idx_login_rate_limits_expiry ON login_rate_limits(blocked_until);

CREATE TABLE idempotency_records (
  scope TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  request_hash TEXT NOT NULL,
  response_status INTEGER,
  response_json TEXT CHECK (response_json IS NULL OR json_valid(response_json)),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (scope, idempotency_key)
) STRICT;

CREATE INDEX idx_idempotency_records_expiry ON idempotency_records(expires_at);
