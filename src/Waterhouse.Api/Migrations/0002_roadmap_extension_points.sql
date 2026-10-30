-- =============================================================================
-- Prepared extension points
-- =============================================================================
-- These structures are NOT used by any endpoint or screen yet. They exist
-- because adding a nullable column to an empty table costs nothing today,
-- whereas altering `sale` once it holds 112k rows is a maintenance window.
--
-- Roadmap items this prepares for:
--   1. Delivery routes & drivers  - tables + nullable FKs below
--   2. Purchases & suppliers      - needs no preparation. supplier_id can be
--                                   added to stock_receipt additively later,
--                                   and a `supplier` table joins nothing that
--                                   already exists.
--
-- If you decide against delivery routes, this whole file can be deleted before
-- the first deployment with no impact on anything else.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- delivery_route: a delivery round (e.g. "North Round", "Tuesday Van 2").
-- -----------------------------------------------------------------------------
CREATE TABLE delivery_route (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    code        TEXT    NOT NULL,
    name        TEXT    NOT NULL,
    driver_id   INTEGER     NULL REFERENCES app_user(id),
    sort_order  INTEGER NOT NULL DEFAULT 0,
    is_active   INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
    created_at  TEXT    NOT NULL,
    updated_at  TEXT    NOT NULL
);
CREATE UNIQUE INDEX ux_delivery_route_code ON delivery_route (code);

-- Which round a customer normally belongs to.
ALTER TABLE customer ADD COLUMN route_id INTEGER NULL REFERENCES delivery_route(id);
CREATE INDEX ix_customer_route ON customer (route_id);

-- Snapshot of the round a sale was actually delivered on. Kept separate from
-- customer.route_id so that reassigning a customer never rewrites history.
ALTER TABLE sale ADD COLUMN route_id INTEGER NULL REFERENCES delivery_route(id);
CREATE INDEX ix_sale_route_date ON sale (route_id, sale_date);
