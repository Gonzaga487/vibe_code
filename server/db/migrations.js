export const migrations = [
  {
    version: 1,
    name: 'initial_station_schema',
    up: (db) => {
      db.exec(`
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
          value_json TEXT NOT NULL,
          updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        ) STRICT;

        CREATE TABLE fuel_management (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          fuel_type TEXT NOT NULL UNIQUE CHECK (fuel_type IN ('DIESEL', 'PETROL')),
          quantity REAL NOT NULL DEFAULT 0 CHECK (quantity >= 0 AND typeof(quantity) IN ('real', 'integer')),
          weighted_average_cost_cents INTEGER NOT NULL DEFAULT 0 CHECK (weighted_average_cost_cents >= 0 AND typeof(weighted_average_cost_cents) = 'integer'),
          selling_price_cents INTEGER NOT NULL CHECK (selling_price_cents > 0 AND typeof(selling_price_cents) = 'integer'),
          tank_capacity_litres REAL CHECK (tank_capacity_litres IS NULL OR (tank_capacity_litres > 0 AND typeof(tank_capacity_litres) IN ('real', 'integer'))),
          is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
          created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
          updated_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        ) STRICT;

        CREATE TABLE shifts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
          status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
          opened_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
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
          closing_notes TEXT CHECK (closing_notes IS NULL OR length(closing_notes) <= 1000),
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          CHECK (status = 'open' OR closed_at IS NOT NULL),
          CHECK (status = 'open' OR (counted_cash_cents IS NOT NULL AND counted_mpesa_cents IS NOT NULL))
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
          updated_by INTEGER REFERENCES users(id) ON DELETE RESTRICT,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        ) STRICT;

        CREATE INDEX idx_restock_fuel_date ON restocks(fuel_id, created_at DESC);

        CREATE TABLE stock_adjustments (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          fuel_id INTEGER NOT NULL REFERENCES fuel_management(id) ON DELETE RESTRICT,
          quantity REAL NOT NULL CHECK (quantity != 0 AND typeof(quantity) IN ('real', 'integer')),
          reason TEXT NOT NULL CHECK (length(reason) BETWEEN 3 AND 500),
          notes TEXT CHECK (notes IS NULL OR length(notes) <= 1000),
          unit_cost_cents INTEGER CHECK (unit_cost_cents IS NULL OR (unit_cost_cents >= 0 AND typeof(unit_cost_cents) = 'integer')),
          previous_quantity REAL CHECK (previous_quantity IS NULL OR (previous_quantity >= 0 AND typeof(previous_quantity) IN ('real', 'integer'))),
          new_quantity REAL NOT NULL CHECK (new_quantity >= 0 AND typeof(new_quantity) IN ('real', 'integer')),
          created_by INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        ) STRICT;

        CREATE INDEX idx_adjustments_fuel_date ON stock_adjustments(fuel_id, created_at DESC);

        CREATE TABLE sales (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          shift_id INTEGER NOT NULL REFERENCES shifts(id) ON DELETE RESTRICT,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
          fuel_id INTEGER NOT NULL REFERENCES fuel_management(id) ON DELETE RESTRICT,
          fuel_type TEXT NOT NULL CHECK (fuel_type IN ('DIESEL', 'PETROL')),
          litres REAL NOT NULL CHECK (litres > 0 AND typeof(litres) IN ('real', 'integer')),
          unit_price_cents INTEGER NOT NULL CHECK (unit_price_cents > 0 AND typeof(unit_price_cents) = 'integer'),
          unit_cost_cents INTEGER NOT NULL CHECK (unit_cost_cents >= 0 AND typeof(unit_cost_cents) = 'integer'),
          total_cents INTEGER NOT NULL CHECK (total_cents > 0 AND typeof(total_cents) = 'integer'),
          cash_cents INTEGER NOT NULL CHECK (cash_cents >= 0 AND typeof(cash_cents) = 'integer'),
          mpesa_cents INTEGER NOT NULL CHECK (mpesa_cents >= 0 AND typeof(mpesa_cents) = 'integer'),
          payment_method TEXT NOT NULL CHECK (payment_method IN ('cash', 'mpesa', 'mixed')),
          customer_name TEXT CHECK (customer_name IS NULL OR length(customer_name) BETWEEN 1 AND 120),
          notes TEXT CHECK (notes IS NULL OR length(notes) <= 1000),
          sold_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          CHECK (cash_cents + mpesa_cents = total_cents),
          CHECK (total_cents = CAST(ROUND(litres * unit_price_cents) AS INTEGER)),
          CHECK (
            (payment_method = 'cash' AND cash_cents = total_cents AND mpesa_cents = 0)
            OR (payment_method = 'mpesa' AND cash_cents = 0 AND mpesa_cents = total_cents)
            OR (payment_method = 'mixed' AND cash_cents > 0 AND mpesa_cents > 0)
          )
        ) STRICT;

        CREATE INDEX idx_sales_shift ON sales(shift_id, sold_at DESC);
        CREATE INDEX idx_sales_user_date ON sales(user_id, sold_at DESC);
        CREATE INDEX idx_sales_fuel_date ON sales(fuel_id, sold_at DESC);

        CREATE TABLE expenses (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          shift_id INTEGER NOT NULL REFERENCES shifts(id) ON DELETE RESTRICT,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
          category TEXT NOT NULL CHECK (category IN ('FUEL', 'UTILITIES', 'SALARY', 'MAINTENANCE', 'TRANSPORT', 'OTHER')),
          description TEXT NOT NULL CHECK (length(description) BETWEEN 2 AND 500),
          amount_cents INTEGER NOT NULL CHECK (amount_cents > 0 AND typeof(amount_cents) = 'integer'),
          payment_method TEXT NOT NULL CHECK (payment_method IN ('cash', 'mpesa')),
          expense_date TEXT NOT NULL,
          notes TEXT CHECK (notes IS NULL OR length(notes) <= 1000),
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
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
          CHECK (date(reading_date) = reading_date),
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
          CHECK (date(reading_date) = reading_date),
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
          reversal_movement_id INTEGER REFERENCES inventory_movements(id) ON DELETE SET NULL
        ) STRICT;

        CREATE INDEX idx_movements_source ON inventory_movements(source_type, source_id, reversed_at);
        CREATE INDEX idx_movements_fuel_date ON inventory_movements(fuel_id, created_at DESC);

        CREATE TABLE inventory_allocations (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
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
          metadata_json TEXT NOT NULL DEFAULT '{}',
          ip_address TEXT,
          user_agent TEXT,
          request_id TEXT,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        ) STRICT;

        CREATE INDEX idx_audit_created ON audit_logs(created_at DESC);
        CREATE INDEX idx_audit_actor ON audit_logs(actor_id, created_at DESC);
        CREATE INDEX idx_audit_category_event ON audit_logs(category, event, created_at DESC);
      `);
    },
  },
  {
    version: 2,
    name: 'canonical_station_contract',
    up: (db) => {
      const unsupported = db.prepare(`
        SELECT 'fuel_management' AS table_name, id FROM fuel_management WHERE fuel_type = 'KEROSENE'
        UNION ALL
        SELECT 'sales' AS table_name, id FROM sales WHERE fuel_type = 'KEROSENE'
      `).all();
      if (unsupported.length) {
        throw new Error(`Cannot migrate unsupported fuel data: ${unsupported.map((row) => `${row.table_name}#${row.id}`).join(', ')}. Remove or explicitly migrate Kerosene before retrying.`);
      }

      db.exec(`
        CREATE TABLE pumps (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          fuel_id INTEGER NOT NULL REFERENCES fuel_management(id) ON DELETE RESTRICT,
          pump_code TEXT NOT NULL COLLATE NOCASE UNIQUE CHECK (length(pump_code) BETWEEN 1 AND 50),
          is_active INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
          created_by INTEGER REFERENCES users(id) ON DELETE SET NULL,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
        ) STRICT;
        CREATE INDEX idx_pumps_fuel ON pumps(fuel_id, is_active, pump_code);

        ALTER TABLE fuel_management ADD COLUMN price_per_litre REAL NOT NULL DEFAULT 0;
        ALTER TABLE fuel_management ADD COLUMN stock_litres REAL NOT NULL DEFAULT 0;
        UPDATE fuel_management
        SET price_per_litre = selling_price_cents / 100.0,
            stock_litres = quantity;

        ALTER TABLE shifts ADD COLUMN attendant_id INTEGER;
        ALTER TABLE shifts ADD COLUMN status_label TEXT NOT NULL DEFAULT 'Open';
        ALTER TABLE shifts ADD COLUMN opening_cash REAL NOT NULL DEFAULT 0;
        ALTER TABLE shifts ADD COLUMN opening_mpesa REAL NOT NULL DEFAULT 0;
        ALTER TABLE shifts ADD COLUMN closing_cash REAL;
        ALTER TABLE shifts ADD COLUMN closing_mpesa REAL;
        ALTER TABLE shifts ADD COLUMN expected_cash REAL NOT NULL DEFAULT 0;
        ALTER TABLE shifts ADD COLUMN expected_mpesa REAL NOT NULL DEFAULT 0;
        ALTER TABLE shifts ADD COLUMN reconciliation_json TEXT;
        UPDATE shifts
        SET attendant_id = user_id,
            status_label = CASE WHEN status = 'open' THEN 'Open' ELSE 'Closed' END,
            opening_cash = opening_float_cents / 100.0,
            opening_mpesa = opening_float_mpesa_cents / 100.0,
            closing_cash = CASE WHEN counted_cash_cents IS NULL THEN NULL ELSE counted_cash_cents / 100.0 END,
            closing_mpesa = CASE WHEN counted_mpesa_cents IS NULL THEN NULL ELSE counted_mpesa_cents / 100.0 END,
            expected_cash = expected_cash_cents / 100.0,
            expected_mpesa = expected_mpesa_cents / 100.0;

        ALTER TABLE restocks ADD COLUMN fuel_type TEXT NOT NULL DEFAULT 'PETROL';
        ALTER TABLE restocks ADD COLUMN litres_added REAL NOT NULL DEFAULT 0;
        ALTER TABLE restocks ADD COLUMN cost_per_litre REAL NOT NULL DEFAULT 0;
        ALTER TABLE restocks ADD COLUMN timestamp TEXT NOT NULL DEFAULT '';
        UPDATE restocks
        SET fuel_type = COALESCE((SELECT fuel_type FROM fuel_management WHERE fuel_management.id = restocks.fuel_id), 'PETROL'),
            litres_added = quantity,
            cost_per_litre = unit_cost_cents / 100.0,
            timestamp = created_at;

        CREATE TABLE stock_adjustments_v2 (
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
        INSERT INTO stock_adjustments_v2 (
          id, fuel_id, fuel_type, quantity, reason, notes, unit_cost_cents,
          previous_quantity, new_quantity, old_stock, new_stock, created_by, created_at, timestamp
        )
        SELECT a.id, a.fuel_id,
               COALESCE((SELECT fuel_type FROM fuel_management WHERE fuel_management.id = a.fuel_id), 'PETROL'),
               a.quantity, a.reason, a.notes, a.unit_cost_cents,
               a.previous_quantity, a.new_quantity,
               CASE WHEN a.previous_quantity IS NOT NULL THEN a.previous_quantity ELSE a.new_quantity - a.quantity END,
               a.new_quantity, a.created_by, a.created_at, a.created_at
        FROM stock_adjustments a;
        CREATE TEMP TABLE _stock_adjustment_links (lot_id INTEGER PRIMARY KEY, adjustment_id INTEGER NOT NULL);
        INSERT INTO _stock_adjustment_links (lot_id, adjustment_id)
        SELECT id, adjustment_id FROM inventory_lots WHERE adjustment_id IS NOT NULL;
        DROP TABLE stock_adjustments;
        ALTER TABLE stock_adjustments_v2 RENAME TO stock_adjustments;
        UPDATE inventory_lots
        SET adjustment_id = (SELECT adjustment_id FROM _stock_adjustment_links WHERE lot_id = inventory_lots.id)
        WHERE id IN (SELECT lot_id FROM _stock_adjustment_links);
        DROP TABLE _stock_adjustment_links;
        CREATE INDEX idx_adjustments_fuel_date ON stock_adjustments(fuel_id, created_at DESC);

        CREATE TABLE sales_v2 (
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
        INSERT INTO sales_v2 (
          id, shift_id, user_id, fuel_id, fuel_type, litres, unit_price_cents, unit_cost_cents,
          amount_cents, amount, total_cents, cash_cents, mpesa_cents, payment_method, mode, pump_id,
          customer_name, notes, sold_at, timestamp, created_at, updated_at
        )
        SELECT id, shift_id, user_id, fuel_id, fuel_type, litres, unit_price_cents, unit_cost_cents,
               total_cents, total_cents / 100.0, total_cents, cash_cents, mpesa_cents, payment_method,
               'detailed', NULL, customer_name, notes, sold_at, sold_at, created_at, updated_at
        FROM sales;
        DROP TABLE sales;
        ALTER TABLE sales_v2 RENAME TO sales;
        CREATE INDEX idx_sales_shift ON sales(shift_id, sold_at DESC);
        CREATE INDEX idx_sales_user_date ON sales(user_id, sold_at DESC);
        CREATE INDEX idx_sales_fuel_date ON sales(fuel_id, sold_at DESC);
        CREATE INDEX idx_sales_mode_date ON sales(mode, sold_at DESC);

        CREATE TABLE expenses_v2 (
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
        INSERT INTO expenses_v2 (
          id, shift_id, user_id, category, description, amount_cents, amount, payment_method,
          expense_date, notes, timestamp, created_at, updated_at
        )
        SELECT id, shift_id, user_id, category, description, amount_cents, amount_cents / 100.0,
               payment_method, expense_date, notes, created_at, created_at, updated_at
        FROM expenses;
        DROP TABLE expenses;
        ALTER TABLE expenses_v2 RENAME TO expenses;
        CREATE INDEX idx_expenses_shift ON expenses(shift_id);
        CREATE INDEX idx_expenses_user_date ON expenses(user_id, expense_date DESC);

        ALTER TABLE pump_readings ADD COLUMN "date" TEXT NOT NULL DEFAULT '';
        ALTER TABLE pump_readings ADD COLUMN fuel_type TEXT NOT NULL DEFAULT 'PETROL';
        ALTER TABLE pump_readings ADD COLUMN opening_litres REAL NOT NULL DEFAULT 0;
        ALTER TABLE pump_readings ADD COLUMN closing_litres REAL NOT NULL DEFAULT 0;
        ALTER TABLE pump_readings ADD COLUMN prev_closing_litres REAL NOT NULL DEFAULT 0;
        ALTER TABLE pump_readings ADD COLUMN reconciliation_value_cents INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE pump_readings ADD COLUMN opening_ksh REAL NOT NULL DEFAULT 0;
        ALTER TABLE pump_readings ADD COLUMN closing_ksh REAL NOT NULL DEFAULT 0;
        ALTER TABLE pump_readings ADD COLUMN prev_closing_ksh REAL NOT NULL DEFAULT 0;
        UPDATE pump_readings
        SET "date" = reading_date,
            fuel_type = COALESCE((SELECT fuel_type FROM fuel_management WHERE fuel_management.id = pump_readings.fuel_id), 'PETROL'),
            opening_litres = CASE WHEN previous_closing IS NULL THEN 0 ELSE previous_closing END,
            closing_litres = closing_reading,
            prev_closing_litres = CASE WHEN previous_closing IS NULL THEN 0 ELSE previous_closing END,
            reconciliation_value_cents = CAST(ROUND(consumption * reconciliation_price_cents) AS INTEGER);

        ALTER TABLE sales_readings ADD COLUMN "date" TEXT NOT NULL DEFAULT '';
        ALTER TABLE sales_readings ADD COLUMN fuel_type TEXT NOT NULL DEFAULT 'PETROL';
        ALTER TABLE sales_readings ADD COLUMN opening_ksh REAL NOT NULL DEFAULT 0;
        ALTER TABLE sales_readings ADD COLUMN closing_ksh REAL NOT NULL DEFAULT 0;
        ALTER TABLE sales_readings ADD COLUMN prev_closing_ksh REAL NOT NULL DEFAULT 0;
        ALTER TABLE sales_readings ADD COLUMN reconciliation_value_cents INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE sales_readings ADD COLUMN opening_litres REAL NOT NULL DEFAULT 0;
        ALTER TABLE sales_readings ADD COLUMN closing_litres REAL NOT NULL DEFAULT 0;
        ALTER TABLE sales_readings ADD COLUMN prev_closing_litres REAL NOT NULL DEFAULT 0;
        UPDATE sales_readings
        SET "date" = reading_date,
            fuel_type = COALESCE((SELECT fuel_type FROM fuel_management WHERE fuel_management.id = sales_readings.fuel_id), 'PETROL'),
            opening_ksh = CASE WHEN previous_closing IS NULL THEN 0 ELSE previous_closing END,
            closing_ksh = closing_reading,
            prev_closing_ksh = CASE WHEN previous_closing IS NULL THEN 0 ELSE previous_closing END,
            reconciliation_value_cents = CAST(ROUND(consumption * 100.0) AS INTEGER);

        ALTER TABLE audit_logs ADD COLUMN user_id INTEGER;
        ALTER TABLE audit_logs ADD COLUMN timestamp TEXT NOT NULL DEFAULT '';
        UPDATE audit_logs SET user_id = actor_id, timestamp = created_at;
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
      `);
    },
  },
];
