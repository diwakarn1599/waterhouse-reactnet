-- =============================================================================
-- Waterhouse - initial schema
-- =============================================================================
-- Conventions (deliberate, and different from the legacy MySQL schema):
--
--  MONEY      stored as INTEGER paise (1/100 rupee). Never REAL.
--             The legacy schema used DOUBLE for money, which cannot represent
--             0.01 exactly and accumulates error across 112k rows.
--  DATE       TEXT 'YYYY-MM-DD'           (sorts correctly, portable)
--  TIMESTAMP  TEXT 'YYYY-MM-DDTHH:MM:SSZ' (UTC)
--  BOOLEAN    INTEGER 0/1
--
-- Every table queried by a non-PK column has an index for it. The legacy
-- schema had none, so a customer-balance lookup scanned 112k rows.
-- =============================================================================

-- -----------------------------------------------------------------------------
-- branch: single row. Identifies this installation on receipts and reports.
-- Each branch runs its own database, so there is exactly one row here.
-- -----------------------------------------------------------------------------
CREATE TABLE branch (
    id              INTEGER PRIMARY KEY CHECK (id = 1),
    code            TEXT    NOT NULL,
    name            TEXT    NOT NULL,
    address         TEXT    NOT NULL DEFAULT '',
    phone           TEXT    NOT NULL DEFAULT '',
    gstin           TEXT    NOT NULL DEFAULT '',
    receipt_footer  TEXT    NOT NULL DEFAULT 'Thank you, visit again',
    created_at      TEXT    NOT NULL,
    updated_at      TEXT    NOT NULL
);

-- -----------------------------------------------------------------------------
-- app_user
-- -----------------------------------------------------------------------------
CREATE TABLE app_user (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    username       TEXT    NOT NULL,
    display_name   TEXT    NOT NULL,
    email          TEXT    NOT NULL DEFAULT '',
    password_hash  TEXT    NOT NULL,
    role           TEXT    NOT NULL CHECK (role IN ('admin','operator')),
    is_active      INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
    last_login_at  TEXT        NULL,
    created_at     TEXT    NOT NULL,
    updated_at     TEXT    NOT NULL
);
CREATE UNIQUE INDEX ux_app_user_username ON app_user (username);

-- -----------------------------------------------------------------------------
-- product
--
-- Collapses the legacy canentry / waterbottle* / waterbag* / caps modules into
-- one table. Those four were near-identical copies of the same code and schema.
-- Adding a new sellable item is now a row, not a new controller + model +
-- migration + four views.
--
--   consumes_product_id : component drawn from stock when this item is sold.
--                         A Can consumes 1 Cap - the legacy hard-coded rule.
-- -----------------------------------------------------------------------------
CREATE TABLE product (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    code                 TEXT    NOT NULL,
    name                 TEXT    NOT NULL,
    unit                 TEXT    NOT NULL DEFAULT 'pcs',
    is_sellable          INTEGER NOT NULL DEFAULT 1 CHECK (is_sellable IN (0,1)),
    tracks_stock         INTEGER NOT NULL DEFAULT 1 CHECK (tracks_stock IN (0,1)),
    default_rate_paise   INTEGER NOT NULL DEFAULT 0 CHECK (default_rate_paise >= 0),
    consumes_product_id  INTEGER     NULL REFERENCES product(id),
    consume_qty          INTEGER NOT NULL DEFAULT 0 CHECK (consume_qty >= 0),
    sort_order           INTEGER NOT NULL DEFAULT 0,
    is_active            INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
    created_at           TEXT    NOT NULL,
    updated_at           TEXT    NOT NULL
);
CREATE UNIQUE INDEX ux_product_code ON product (code);

-- -----------------------------------------------------------------------------
-- customer
--
-- code was generated as COUNT(*)+1 in the legacy app, which produced a real
-- duplicate in production (ids 8 and 9 both hold 'CUST-0008'). It is now a
-- uniquely-indexed column fed by number_sequence.
-- -----------------------------------------------------------------------------
CREATE TABLE customer (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    code          TEXT    NOT NULL,
    name          TEXT    NOT NULL,
    company_name  TEXT    NOT NULL DEFAULT '',
    phone         TEXT    NOT NULL DEFAULT '',
    address       TEXT    NOT NULL DEFAULT '',
    note          TEXT    NOT NULL DEFAULT '',
    is_active     INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
    created_by    INTEGER     NULL REFERENCES app_user(id),
    created_at    TEXT    NOT NULL,
    updated_at    TEXT    NOT NULL
);
CREATE UNIQUE INDEX ux_customer_code ON customer (code);
CREATE INDEX ix_customer_name        ON customer (name);
CREATE INDEX ix_customer_is_active   ON customer (is_active);

