-- =============================================================================
-- Reference data
-- =============================================================================
-- Idempotent: every statement is INSERT OR IGNORE / guarded, so re-running the
-- migration set against an existing database is safe.
--
-- The admin user is NOT seeded here - a password hash cannot be computed in
-- SQL. Waterhouse.Api.Infrastructure.Db.Seeder creates it on first start.
-- =============================================================================

INSERT OR IGNORE INTO branch (id, code, name, address, phone, gstin, receipt_footer, created_at, updated_at)
VALUES (1, 'MAIN', 'Royal Aqua Products', '', '', '', 'Thank you, visit again',
        '1970-01-01T00:00:00Z', '1970-01-01T00:00:00Z');

-- -----------------------------------------------------------------------------
-- Products
--
-- Legacy module -> product mapping:
--   canentry            -> CAN     (sellable; consumes one CAP per unit)
--   caps                -> CAP     (stock only, never sold)
--   waterbottlein/out   -> BOTTLE  (sellable, stock tracked)
--   waterbagin/out      -> BAG     (sellable, stock tracked)
--
-- CAN has tracks_stock = 0 because the legacy app never held a can inventory -
-- cans are filled on demand. What it did track was cap consumption, which is
-- modelled by consumes_product_id.
-- -----------------------------------------------------------------------------
INSERT OR IGNORE INTO product
    (code, name, unit, is_sellable, tracks_stock, default_rate_paise, consume_qty, sort_order, is_active, created_at, updated_at)
VALUES
    ('CAP',    'Cap',          'pcs', 0, 1, 0, 0, 4, 1, '1970-01-01T00:00:00Z', '1970-01-01T00:00:00Z'),
    ('CAN',    'Water Can',    'pcs', 1, 0, 0, 1, 1, 1, '1970-01-01T00:00:00Z', '1970-01-01T00:00:00Z'),
    ('BOTTLE', 'Water Bottle', 'pcs', 1, 1, 0, 0, 2, 1, '1970-01-01T00:00:00Z', '1970-01-01T00:00:00Z'),
    ('BAG',    'Water Bag',    'pcs', 1, 1, 0, 0, 3, 1, '1970-01-01T00:00:00Z', '1970-01-01T00:00:00Z');

-- Wire the can -> cap consumption rule that was hard-coded in
-- CanentryController::ajaxstore in the legacy app.
UPDATE product
   SET consumes_product_id = (SELECT id FROM product WHERE code = 'CAP')
 WHERE code = 'CAN'
   AND consumes_product_id IS NULL;

-- -----------------------------------------------------------------------------
-- Document numbering
--
-- Formats match the legacy app so historical references stay recognisable:
--   sale     -> WC-00000001   (legacy printed '#WC-' + 8-digit zero-padded id)
--   customer -> CUST-0001
--
-- next_value is advanced by the importer to sit above the highest legacy
-- number, so migrated and new documents never collide.
-- -----------------------------------------------------------------------------
INSERT OR IGNORE INTO number_sequence (name, prefix, next_value, pad_width, updated_at)
VALUES
    ('sale',     'WC-',   1, 8, '1970-01-01T00:00:00Z'),
    ('customer', 'CUST-', 1, 4, '1970-01-01T00:00:00Z');

-- -----------------------------------------------------------------------------
-- Expense categories: seeded from the most frequent free-text exp_name values
-- in the legacy data. Existing expenses import with category_id NULL and can be
-- categorised later; nothing depends on them being set.
-- -----------------------------------------------------------------------------
INSERT OR IGNORE INTO expense_category (name, is_active, created_at) VALUES
    ('Salary',         1, '1970-01-01T00:00:00Z'),
    ('Diesel / Fuel',  1, '1970-01-01T00:00:00Z'),
    ('Electricity',    1, '1970-01-01T00:00:00Z'),
    ('Maintenance',    1, '1970-01-01T00:00:00Z'),
    ('Raw Material',   1, '1970-01-01T00:00:00Z'),
    ('Transport',      1, '1970-01-01T00:00:00Z'),
    ('Rent',           1, '1970-01-01T00:00:00Z'),
    ('Other',          1, '1970-01-01T00:00:00Z');
