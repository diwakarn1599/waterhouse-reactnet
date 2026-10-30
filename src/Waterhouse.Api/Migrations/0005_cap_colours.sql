-- =============================================================================
-- Cap colours: blue, green and white, each with its own inventory
-- =============================================================================
-- A cap is given away with every can to cover the top. It is not sold, so it
-- carries no price - but it is consumed from stock and has to be counted.
--
-- MODELLING NOTE (the important part)
--
-- The cap is recorded as a column on the can's sale_line, NOT as a second
-- sale_line at zero rate.
--
-- A zero-rate cap line would look tidy and would silently corrupt every report:
-- the day/month/year groupings sum sale_line.quantity, so 100 cans plus their
-- 100 caps would report as 200 units sold. Hanging the cap off the line it
-- belongs to keeps quantity and revenue reporting exactly as they were, while
-- stock still moves through stock_ledger like any other product.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- The three colours, as ordinary stock-tracked products.
--
-- Reusing `product` rather than inventing a cap_colour table means these get the
-- existing stock_receipt, stock_ledger, adjustment and reporting machinery for
-- free. A fourth colour later is one INSERT.
--
--   is_sellable = 0  they are never sold, so they stay out of the sell picker
--   tracks_stock = 1 they are counted
-- -----------------------------------------------------------------------------
INSERT OR IGNORE INTO product
    (code, name, unit, is_sellable, tracks_stock, default_rate_paise, consume_qty, sort_order, is_active, created_at, updated_at)
VALUES
    ('CAP-BLUE',  'Blue Cap',  'pcs', 0, 1, 0, 0, 10, 1, '1970-01-01T00:00:00Z', '1970-01-01T00:00:00Z'),
    ('CAP-GREEN', 'Green Cap', 'pcs', 0, 1, 0, 0, 11, 1, '1970-01-01T00:00:00Z', '1970-01-01T00:00:00Z'),
    ('CAP-WHITE', 'White Cap', 'pcs', 0, 1, 0, 0, 12, 1, '1970-01-01T00:00:00Z', '1970-01-01T00:00:00Z');

-- -----------------------------------------------------------------------------
-- Retire the single colourless cap.
--
-- Its 112k historical SALE movements stay exactly where they are, so past stock
-- history remains explainable. It is deactivated rather than deleted, and the
-- automatic can->cap consumption rule is cleared: which cap comes off the shelf
-- is now a per-sale choice and cannot be expressed as a fixed bill of materials.
-- -----------------------------------------------------------------------------
UPDATE product
   SET consumes_product_id = NULL, consume_qty = 0, updated_at = '1970-01-01T00:00:00Z'
 WHERE code = 'CAN';

UPDATE product
   SET is_active = 0, name = 'Cap (retired - pre-colour)', updated_at = '1970-01-01T00:00:00Z'
 WHERE code = 'CAP';

-- -----------------------------------------------------------------------------
-- Which cap went out with this line. NULL means none was given.
--
-- One cap per can, so the cap quantity is the line quantity; there is no second
-- number to keep in step and therefore no way for the two to disagree.
-- -----------------------------------------------------------------------------
ALTER TABLE sale_line ADD COLUMN cap_product_id INTEGER NULL REFERENCES product(id);

CREATE INDEX ix_sale_line_cap ON sale_line (cap_product_id) WHERE cap_product_id IS NOT NULL;