-- -----------------------------------------------------------------------------
-- customer_product_rate
-- Generalises the legacy customer.canrate single column to a rate per product.
-- Falls back to product.default_rate_paise when absent.
-- -----------------------------------------------------------------------------
CREATE TABLE customer_product_rate (
    customer_id  INTEGER NOT NULL REFERENCES customer(id) ON DELETE CASCADE,
    product_id   INTEGER NOT NULL REFERENCES product(id),
    rate_paise   INTEGER NOT NULL CHECK (rate_paise >= 0),
    updated_at   TEXT    NOT NULL,
    PRIMARY KEY (customer_id, product_id)
);

-- -----------------------------------------------------------------------------
-- sale  (replaces canentry, waterbottleout, waterbagout)
--
--  client_uuid : idempotency key generated by the POS client before the request
--                leaves the browser. Lets the offline outbox retry a submission
--                without any risk of double-billing a customer.
--  is_void     : sales are never deleted. Corrections void and re-enter.
--
--  is_local / customer_id
--    A local sale is walk-in counter trade with NO customer: customer_id is
--    NULL. It is deliberately not modelled as a placeholder customer row.
--
--    The legacy app had no local concept, so operators booked walk-in trade
--    against a handful of real customer accounts and the daily sheet separated
--    them with a hard-coded `whereIn('customer_id', [1,2,3,4,38])`. That put
--    meaningless balances on named accounts and made every report depend on a
--    magic id list. Reproducing it with a single "Local" customer row would be
--    the same mistake, one row smaller: it would still surface in customer
--    pickers, still accrue a balance, and still need excluding by id everywhere.
--
--    The CHECK below makes the invariant structural rather than a convention -
--    a local sale cannot have a customer, and a registered sale cannot lack one.
-- -----------------------------------------------------------------------------
CREATE TABLE sale (
    id                   INTEGER PRIMARY KEY AUTOINCREMENT,
    invoice_no           TEXT    NOT NULL,
    sale_date            TEXT    NOT NULL,
    customer_id          INTEGER     NULL REFERENCES customer(id),
    is_local             INTEGER NOT NULL DEFAULT 0 CHECK (is_local IN (0,1)),
    total_amount_paise   INTEGER NOT NULL CHECK (total_amount_paise >= 0),
    paid_amount_paise    INTEGER NOT NULL CHECK (paid_amount_paise  >= 0),
    balance_amount_paise INTEGER NOT NULL,
    payment_status       TEXT    NOT NULL CHECK (payment_status IN ('PAID','PARTIAL','UNPAID')),
    -- How the paid portion was tendered. Mirrors payment.method so counter
    -- takings and later settlements can be reported together.
    payment_method       TEXT    NOT NULL DEFAULT 'CASH',
    note                 TEXT    NOT NULL DEFAULT '',
    client_uuid          TEXT        NULL,
    is_void              INTEGER NOT NULL DEFAULT 0 CHECK (is_void IN (0,1)),
    voided_at            TEXT        NULL,
    voided_by            INTEGER     NULL REFERENCES app_user(id),
    void_reason          TEXT    NOT NULL DEFAULT '',
    created_by           INTEGER     NULL REFERENCES app_user(id),
    created_at           TEXT    NOT NULL,
    updated_at           TEXT    NOT NULL,

    CONSTRAINT ck_sale_local_has_no_customer CHECK (
        (is_local = 1 AND customer_id IS NULL) OR
        (is_local = 0 AND customer_id IS NOT NULL)
    ),
    -- Walk-in trade is cash-and-carry: there is no account to bill later, so a
    -- local sale must settle in full. Enforced here rather than only in the API.
    CONSTRAINT ck_local_sale_fully_paid CHECK (
        is_local = 0 OR balance_amount_paise = 0
    )
);
CREATE UNIQUE INDEX ux_sale_invoice_no  ON sale (invoice_no);
CREATE UNIQUE INDEX ux_sale_client_uuid ON sale (client_uuid) WHERE client_uuid IS NOT NULL;
CREATE INDEX ix_sale_date               ON sale (sale_date);
CREATE INDEX ix_sale_customer_date      ON sale (customer_id, sale_date);

