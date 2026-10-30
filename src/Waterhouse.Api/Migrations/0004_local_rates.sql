-- =============================================================================
-- Configurable local (walk-in) rates
-- =============================================================================
-- Replaces the derived quick-rate buttons with an explicit, editable list.
--
-- The first implementation learned these from sales history: rates the counter
-- had actually charged, preferring local sales where any existed. It adapted
-- with no configuration, which sounded good and was wrong in practice - a
-- single local sale at one rate immediately collapsed the button set to that
-- one rate. An operator cannot predict which buttons will be there, and a POS
-- has to be predictable above all.
--
-- Rates are now configured, seeded below, and editable under Admin.
-- =============================================================================

CREATE TABLE local_rate (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id  INTEGER NOT NULL REFERENCES product(id) ON DELETE CASCADE,
    rate_paise  INTEGER NOT NULL CHECK (rate_paise > 0),
    sort_order  INTEGER NOT NULL DEFAULT 0,
    is_active   INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
    created_at  TEXT    NOT NULL,
    updated_at  TEXT    NOT NULL
);

-- One row per rate per product; the same rate cannot be listed twice.
CREATE UNIQUE INDEX ux_local_rate_product_rate ON local_rate (product_id, rate_paise);
CREATE INDEX ix_local_rate_product ON local_rate (product_id, sort_order) WHERE is_active = 1;

-- -----------------------------------------------------------------------------
-- Seed: 15, 20 and 25 for cans, which is the counter's walk-in pricing.
-- Other products start with none; add them under Admin when needed.
-- -----------------------------------------------------------------------------
INSERT OR IGNORE INTO local_rate (product_id, rate_paise, sort_order, is_active, created_at, updated_at)
SELECT p.id, r.rate_paise, r.sort_order, 1, '1970-01-01T00:00:00Z', '1970-01-01T00:00:00Z'
  FROM product p
  JOIN (SELECT 1500 AS rate_paise, 1 AS sort_order
        UNION ALL SELECT 2000, 2
        UNION ALL SELECT 2500, 3) r
 WHERE p.code = 'CAN';
