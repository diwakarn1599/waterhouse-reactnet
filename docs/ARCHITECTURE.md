# Architecture

Why this is shaped the way it is. Each decision traces to one of three
constraints: **the counter must never wait**, **infrastructure and maintenance
must stay very cheap**, and **it must be open to extension**.

---

## The central idea

Going from shared hosting to a rewrite normally pushes you toward redundant
servers, because an outage now stops revenue. This design does the opposite:

> **Resilience lives in the client, so the server stays one cheap box.**

A sale is an append-only fact. It cannot conflict with another sale. So the till
can complete one entirely locally and forward it later. That single property is
what makes both "never hangs" and "$7 a month" true at the same time.

---

## Request shape

```
   Browser (React PWA)                 One ASP.NET Core process
  ┌──────────────────────┐            ┌────────────────────────────┐
  │ bootstrap snapshot   │            │  Kestrel                    │
  │  · every customer    │◄── once ───┤   /api/*   Minimal APIs     │
  │  · balances, rates   │            │   /*       React from       │
  │  · products, stock   │            │            wwwroot          │
  ├──────────────────────┤            ├────────────────────────────┤
  │ IndexedDB outbox     ├── async ──►│  Dapper                     │
  │  · sale + clientUuid │  (never    │  SQLite (WAL)               │
  │  · retried on its own│   blocks)  │   one file, no DB server    │
  └──────────────────────┘            └────────────────────────────┘
```

Same origin throughout: no CORS, no preflight, no second deployment, no CDN.

---

## The POS critical path

Everything needed to sell arrives in one `/api/bootstrap` call per shift — about
30 KB for 400 customers. After that:

| Step | Cost |
|---|---|
| Type-ahead customer search | in-memory, 0 ms |
| Rate and outstanding balance | already loaded, 0 ms |
| Total and balance | computed locally |
| Save | IndexedDB write, then print |
| Forward to server | background, unawaited |

The legacy screen issued **two sequential AJAX calls** before the operator could
type a quantity ([`custom-script.js:249`, `:274`]), one of which ran
`SUM(bal_amount)` over 112k rows with **no index on `customer_id`** — a full
table scan while a customer waited.

### The index that makes it work

The bootstrap balance query was the slowest thing in the system at **431.94 ms**.
Two properties fixed it, and both are required:

```sql
CREATE INDEX ix_sale_open_balance ON sale (customer_id, balance_amount_paise)
    WHERE is_void = 0 AND balance_amount_paise <> 0;
```

- **Covering** — `balance_amount_paise` is *in* the index, so the sum is answered
  without touching the table at all.
- **Partial** — only ~11% of sales (12,343 of 112,803) carry a balance.

Result: **1.53 ms**, a 282× improvement, confirmed by `EXPLAIN QUERY PLAN`
reporting `SCAN sale USING COVERING INDEX`.

### Why the till survives an outage

Because branches share no customers, the bootstrap payload is *complete and
authoritative* for this branch. Offline, balances are still correct — not stale.
A server outage costs nothing at the counter.

---

## Idempotency

The outbox retries, and a response lost to a dropped connection is
indistinguishable from a request that never arrived. Every submission carries a
client-generated `clientUuid`, enforced by a unique index and checked **inside**
the sale transaction, so two concurrent retries cannot both pass. A duplicate
returns the original sale with `wasDuplicate: true`; the client sees success and
the customer is billed once.

---

## Data decisions

**Money is integer paise.** Never `double`. MySQL `DOUBLE` cannot represent 0.01
exactly, and the error accumulates across 112k rows. All arithmetic is integer;
the single division in the codebase is explicit about its rounding.

**Stock is an append-only ledger.** On-hand is `SUM(change_qty)`. The legacy app
kept one mutable `caps.bal_caps` and updated it with a read-then-write **outside
any transaction**, guarded by `bal_caps > 0` — so once it drifted negative the
guard silently stopped all further decrements. Production data still holds −9,
−19, −49, −83. A ledger cannot drift, and every movement names its source row.

**Stock never blocks a sale.** Insufficient stock produces a warning, not a
refusal. The customer is at the counter and the goods are visibly there;
refusing would mean a queue and a paper bill. The ledger records reality.

**Sales are never deleted.** A void writes compensating ledger rows and keeps the
original.

**Four modules collapsed into one.** `canentry`, `waterbottlein/out` and
`waterbagin/out` were near-identical copies of the same schema and code. They are
now `product` + `sale` + `sale_line` + `stock_ledger`. Adding a product is a row,
not a new controller, model, migration and four views. The can→cap consumption
rule that was hard-coded in the legacy controller is now
`product.consumes_product_id`.