-- Covering partial index behind the POS bootstrap payload - the single most
-- latency-sensitive query in the application, since every customer's balance
-- must be in the browser before the first sale of the shift.
--
-- It is COVERING (balance_amount_paise is in the index, not just the key) so
-- the sum is answered from the index with no table access at all, and PARTIAL
-- so it holds only the ~11% of sales that actually carry a balance. Without
-- both properties this query visits all 112k rows and takes ~430 ms.
CREATE INDEX ix_sale_open_balance ON sale (customer_id, balance_amount_paise)
    WHERE is_void = 0 AND balance_amount_paise <> 0;

-- Daily/period money rollups for the dashboard and reports, answered from the
-- index alone. is_local is carried so the registered-vs-local split on the
-- dashboard costs nothing extra.
CREATE INDEX ix_sale_date_amounts ON sale (sale_date, is_local, total_amount_paise, paid_amount_paise, balance_amount_paise)
    WHERE is_void = 0;

CREATE INDEX ix_sale_local          ON sale (is_local, sale_date) WHERE is_void = 0;
CREATE INDEX ix_sale_payment_method ON sale (payment_method, sale_date) WHERE is_void = 0;

-- -----------------------------------------------------------------------------
-- sale_line
-- The legacy entry was always a single product. Lines exist so a future bill
-- can mix cans and bottles without a schema change.
-- -----------------------------------------------------------------------------
CREATE TABLE sale_line (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    sale_id       INTEGER NOT NULL REFERENCES sale(id) ON DELETE CASCADE,
    product_id    INTEGER NOT NULL REFERENCES product(id),
    quantity      INTEGER NOT NULL CHECK (quantity > 0),
    rate_paise    INTEGER NOT NULL CHECK (rate_paise >= 0),
    amount_paise  INTEGER NOT NULL CHECK (amount_paise >= 0)
);
CREATE INDEX ix_sale_line_sale    ON sale_line (sale_id);
CREATE INDEX ix_sale_line_product ON sale_line (product_id);

-- -----------------------------------------------------------------------------
-- payment
-- New. The legacy app could only take money at the moment of sale, so a
-- customer settling an old balance had no representation. sale.paid_amount_paise
-- remains the at-counter payment; this table records everything after that.
-- -----------------------------------------------------------------------------
CREATE TABLE payment (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id   INTEGER NOT NULL REFERENCES customer(id),
    sale_id       INTEGER     NULL REFERENCES sale(id),
    payment_date  TEXT    NOT NULL,
    amount_paise  INTEGER NOT NULL CHECK (amount_paise > 0),
    method        TEXT    NOT NULL DEFAULT 'CASH',
    note          TEXT    NOT NULL DEFAULT '',
    client_uuid   TEXT        NULL,
    created_by    INTEGER     NULL REFERENCES app_user(id),
    created_at    TEXT    NOT NULL
);
CREATE UNIQUE INDEX ux_payment_client_uuid ON payment (client_uuid) WHERE client_uuid IS NOT NULL;
CREATE INDEX ix_payment_customer ON payment (customer_id);
CREATE INDEX ix_payment_date     ON payment (payment_date);

-- -----------------------------------------------------------------------------
-- stock_receipt  (replaces waterbottlein, waterbagin, and caps batch entry)
-- -----------------------------------------------------------------------------
CREATE TABLE stock_receipt (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id    INTEGER NOT NULL REFERENCES product(id),
    receipt_date  TEXT    NOT NULL,
    quantity      INTEGER NOT NULL CHECK (quantity > 0),
    amount_paise  INTEGER NOT NULL DEFAULT 0 CHECK (amount_paise >= 0),
    note          TEXT    NOT NULL DEFAULT '',
    created_by    INTEGER     NULL REFERENCES app_user(id),
    created_at    TEXT    NOT NULL,
    updated_at    TEXT    NOT NULL
);
CREATE INDEX ix_stock_receipt_product_date ON stock_receipt (product_id, receipt_date);

