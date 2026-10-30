# Migration from the legacy database

What the importer did to your production data, what it found wrong, and what
still needs a human decision.

Run it with:

```bash
cd tools/import
node import.mjs --dump "<path>/waterhouse25042020.sql" \
                --out ../../data/waterhouse.db \
                --report ../../data/import-report.json \
                --opening-stock CAP=0 --force
```

It reads the mysqldump text directly. No MySQL server, no .NET SDK. Takes about
13 seconds for 112k rows.

---

## Reconciliation

The whole point. Every figure matches the legacy database exactly:

| | Legacy | Imported |
|---|---|---|
| Cans sold | 5,199,424 | 5,199,424 |
| Total billed | ₹4,81,68,874.39 | ₹4,81,68,874.39 |
| Collected | ₹4,69,41,343.54 | ₹4,69,41,343.54 |
| Outstanding | ₹12,25,831.35 | ₹12,25,831.35 |

Verify this yourself after any re-run: the importer exits with a non-zero status
if the four totals do not agree.

**Row counts:** 400 customers, 112,803 sales (112,734 cans + 2 bottles + 67 bags),
1,588 expenses, 21 stock receipts, 2 users, 395 customer rates.

---

## Rules the importer follows

**Financial amounts are never silently altered.** Where the legacy data is
internally inconsistent, it is imported exactly as recorded and counted in the
report so a human can decide. The importer's job is to move your data, not to
have opinions about it.

The one exception is a derived field:

- **`payment_status`** is recomputed from the amounts. The legacy flag was
  assigned in browser JavaScript and disagrees with the actual balance on 4,436
  rows. It is presentational, not financial.

---

## Anomalies found in your data, and how each was handled

### 755 sales with zero quantity
The new schema requires `quantity > 0` on a line. These are imported as sale
headers **with no line**. They contribute zero to every total, so reports are
unaffected, and no historical row is lost.

### 6 of those 755 carry money — ₹13,775 in total
This is the interesting one. Rows like `total_cans = 0, paid_amount = 10000,
bal_amount = -10000`. They are **debt settlements**: the operator recorded a
customer paying off an old balance by entering a sale of zero cans.

They are preserved exactly, and every report sums money from the sale header
rather than through a join to lines, specifically so this ₹13,775 is not
silently dropped.

Going forward, the **Payments** screen records settlements properly, against the
oldest unpaid sales first.

### 3,728 sales with a negative balance
Overpayments — customer paid ₹449 on a ₹448.50 bill. Legitimate credits, so the
schema deliberately does **not** constrain `balance_amount_paise` to be
non-negative. Imported unchanged.

### 6 duplicate customer codes
`CUST-0008`, `CUST-0015`, `CUST-0037`, `CUST-0159`, `CUST-0296`, `CUST-0372` were
each held by two customers. The legacy code generated these as `COUNT(*) + 1`,
which collides after any deletion.

The second holder gets a `-2` suffix and a note on the record explaining why.
Legacy row ids are preserved, so nothing else needed remapping. The new schema
has a unique index on `customer.code` and allocates from `number_sequence`.

### 3 sales dated 1970-01-01
Replaced with the date part of `created_at`, which is sane on all three. The
original value is noted on the sale.

### 7 sales where quantity × rate ≠ total
The legacy form allowed the total to be overridden. `sale_line.amount_paise` is
set to the **billed total** so the header and its lines always agree; quantity
and rate keep their recorded values.

### 9 sales where paid + balance ≠ total
Left exactly as recorded. Changing `balance` to `total − paid` would invent a
debt the business treated as settled, and that is not a decision an import
script should make. **Review these nine.** They are listed in the JSON report.

### 2 users, neither able to sign in
Legacy password hashes are PHP bcrypt, which this application deliberately does
not implement rather than take a dependency for two accounts. Both profiles are
imported with an empty hash, which means "cannot sign in". An administrator sets
a password from the Admin screen to enable each one.

On first start, if no account can sign in, a fresh administrator is created and
its password printed **once** to the log.

---

## Two things that need your decision

### 1. Cap stock is fiction and must be counted

Cap purchases were recorded until **January 2017**. Can sales continued to
**April 2020**. So the honest ledger, built from every recorded receipt and every
recorded sale, lands at **−4,702,521 caps**.

That number is not a bug — it is the correct consequence of four years of
unrecorded purchases. The legacy `bal_caps` column hid it by silently refusing to
decrement once it went negative, which is why it showed −9, −19, −49, −83.

The importer posts one explicit `OPENING` adjustment to bring on-hand to whatever
you pass via `--opening-stock CAP=N` (default 0), leaving an auditable trail.

**Do a physical count before go-live and re-run with the real number.** From that
point the ledger cannot drift.

### 2. Customer rates were derived from history

Only **2 of 400** customers had `canrate` populated, yet the legacy POS blocks
entry when the rate is empty and the field is `readonly`. On paper, 398
customers could not be billed.

Each customer's default rate was therefore derived from the rate on **their most
recent actual sale** — 393 customers got one that way, 2 from the column, 5 have
none (no sales history).

In the new POS the rate is **pre-filled but editable**, because your historical
data shows rates genuinely varying per sale (6.50, 7, 8, 15). Only an
administrator can change a customer's stored agreed rate.

If you want the rate locked for operators instead, that is a small change in
`Pos.tsx` and `CustomerEndpoints.cs`.

---

## Re-running

The importer is destructive on its target: `--force` deletes the output file
first. It never touches the source dump. Re-run it as often as you like while
testing — the reconciliation check makes it obvious if anything drifts.

Before go-live, take a final dump from the live MySQL database and re-run against
that, so no sales made during the changeover are missed.