**Sales have lines.** The legacy entry was always one product. Lines cost nothing
now and mean a future mixed bill needs no schema change on a 112k-row table.

**A local sale has no customer.** Walk-in trade sets `is_local = 1` and
`customer_id = NULL`. It is deliberately *not* a placeholder customer row.

The legacy app had no local concept, so operators booked walk-ins against a
handful of real accounts — BISMILLA, nagaraj, M.g.r and two others — and the
daily sheet separated them with a hard-coded
`whereIn('customer_id', [1,2,3,4,38])`. Those accounts accrued meaningless
balances and every report depended on a magic id list. Using a single "Local"
customer row instead would be the same mistake, one row smaller: it would still
appear in customer pickers, still accrue a balance, and still need excluding by
id everywhere.

Two CHECK constraints make it structural rather than conventional:

```sql
CHECK ((is_local = 1 AND customer_id IS NULL) OR
       (is_local = 0 AND customer_id IS NOT NULL))
CHECK (is_local = 0 OR balance_amount_paise = 0)   -- walk-ins settle in full
```

The consequence is that registered-vs-local revenue is an exact `GROUP BY
is_local`, not an approximation, and it is impossible to book a walk-in onto a
real account by accident.

**Quick rates are learned, not configured.** The POS shows one-tap rate buttons
for local entry, derived server-side from the rates the counter actually
charges. They are drawn from *local* sales where any exist, falling back to
overall history otherwise — walk-in pricing is not the same as an agreed account
rate, and the fallback keeps the buttons useful on day one. No list to maintain.

---

## Reports

Two parameterised endpoints replace fourteen legacy actions. The old
`ReportController` was **912 lines** building HTML by string concatenation inside
`foreach` loops; each report also had a duplicate AJAX twin.

They are all the same aggregate over a date window with a different `GROUP BY`.
The grouping expression comes from a fixed allow-list — nothing from the query
string reaches the SQL text — and every value is a bound parameter.

**One subtlety worth knowing:** money is aggregated at the *sale* level, never
through a join to `sale_line`. A two-line bill would otherwise contribute its
total twice. Quantity therefore arrives pre-aggregated per sale from a subquery,
and the join is `LEFT` so the 755 imported line-less rows survive — six of them
carry ₹13,775 in payments that an inner join would silently drop.

Grouping *by product* is a genuinely different shape and uses its own query over
lines, reporting line amounts and leaving settlement columns at zero rather than
inventing a per-product apportionment of a bill-level payment.

---

## Extension seam

`IEndpointModule` is discovered by assembly scan at startup. A new feature is a
new folder; `Program.cs` never changes and there is no central registry to edit.

Schema changes are new numbered `.sql` files. Applied migrations are immutable —
a checksum is stored, and startup **fails loudly** if one was edited, rather than
serving a schema the code was not written against.

Already prepared, unused: `delivery_route` plus nullable `route_id` on `customer`
and `sale`. Adding a nullable column to an empty table is free today; altering
`sale` once it holds 112k rows is a maintenance window. Suppliers and purchases
need no preparation — they extend `stock_receipt` additively.

---

## What was deliberately left out

**EF Core** — a migration system and a startup model-building cost, to save
writing about twenty queries. Dapper has had no breaking change in years.

**JWT** — single origin, browser-only client. Cookies are simpler, revocable,
and unreadable by page scripts.

**A component library** — about fifteen hand-built primitives, and no upstream
breaking changes, ever.

**Docker, nginx, Redis, a message queue** — see `DEPLOYMENT.md`. Each is
something that breaks at 2 a.m. and none earn their place at 80 sales a day.

**Charts on the POS path** — `recharts` is 110 KB gzipped and is code-split into
its own chunk loaded only by the Dashboard. The counter path is 124 KB total,
against roughly 1.5 MB of jQuery plugins in the legacy app.

---

## Multi-branch, later

The design assumes **database per branch, one application**. Branches share no
customers and no balances, so no query ever crosses branches — exactly the
condition where per-database isolation is free and structural rather than a
`WHERE branch_id = @x` discipline that one forgotten clause breaks.

When branch two arrives: resolve the tenant from the signed-in user's claim,
select the connection string per request, and run migrations per tenant with a
`--tenant` flag. Consolidated reporting is a nightly job pulling per-branch
aggregates into a small reporting database — deliberately not live, so it never
touches a counter's data.