-- -----------------------------------------------------------------------------
-- stock_ledger
--
-- Append-only. Stock on hand is SUM(change_qty), never a mutable counter.
--
-- The legacy app kept a single mutable caps.bal_caps and updated it with a
-- read-then-write outside any transaction, guarded by 'bal_caps > 0'. Once it
-- drifted negative the guard silently stopped all further decrements. Production
-- data contains -9, -19, -49 and -83, and the figure has been wrong for years.
-- An append-only ledger cannot drift, and every movement names its source row.
-- -----------------------------------------------------------------------------
CREATE TABLE stock_ledger (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id  INTEGER NOT NULL REFERENCES product(id),
    entry_date  TEXT    NOT NULL,
    change_qty  INTEGER NOT NULL,
    -- SNAPSHOT is accepted but not yet emitted. On-hand is currently a covering
    -- scan of the whole ledger (~18 ms at 112k rows, read once per POS session).
    -- If that ever matters, write periodic SNAPSHOT rows and sum only from the
    -- latest one. Allowing the value now avoids rebuilding a large table later
    -- just to widen this CHECK constraint.
    ref_type    TEXT    NOT NULL CHECK (ref_type IN ('RECEIPT','SALE','ADJUSTMENT','OPENING','SNAPSHOT')),
    ref_id      INTEGER     NULL,
    note        TEXT    NOT NULL DEFAULT '',
    created_by  INTEGER     NULL REFERENCES app_user(id),
    created_at  TEXT    NOT NULL
);
-- Covering: on-hand is SUM(change_qty) per product and is read on every POS
-- bootstrap and every stock screen. Including change_qty in the index keeps it
-- an index-only scan as the ledger grows.
CREATE INDEX ix_stock_ledger_product      ON stock_ledger (product_id, change_qty);
CREATE INDEX ix_stock_ledger_product_date ON stock_ledger (product_id, entry_date, change_qty);
CREATE INDEX ix_stock_ledger_ref          ON stock_ledger (ref_type, ref_id);

-- -----------------------------------------------------------------------------
-- expense
-- exp_name was free text in the legacy schema. Category is optional so existing
-- rows import unchanged, but reporting can group once categories are assigned.
-- -----------------------------------------------------------------------------
CREATE TABLE expense_category (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT    NOT NULL,
    is_active  INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0,1)),
    created_at TEXT    NOT NULL
);
CREATE UNIQUE INDEX ux_expense_category_name ON expense_category (name);

CREATE TABLE expense (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    expense_date  TEXT    NOT NULL,
    category_id   INTEGER     NULL REFERENCES expense_category(id),
    description   TEXT    NOT NULL,
    amount_paise  INTEGER NOT NULL CHECK (amount_paise >= 0),
    note          TEXT    NOT NULL DEFAULT '',
    created_by    INTEGER     NULL REFERENCES app_user(id),
    created_at    TEXT    NOT NULL,
    updated_at    TEXT    NOT NULL
);
CREATE INDEX ix_expense_date     ON expense (expense_date);
CREATE INDEX ix_expense_category ON expense (category_id);

-- -----------------------------------------------------------------------------
-- number_sequence: collision-free document numbering.
-- Allocated inside the same transaction as the document it numbers.
-- -----------------------------------------------------------------------------
CREATE TABLE number_sequence (
    name        TEXT    PRIMARY KEY,
    prefix      TEXT    NOT NULL DEFAULT '',
    next_value  INTEGER NOT NULL,
    pad_width   INTEGER NOT NULL DEFAULT 8,
    updated_at  TEXT    NOT NULL
);

-- -----------------------------------------------------------------------------
-- audit_log: who changed what. The legacy app recorded created_by as 0 on
-- every customer row, so attribution was never actually available.
-- -----------------------------------------------------------------------------
CREATE TABLE audit_log (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    entity      TEXT    NOT NULL,
    entity_id   INTEGER NOT NULL,
    action      TEXT    NOT NULL,
    detail      TEXT    NOT NULL DEFAULT '',
    user_id     INTEGER     NULL REFERENCES app_user(id),
    created_at  TEXT    NOT NULL
);
CREATE INDEX ix_audit_entity  ON audit_log (entity, entity_id);
CREATE INDEX ix_audit_created ON audit_log (created_at);
