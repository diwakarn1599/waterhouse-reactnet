# Waterhouse

Point of sale and back office for a mineral water plant — counter sales, customer
accounts, stock, expenses and reporting.

A ground-up rewrite of a Laravel 5.2 / PHP 5.5 application that had been running
since 2016, carrying **112,000 sales** and **400 customers** of real history.

> **The one rule that shapes everything here: the counter must never wait.**
> A customer is standing in a queue, so completing a sale makes no blocking
> network call at all. Everything else — the database choice, the offline queue,
> the indexes — follows from that.

---

## Contents

1. [What it is](#1-what-it-is)
2. [Features](#2-features)
3. [Onboarding & walkthrough](#3-onboarding--walkthrough)
4. [Tech stack, and why](#4-tech-stack-and-why)
5. [Deployment](#5-deployment)
6. [Running locally](#6-running-locally)
7. [Prerequisites](#7-prerequisites)
8. [Summary — for technical and non-technical audiences](#8-summary)

---

## 1. What it is

A single web application that runs the whole business:

- A **till** for selling water cans, bottles and bags over the counter
- **Customer accounts** with agreed rates and running balances
- **Walk-in sales** for unregistered customers
- **Cap inventory** in three colours, issued daily and drawn down per sale
- **Expenses**, **payments**, **stock** and a **reporting** suite
- A **dispensing slip** printer for the cashier-to-dispenser handover

### Scale it runs at

| | |
|---|---|
| Sales in the database | 112,838 |
| Customers | 400 |
| Stock movements | 112,113 |
| Transactions per day | ~80 |
| Database size | ~46 MB (one file) |
| Concurrent users | 1–3 at one counter |

This is a small, high-frequency business. Every architectural decision assumes
that: it is designed to be **fast and cheap**, not to scale to millions.

### Codebase

| Part | Lines |
|---|---|
| Backend (C#) | 4,277 |
| Schema (SQL) | 549 |
| Frontend (TypeScript/TSX) | 4,774 |
| Data importer (JS) | 731 |

### Layout

```
waterhouse-next/
├─ src/
│  ├─ Waterhouse.Api/          ASP.NET Core · Minimal APIs · Dapper · SQLite
│  │  ├─ Migrations/*.sql      schema, applied in order, checksum-journalled
│  │  ├─ Infrastructure/       db, auth, money, clock, validation, module seam
│  │  ├─ Features/             one folder per slice — the extension point
│  │  └─ wwwroot/              built UI (generated, not in git)
│  └─ web/                     React 19 · TypeScript · Vite · Tailwind
├─ tools/import/               legacy MySQL dump → SQLite, one time
├─ docs/                       architecture, deployment, migration notes
└─ data/                       the SQLite database (generated, not in git)
```

---

## 2. Features

### Selling

**Two entry modes.** *Registered* — search a customer, their agreed rate and
outstanding balance are already loaded, and the bill can be part-paid on
account. *Local / walk-in* — no customer at all, one tap on a rate, settled in
full.

**Keyboard-first.** Search → Enter → quantity → Enter → saved and printed. A
trained operator never needs the mouse.

**Never blocks.** Sales are written to the browser's own storage first, printed
immediately, and forwarded in the background. If the server or the internet is
down, the counter keeps selling.

**Cannot double-bill.** Every sale carries a client-generated UUID that the
server treats as an idempotency key. A retry after a lost response returns the
original sale rather than creating a second one.

**Configurable walk-in rates.** One-tap buttons (₹15 / ₹20 / ₹25 by default),
editable under Admin.

**Payment method** on every sale — Cash, UPI, Card, Bank, Cheque, Credit.

### Cap inventory

A cap is given away with every can. Three colours, each with its own stock.

- Admin records the morning's issue — all colours in one submission
- The operator picks a colour per sale; the count drops instantly
- Counts refresh every 15 seconds, so an admin top-up appears in ~5s
- Reports show `opening + issued − used ± adjusted = closing` per colour, with
  Today / 7-day / Month / Year / custom ranges
- Running out **warns but never blocks** a sale

### Customers & money

- Customer master with per-product agreed rates and running balances
- **Payments** against outstanding balances, applied oldest-invoice-first
- Outstanding-balance report across all customers
- Per-customer ledger of sales and payments

### Stock

- Append-only ledger — on-hand is always the sum of movements, never a mutable
  counter that can drift
- Stock receipts, physical-count adjustments, full movement history
- Voiding a sale automatically reverses its stock movements

### Reporting

One parameterised screen replacing fourteen legacy report pages:

- Group by **day / month / year / customer / product / registered-vs-local**
- Filter by date range, product, customer, customer type, payment method
- Expenses by day / month / year / category
- CSV export

### Dashboard

Today's sales and cash-in, month-vs-previous-month, outstanding balances,
registered-vs-local split, payments by method, daily and monthly charts, top
customers, customers who haven't bought in 2+ days, and stock on hand — all
filterable by payment method.

### Admin

Users and roles, password management, branch details, walk-in rate
configuration, consistent database backup download, and an audit log.

### Dispensing slip

Deliberately minimal — **item, cap, quantity, rate, and nothing else**. No
business name, totals, customer or date. It is an internal handover from cashier
to dispenser, not a bill, so every extra line would be thermal ink spent on
information nobody in that loop reads.

```
ITEM       CAP        QTY    RATE
Water Can  Blue Cap    30   25.00
```

---

## 3. Onboarding & walkthrough

### First run

On first start, if no account can sign in, an administrator is created and its
password is printed **once** to the log:

```bash
journalctl -u waterhouse | grep -A3 'administrator was created'
```

Sign in and change it immediately.

### Day one checklist

1. **Admin → Branch details** — business name, address, phone, GSTIN. These
   appear nowhere on the dispensing slip, but are used elsewhere.
2. **Admin → Local rates** — the walk-in rate buttons. Seeded 15 / 20 / 25.
3. **Admin → Users** — create one account per operator. Give operators the
   `operator` role, not `admin`.
4. **Stock → Caps** — issue the real opening cap counts.
5. **Stock → Stock received** — do a physical count and post an adjustment so
   bottle and bag stock start from the truth.

> **Imported accounts cannot sign in.** Users migrated from the legacy database
> arrive with no password, because the old hashes are in a format this
> application deliberately does not implement. Set a password for each under
> Admin → Users to enable them.

### Roles

| | Operator | Admin |
|---|---|---|
| Sell, print, take payments | ✅ | ✅ |
| View sales, customers, reports | ✅ | ✅ |
| Add/edit customers | ✅ | ✅ |
| Record stock received | ✅ | ✅ |
| **Void a sale** | ❌ | ✅ |
| **Change agreed rates** | ❌ | ✅ |
| **Issue caps, adjust stock** | ❌ | ✅ |
| **Users, branch, rates, backup** | ❌ | ✅ |

### Operator walkthrough — a registered sale

1. Open **Sell**. The cursor is already in the customer box.
2. Type a name, code or phone. Arrow keys to choose, **Enter** to select.
   Their agreed rate and old balance appear instantly — no loading.
3. Type the **quantity**. The total updates as you type.
4. Pick the **cap colour** (it remembers your last choice).
5. **Enter** → paid amount → **Enter**. Saved, and the slip is ready to print.
6. **Esc** clears the form at any point.

### Operator walkthrough — a walk-in sale

1. Open **Sell**, click **Local / walk-in**.
2. Tap a rate — ₹15, ₹20 or ₹25.
3. Type the quantity, **Enter**. Done — walk-ins always settle in full.

### Admin walkthrough — the morning routine

1. **Stock → Caps** → enter how many of each colour were taken out → **Issue**.
2. The counter sees the new numbers within ~5 seconds, no reload.
3. At end of day, **Stock → Caps → Today** shows issued, used and remaining.

### What the operator sees when things go wrong

| Situation | What happens |
|---|---|
| Internet drops | Amber **Offline** banner. Selling continues; sales queue locally. |
| Server restarts | Nothing visible. Queued sales sync when it returns. |
| Caps run out | Warning on screen. **The sale still goes through.** |
| Same sale submitted twice | Server returns the original. Customer billed once. |

---

## 4. Tech stack, and why

| Layer | Choice | Why this one |
|---|---|---|
| Runtime | **.NET 10 LTS**, ASP.NET Core Minimal APIs | Supported to Nov 2028. The domain is ~8 entities and ~40 operations — a layered enterprise architecture would be more code than the app itself. |
| Data access | **Dapper 2.1.79** | Boring and stable. No migration system of its own to maintain, no model-building cost at startup. |
| Database | **SQLite** (WAL mode) | One file. No server to install, patch, tune or back up separately. 112k rows is trivial for it. **This is the single biggest cut to ongoing maintenance.** |
| Migrations | Plain numbered `.sql` + checksum journal | Nothing to learn. Applied migrations are immutable — startup fails loudly if one is edited. |
| Auth | Cookie, hand-rolled (~120 lines) | Single origin, browser-only client. Cookies are revocable, need no refresh dance, and can't be read by page scripts. |
| Frontend | **React 19 + TypeScript + Vite** | — |
| Data fetching | **TanStack Query 5** | Earns its place for retry and background refresh. The POS deliberately does **not** use it. |
| Styling | **Tailwind 4** | Build-time only, zero runtime bytes. |
| Offline store | **Dexie 4** (IndexedDB) | Small, stable, well-maintained. |
| Charts | **Recharts 3**, code-split | 110 KB gzipped — loaded only by the Dashboard, never at the counter. |
| TLS | **Caddy** | One binary, auto-renewing certificates, ~3 lines of config. |

### Why money is an integer

Every amount is stored as **integer paise**, never `double`. The legacy schema
used MySQL `DOUBLE`, which cannot represent 0.01 exactly; the error accumulates
across 112,000 rows. Integer arithmetic is exact and removes the entire class of
defect.

### Why stock is a ledger

On-hand is `SUM(change_qty)` — there is no mutable counter to drift. The legacy
app kept a single `caps.bal_caps` column updated outside any transaction and
guarded by `bal_caps > 0`; once it went negative the guard silently stopped all
further decrements, and the production data still contains −9, −19, −49 and −83.

### Why resilience lives in the client

A sale is an append-only fact — it cannot conflict with another sale. So the
till completes one entirely locally and forwards it later. That single property
is what makes "never hangs" and "$7 a month" true at the same time: the server
can go down without stopping revenue, so it doesn't need redundancy.

### Deliberately **not** used

**Docker** (an image, a registry, a daemon to patch, for one process on one
box) · **nginx** (Caddy already terminates TLS) · **Redis** (the working set is
30 KB and it lives in the browser) · **a message queue** (the IndexedDB outbox
*is* the queue, on the right side of the network) · **EF Core** (a migration
system and startup cost, to save writing ~20 queries) · **JWT** · **a component
library** (~15 hand-built primitives, no upstream breaking changes) ·
**Kubernetes, load balancers, read replicas**.

---

## 5. Deployment

Target: **≈ $7/month** and **1–2 hours of maintenance per quarter**.

### Shared hosting will not work

Typical LAMP shared hosting cannot run ASP.NET Core. Windows shared hosting with
.NET support exists, but **don't** — those hosts recycle the app pool after ~20
minutes idle, so the first sale after a quiet spell eats a cold start. That is
precisely the hang this rewrite exists to eliminate.

### What to buy

| Item | Monthly |
|---|---|
| VPS, 1–2 vCPU / 2 GB, Mumbai or Bangalore | $5–6 |
| Backblaze B2 for backups | < $0.50 |
| Domain, amortised | ~$1 |
| TLS (Caddy / Let's Encrypt) | free |

Skip managed databases and read replicas. At ~240 writes a day, one box with
tested restores and an offline-capable client is the correct risk posture.

### Build

```bash
cd src/web && npm ci && npm run build
cd ../Waterhouse.Api
dotnet publish -c Release -r linux-x64 --self-contained true -o ../../publish
```

Self-contained means **no .NET runtime to install or patch on the server**.

### systemd — `/etc/systemd/system/waterhouse.service`

```ini
[Unit]
Description=Waterhouse POS
After=network.target

[Service]
Type=notify
User=waterhouse
WorkingDirectory=/opt/waterhouse
ExecStart=/opt/waterhouse/Waterhouse.Api
Restart=always
RestartSec=2

Environment=ASPNETCORE_ENVIRONMENT=Production
Environment=ASPNETCORE_URLS=http://127.0.0.1:5080
Environment=Database__Path=/var/lib/waterhouse/waterhouse.db
Environment=Business__TimeZone=+05:30

NoNewPrivileges=true
PrivateTmp=true
ProtectSystem=strict
ProtectHome=true
ReadWritePaths=/var/lib/waterhouse

[Install]
WantedBy=multi-user.target
```

`Restart=always` with no idle timeout is what guarantees no cold start.

### Caddy — `/etc/caddy/Caddyfile`

```
waterhouse.example.com {
    encode gzip zstd
    reverse_proxy 127.0.0.1:5080
}
```

That is the entire TLS story — certificates issue and renew automatically.

### Backups

Use **Litestream** for continuous replication with point-in-time recovery, or a
nightly `sqlite3 .backup` to object storage. Both are detailed in
[`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md).

**Test a restore once a quarter.** It is the one maintenance task that cannot be
automated away, and an untested backup is not a backup.

### Updating

```bash
rsync -a --delete publish/ user@server:/tmp/waterhouse-new/
ssh user@server 'sudo systemctl stop waterhouse \
  && sudo rsync -a --delete /tmp/waterhouse-new/ /opt/waterhouse/ \
  && sudo systemctl start waterhouse'
```

Migrations run automatically at startup inside a transaction and are
checksum-verified. Downtime is a couple of seconds — and because the till queues
locally, the counter doesn't notice.

---

## 6. Running locally

### One-time setup

Migrate the legacy data (needs no MySQL and no .NET SDK — it reads the dump
directly):

```powershell
cd "tools\import"; node import.mjs --dump "..\..\..\waterhouse\Sample DB\waterhouse25042020.sql" --out ..\..\data\waterhouse.db --force
```

Build the UI into the API's `wwwroot`:

```powershell
cd "src\web"; npm install; npm run build
```

### Run

```powershell
cd "src\Waterhouse.Api"; dotnet run
```

Open <http://localhost:5080>. In Development the seeded login is
**`admin` / `devpassword123`** (set in `appsettings.Development.json`).

You should see `Schema up to date: 0 migration(s) applied, 5 known` in the log.

### Working on the UI

Two terminals, with hot reload — use **:5173**:

```powershell
cd "src\Waterhouse.Api"; dotnet run
```

```powershell
cd "src\web"; npm run dev
```

### If the port is busy

```powershell
Get-NetTCPConnection -LocalPort 5080 -State Listen -ErrorAction SilentlyContinue | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }
```

The `-ErrorAction SilentlyContinue` matters — this cmdlet throws instead of
returning empty when nothing is found.

### Inspecting the database

A single SQLite file at `data\waterhouse.db`. **MySQL Workbench cannot open it**
— different format entirely.

| Tool | Notes |
|---|---|
| [DBeaver](https://dbeaver.io) | Opens SQLite *and* MySQL — useful for comparing against the legacy database |
| [DB Browser for SQLite](https://sqlitebrowser.org) | Free, closest in feel to Workbench |
| `sqlite3` CLI | Not bundled on Windows 10 — `winget install SQLite.SQLite` |

Reading while the app runs is safe (WAL mode). Stop it before writing. The
`-wal` and `-shm` files beside the database are normal, not separate databases.

---

## 7. Prerequisites

### To run it

| | Version | Notes |
|---|---|---|
| **.NET SDK** | 10.0+ | `winget install Microsoft.DotNet.SDK.10`. A new terminal is needed for PATH. |
| **Node.js** | 22+ | Only to build the UI and run the importer. Not needed at runtime. |

Nothing else. No MySQL, no Docker, no database server, no web server.

### To deploy it

A Linux VPS (1–2 vCPU, 2 GB), a domain, and an object-storage bucket for
backups. Caddy for TLS. **Not** shared hosting.

### What you do *not* need

MySQL · Docker · Redis · nginx · a CI/CD platform · a managed database

---

## 8. Summary

### The non-technical version

The plant used to run on software written in 2016 that nobody could safely
change any more. This replaces it.

**What it does.** Everything the old system did — selling water to customers,
tracking who owes money, recording expenses, printing bills — plus things it
couldn't: walk-in sales kept separate from account customers, cap stock by
colour, payment methods, and reports that actually reconcile.

**Why it is better.**

1. **It never makes anyone wait.** The old screen paused twice before the
   operator could even type a quantity. This one responds instantly because it
   already knows every customer, rate and balance before the customer walks up.
2. **It keeps working when the internet doesn't.** Sales are saved on the
   counter machine and sent later. A connection problem no longer stops trade.
3. **The numbers are right.** The old system stored money in a format that
   slowly accumulated rounding errors, and its cap count had been silently wrong
   for years. Both are fixed, and the migration was checked to the paisa.
4. **It costs about ₹600 a month to run** and needs a couple of hours of
   attention every three months.

**What it cost to get here.** The entire 112,000-sale history came across with
every total matching exactly — same cans, same rupees, same outstanding
balances.

### The technical version

A single ASP.NET Core process serves both a Minimal API and the React SPA from
the same origin — no CORS, no second deployment, no CDN. Data lives in one
SQLite file in WAL mode. Dapper for queries; no ORM.

The defining constraint is that the POS makes **no blocking network call**. One
`/api/bootstrap` call per shift (~15 KB gzipped, ~32 ms) carries the branch,
products, cap stock and every customer with their current balance. After that,
customer search, rate lookup, totals and the printed slip are all local and take
microseconds. Sales go to an IndexedDB outbox and sync in the background with a
client-generated UUID as an idempotency key, so retries cannot double-bill.

That outbox is why the architecture can be cheap: a sale is an append-only fact
that cannot conflict, so resilience lives in the client and the server stays one
$6 VPS with no redundancy.

Correctness is structural rather than conventional. Money is integer paise
everywhere. Stock is an append-only ledger, so on-hand cannot drift. Local
walk-in sales have `customer_id IS NULL` enforced by a CHECK constraint, making
it impossible to repeat the legacy habit of booking walk-ins onto real accounts.
Sales are voided, never deleted, and voiding reverses stock automatically.

Performance came from indexing rather than caching. The bootstrap balance query
went from **431 ms to 1.53 ms** with a covering partial index — covering so the
sum needs no table access, partial because only 11% of sales carry a balance. The
dashboard went from **469 ms to 27 ms** by pushing a date filter into a subquery
that was re-aggregating all 112k sale lines three times per load.

Extension is a vertical slice: implement `IEndpointModule`, drop the folder under
`Features/`, and it self-registers — `Program.cs` never changes. Schema changes
are new numbered `.sql` files; applied migrations are checksum-verified and
immutable, so an edited migration fails loudly at startup instead of silently
diverging between installs.

### Verification status

Built and exercised end to end against the migrated production data on
.NET SDK 10.0.400 / ASP.NET Core 10.0.11.

| | |
|---|---|
| Schema | 17 tables, 33 indexes, foreign keys enforced |
| Backend build | 0 warnings, 0 errors with `TreatWarningsAsErrors` + nullable |
| Data migration | 112,803 legacy sales — **all four totals reconcile exactly** |
| API integration suite | 20+ endpoints passing against the real database |
| POS bundle | 124 KB gzipped (legacy: ~1.5 MB of jQuery plugins) |

---

## Documentation

- [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — why it is shaped this way
- [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md) — the single-VPS setup in full
- [`docs/FREE-HOSTING.md`](docs/FREE-HOSTING.md) — standing up a free test instance
- [`docs/MIGRATION.md`](docs/MIGRATION.md) — what the import did to the legacy
  data, every anomaly it found, and the decisions still outstanding

## Known items

A README that only lists strengths is not much use to whoever picks this up
next. These three are the things that would otherwise surprise them — each is a
deliberate decision rather than an oversight, recorded here with the reasoning
and what to do about it.

### 1. Rotate the legacy credentials — do this first

The **old** Laravel repository has a live MySQL password and a Gmail app
password committed in `.env`, and they are in its git history. It also carries
21 MB of production SQL dumps containing real customer names and phone numbers.

Deleting the files is not enough — history keeps them. Rotate both secrets, and
treat the old repository as compromised regardless of what happens to this
rewrite.

This application stores no secrets in the repository: configuration comes from
environment variables, and `data/` and `*.db` are git-ignored.

### 2. Cap stock starts at zero, on purpose

No opening balance was invented, because there was no honest number to use.

Cap purchases were recorded in the legacy system until **January 2017**, while
can sales continued to **April 2020**. Built faithfully from every recorded
receipt and sale, the ledger lands at **−4,702,521 caps** — not a bug, but the
correct consequence of four years of unrecorded purchases. The old `bal_caps`
column hid this by refusing to decrement once negative, which is why it showed
−9, −19, −49 and −83.

**What to do:** do a physical count of each colour before go-live, then record
it under **Stock → Caps**. From that point the ledger cannot drift, because
on-hand is derived from movements rather than stored.

### 3. Nine legacy sales do not add up

Nine rows have `paid + balance ≠ total`. They were imported **exactly as
recorded**, not silently corrected.

Recomputing the balance would have invented a debt the business had treated as
settled, and that is not a decision an import script should make on its own.
Likewise the 3,728 negative balances are real overpayments and were kept as
credits, and the 755 zero-quantity rows — six of which carry ₹13,775 in debt
settlements — were preserved rather than dropped.

**What to do:** the nine rows are listed in `data/import-report.json`. Review
them and decide; the amounts are small, but they are the only figures in the
database that cannot be reconciled automatically.

See [`docs/MIGRATION.md`](docs/MIGRATION.md) for every anomaly found in the
legacy data and how each was handled.
