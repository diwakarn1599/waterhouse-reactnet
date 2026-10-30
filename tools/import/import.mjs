#!/usr/bin/env node
// =============================================================================
// Waterhouse - legacy MySQL dump -> SQLite importer
// =============================================================================
// Reads a mysqldump .sql file directly. No MySQL server and no .NET SDK needed.
//
//   node import.mjs --dump <file.sql> --out <target.db> [options]
//
// Options
//   --dump <path>          mysqldump file to read                     (required)
//   --out <path>           SQLite database to create                  (required)
//   --migrations <dir>     schema directory (default ../../src/Waterhouse.Api/Migrations)
//   --opening-stock CODE=N opening on-hand for a product, repeatable
//                          e.g. --opening-stock CAP=12000 --opening-stock BAG=40
//   --force                overwrite an existing --out file
//   --report <path>        write the reconciliation report as JSON
//
// -----------------------------------------------------------------------------
// DATA HANDLING RULES
// -----------------------------------------------------------------------------
// Financial amounts are NEVER silently altered. Where the legacy data is
// internally inconsistent it is imported exactly as recorded and counted in the
// report, so a human can decide. Only these derived/presentational fields are
// recomputed:
//
//   payment_status  Derived from the amounts. The legacy flag was assigned in
//                   browser JavaScript and contradicts the balance on 708 rows.
//
// Rows the legacy app allowed but the new CHECK constraints reject are handled
// explicitly rather than dropped:
//
//   total_cans = 0  Imported as a sale header with NO sale_line. Contributes
//                   zero to every total, so reports are unaffected, and the
//                   historical row is not lost. (755 rows)
//
//   date < 2000    Replaced with the DATE part of created_at, which is sane on
//                  every affected row. Original noted on the sale. (3 rows)
//
//   qty*rate != total  sale_line.amount_paise is set to the billed total so the
//                  header/line invariant holds. quantity and rate keep their
//                  recorded values. (5 rows)
//
//   duplicate code Second and later holders get a '-2', '-3' ... suffix. Legacy
//                  ids are preserved, so nothing else needs remapping. (6 rows)
//
// Stock is rebuilt as a true append-only ledger: every historical receipt is an
// inflow and every historical sale an outflow. For CAP this produces a large
// negative on-hand, which is the correct and honest result - cap purchases were
// only recorded until Jan 2017 while sales continued to 2020. A single explicit
// OPENING adjustment per product then brings on-hand to the figure you supply
// via --opening-stock (default 0), so the number going forward is real.
// =============================================================================

import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, unlinkSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { readTable } from './lib/mysqldump.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------- arg parsing
function parseArgs(argv) {
  const out = { openingStock: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`${a} requires a value`);
      return v;
    };
    switch (a) {
      case '--dump':           out.dump = next(); break;
      case '--out':            out.out = next(); break;
      case '--migrations':     out.migrations = next(); break;
      case '--report':         out.report = next(); break;
      case '--force':          out.force = true; break;
      case '--opening-stock': {
        const [code, qty] = next().split('=');
        if (!code || qty === undefined || Number.isNaN(Number(qty))) {
          throw new Error('--opening-stock expects CODE=NUMBER, e.g. CAP=12000');
        }
        out.openingStock[code.toUpperCase()] = Number(qty);
        break;
      }
      case '--help': case '-h': out.help = true; break;
      default: throw new Error(`unknown option: ${a}`);
    }
  }
  return out;
}

const USAGE = `
Waterhouse legacy importer

  node import.mjs --dump <file.sql> --out <target.db> [--force]
                  [--migrations <dir>] [--report <path>]
                  [--opening-stock CODE=N ...]
`;

// ------------------------------------------------------------------- helpers

/** Rupees (legacy DOUBLE) -> integer paise. */
const toPaise = (v) => {
  if (v === null || v === undefined || v === '') return 0;
  const n = typeof v === 'number' ? v : Number(v);
  if (Number.isNaN(n)) return 0;
  return Math.round(n * 100);
};

/** MySQL DATETIME 'YYYY-MM-DD HH:MM:SS' -> ISO-8601 UTC text. */
const toTimestamp = (v) => {
  if (!v) return '1970-01-01T00:00:00Z';
  const s = String(v).trim();
  if (s.startsWith('0000')) return '1970-01-01T00:00:00Z';
  return s.replace(' ', 'T').replace(/Z?$/, 'Z');
};

/** 'YYYY-MM-DD' (possibly a DATETIME) -> date only. */
const toDate = (v) => {
  if (!v) return null;
  const s = String(v).trim();
  if (s.startsWith('0000')) return null;
  return s.slice(0, 10);
};

const paymentStatus = (totalP, paidP, balP) => {
  if (balP <= 0) return 'PAID';
  if (paidP > 0) return 'PARTIAL';
  return 'UNPAID';
};

const fmtRs = (paise) =>
  (paise / 100).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/**
 * Must match Waterhouse.Api.Infrastructure.Db.Migrator.Checksum exactly, or the
 * API will report every migration as "modified since it was applied" and refuse
 * to start.
 *
 *   - CRLF normalised to LF, so a git checkout with different autocrlf settings
 *     does not change the hash
 *   - a UTF-8 BOM is stripped, because .NET's StreamReader strips it and
 *     Node's readFileSync does not
 *   - SHA-256, upper-case hex, matching Convert.ToHexString
 */
function migrationChecksum(text) {
  const withoutBom = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const normalised = withoutBom.split('\r\n').join('\n');
  return createHash('sha256').update(normalised, 'utf8').digest('hex').toUpperCase();
}

// ---------------------------------------------------------------------- main
function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.dump || !args.out) {
    console.log(USAGE);
    process.exit(args.help ? 0 : 1);
  }

  const dumpPath = resolve(args.dump);
  const outPath = resolve(args.out);
  const migrationsDir = resolve(args.migrations ?? join(HERE, '..', '..', 'src', 'Waterhouse.Api', 'Migrations'));

  if (!existsSync(dumpPath)) throw new Error(`dump not found: ${dumpPath}`);
  if (!existsSync(migrationsDir)) throw new Error(`migrations not found: ${migrationsDir}`);
  if (existsSync(outPath)) {
    if (!args.force) throw new Error(`${outPath} exists. Pass --force to overwrite.`);
    unlinkSync(outPath);
    for (const suffix of ['-wal', '-shm']) {
      if (existsSync(outPath + suffix)) unlinkSync(outPath + suffix);
    }
  }

  const report = {
    startedAt: new Date().toISOString(),
    source: dumpPath,
    target: outPath,
    counts: {},
    anomalies: {},
    reconciliation: {},
    notes: [],
  };

  console.log(`reading  ${dumpPath}`);
  // The legacy tables are latin1; reading as latin1 preserves every byte and
  // avoids the replacement characters a utf8 read would introduce.
  const dump = readFileSync(dumpPath, 'latin1');

  const src = {
    users:          readTable(dump, 'users'),
    customer:       readTable(dump, 'customer'),
    canentry:       readTable(dump, 'canentry'),
    expenses:       readTable(dump, 'expenses'),
    caps:           readTable(dump, 'caps'),
    waterbottlein:  readTable(dump, 'waterbottlein'),
    waterbottleout: readTable(dump, 'waterbottleout'),
    waterbagin:     readTable(dump, 'waterbagin'),
    waterbagout:    readTable(dump, 'waterbagout'),
  };
  for (const [k, v] of Object.entries(src)) console.log(`  ${k.padEnd(15)} ${v.length}`);

  // ------------------------------------------------------------ create target
  console.log(`\ncreating ${outPath}`);
  const db = new DatabaseSync(outPath);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');

  // The API's Migrator records every applied script in schema_journal and
  // refuses to re-run one. Applying the same scripts here WITHOUT journalling
  // them would leave the API trying to CREATE TABLE over an existing schema on
  // its first start. So this writes the journal exactly as the Migrator does -
  // same table, same script names, same checksum algorithm.
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_journal (
        script_name TEXT PRIMARY KEY,
        checksum    TEXT NOT NULL,
        applied_at  TEXT NOT NULL
    );`);

  const journal = db.prepare(
    'INSERT OR REPLACE INTO schema_journal (script_name, checksum, applied_at) VALUES (?, ?, ?)');
  const appliedAt = new Date().toISOString().replace(/\.\d+Z$/, 'Z');

  for (const f of readdirSync(migrationsDir).filter(f => f.endsWith('.sql')).sort()) {
    const sqlText = readFileSync(join(migrationsDir, f), 'utf8');
    db.exec(sqlText);
    journal.run(f, migrationChecksum(sqlText), appliedAt);
    console.log(`  applied ${f}`);
  }

  const productId = {};
  for (const p of db.prepare('SELECT id, code FROM product').all()) productId[p.code] = p.id;

  const NOW = new Date().toISOString().replace(/\.\d+Z$/, 'Z');

  db.exec('BEGIN');
  try {
    // ------------------------------------------------------------------ users
    // Legacy hashes are PHP bcrypt, which the API does not implement. Profiles
    // are imported with an empty hash: login is refused until an administrator
    // sets a password. Avoids taking a bcrypt dependency for two accounts.
    const insUser = db.prepare(`
      INSERT INTO app_user (id, username, display_name, email, password_hash, role, is_active, created_at, updated_at)
      VALUES (?, ?, ?, ?, '', ?, 1, ?, ?)`);
    const usedUsernames = new Set();
    for (const u of src.users) {
      let username = String(u.email || '').split('@')[0].toLowerCase().replace(/[^a-z0-9._-]/g, '') ||
                     `user${u.id}`;
      let candidate = username, n = 2;
      while (usedUsernames.has(candidate)) candidate = `${username}${n++}`;
      usedUsernames.add(candidate);
      insUser.run(
        u.id, candidate, String(u.name || candidate), String(u.email || ''),
        u.role === 'admin' ? 'admin' : 'operator',
        toTimestamp(u.created_at), toTimestamp(u.updated_at)
      );
    }
    report.counts.users = src.users.length;
    report.notes.push('Imported users have no password. An administrator must set one before they can sign in.');

    const userIds = new Set(src.users.map(u => u.id));
    const userRef = (id) => (userIds.has(id) ? id : null);

    // -------------------------------------------------------------- customers
    const insCust = db.prepare(`
      INSERT INTO customer (id, code, name, company_name, phone, address, note, is_active, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, '', ?, ?, ?, ?, ?)`);
    const seenCode = new Map();
    let dupCodes = 0;
    for (const c of src.customer) {
      const original = String(c.cust_id || '').trim() || `CUST-${String(c.id).padStart(4, '0')}`;
      let code = original;
      let note = '';
      if (seenCode.has(original)) {
        const n = seenCode.get(original) + 1;
        seenCode.set(original, n);
        code = `${original}-${n}`;
        note = `legacy code '${original}' was duplicated; suffixed on import`;
        dupCodes++;
      } else {
        seenCode.set(original, 1);
      }
      insCust.run(
        c.id, code, String(c.name || '').trim() || `(unnamed ${c.id})`,
        String(c.comp_name || ''), String(c.phone || ''),
        note,
        c.status === 0 ? 0 : 1,
        userRef(c.created_by),
        toTimestamp(c.created_at), toTimestamp(c.updated_at)
      );
    }
    report.counts.customers = src.customer.length;
    report.anomalies.duplicateCustomerCodes = dupCodes;

    // --------------------------------------------------------- sales importer
    const insSale = db.prepare(`
      INSERT INTO sale (id, invoice_no, sale_date, customer_id, total_amount_paise, paid_amount_paise,
                        balance_amount_paise, payment_status, note, client_uuid, is_void,
                        created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 0, ?, ?, ?)`);
    const insLine = db.prepare(`
      INSERT INTO sale_line (sale_id, product_id, quantity, rate_paise, amount_paise)
      VALUES (?, ?, ?, ?, ?)`);
    const insLedger = db.prepare(`
      INSERT INTO stock_ledger (product_id, entry_date, change_qty, ref_type, ref_id, note, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);

    // Legacy sale ids collide across the three source tables, so each table gets
    // its own id range. Cans keep their original ids (and therefore their
    // original WC- invoice numbers); the far smaller bottle and bag tables are
    // offset above them.
    const anomalies = { zeroQty: 0, badDate: 0, mathMismatch: 0, paidBalMismatch: 0, statusRederived: 0, negativeBalance: 0 };
    const totals = { cans: 0, totalP: 0, paidP: 0, balP: 0 };

    function importSales(rows, cfg) {
      for (const r of rows) {
        const id = r.id + cfg.idOffset;
        const qty = Number(r[cfg.qtyField]) || 0;
        const totalP = toPaise(r.total_amount);
        const paidP = toPaise(r.paid_amount);
        const balP = toPaise(r.bal_amount);

        let date = toDate(r[cfg.dateField]);
        let note = '';
        if (!date || date < '2000-01-01') {
          const fallback = toDate(r.created_at);
          note = `legacy sale_date was ${date ?? 'NULL'}; replaced with created_at`;
          date = fallback && fallback >= '2000-01-01' ? fallback : '2000-01-01';
          anomalies.badDate++;
        }

        const ratePContract = toPaise(r[cfg.rateField] ?? 0);
        const ratePaise = cfg.rateField && r[cfg.rateField] != null
          ? ratePContract
          : (qty > 0 ? Math.round(totalP / qty) : 0);

        if (qty > 0 && ratePaise * qty !== totalP) anomalies.mathMismatch++;
        if (paidP + balP !== totalP) anomalies.paidBalMismatch++;
        if (balP < 0) anomalies.negativeBalance++;

        const status = paymentStatus(totalP, paidP, balP);
        const legacyStatus = r.payment_status === 1 ? 'PAID' : (paidP > 0 ? 'PARTIAL' : 'UNPAID');
        if (status !== legacyStatus) anomalies.statusRederived++;

        insSale.run(
          id, `${cfg.invoicePrefix}${String(r.id).padStart(8, '0')}`, date, r.customer_id,
          totalP, paidP, balP, status, note,
          userRef(r.created_by), toTimestamp(r.created_at), toTimestamp(r.updated_at)
        );

        if (qty > 0) {
          // amount_paise carries the billed total so header and lines always
          // agree, even on the 5 rows where qty*rate never matched.
          insLine.run(id, cfg.productId, qty, ratePaise, totalP);
          if (cfg.stockProductId !== null) {
            insLedger.run(cfg.stockProductId, date, -qty * cfg.consumeQty, 'SALE', id, '', userRef(r.created_by), toTimestamp(r.created_at));
          }
        } else {
          anomalies.zeroQty++;
        }

        if (cfg.countTotals) {
          totals.cans += qty;
          totals.totalP += totalP;
          totals.paidP += paidP;
          totals.balP += balP;
        }
      }
    }

    importSales(src.canentry, {
      idOffset: 0, qtyField: 'total_cans', dateField: 'date', rateField: 'per_canrate',
      productId: productId.CAN, stockProductId: productId.CAP, consumeQty: 1,
      invoicePrefix: 'WC-', countTotals: true,
    });

    const BOTTLE_OFFSET = 800_000_000;
    const BAG_OFFSET = 900_000_000;
    importSales(src.waterbottleout, {
      idOffset: BOTTLE_OFFSET, qtyField: 'total_bottles', dateField: 'outdate', rateField: null,
      productId: productId.BOTTLE, stockProductId: productId.BOTTLE, consumeQty: 1,
      invoicePrefix: 'WB-', countTotals: false,
    });
    importSales(src.waterbagout, {
      idOffset: BAG_OFFSET, qtyField: 'total_bags', dateField: 'outdate', rateField: null,
      productId: productId.BAG, stockProductId: productId.BAG, consumeQty: 1,
      invoicePrefix: 'WG-', countTotals: false,
    });

    report.counts.sales = src.canentry.length + src.waterbottleout.length + src.waterbagout.length;
    report.anomalies = { ...report.anomalies, ...anomalies };

    // ------------------------------------------------- per-customer can rates
    // Only 2 of 400 customers had canrate populated, so the legacy column is
    // unusable as a source. Each customer's default rate is derived from the
    // rate on their most recent can sale, which is real observed data.
    const latestRate = new Map();
    for (const r of src.canentry) {
      const d = toDate(r.date) ?? '';
      const prev = latestRate.get(r.customer_id);
      const rate = toPaise(r.per_canrate);
      if (rate > 0 && (!prev || d >= prev.d)) latestRate.set(r.customer_id, { d, rate });
    }
    const insRate = db.prepare(`
      INSERT OR REPLACE INTO customer_product_rate (customer_id, product_id, rate_paise, updated_at)
      VALUES (?, ?, ?, ?)`);
    let ratesFromHistory = 0, ratesFromColumn = 0;
    for (const c of src.customer) {
      const declared = toPaise(c.canrate);
      if (declared > 0) { insRate.run(c.id, productId.CAN, declared, NOW); ratesFromColumn++; continue; }
      const hist = latestRate.get(c.id);
      if (hist) { insRate.run(c.id, productId.CAN, hist.rate, NOW); ratesFromHistory++; }
    }
    report.counts.customerRates = ratesFromColumn + ratesFromHistory;
    report.notes.push(`Can rates: ${ratesFromColumn} from customer.canrate, ${ratesFromHistory} derived from the customer's most recent sale.`);

    // --------------------------------------------------------------- expenses
    const insExp = db.prepare(`
      INSERT INTO expense (id, expense_date, category_id, description, amount_paise, note, created_by, created_at, updated_at)
      VALUES (?, ?, NULL, ?, ?, '', NULL, ?, ?)`);
    let expenseP = 0, expBadDate = 0;
    for (const e of src.expenses) {
      let d = toDate(e.exp_date);
      if (!d || d < '2000-01-01') { d = toDate(e.created_at) ?? '2000-01-01'; expBadDate++; }
      const amt = toPaise(e.amount);
      insExp.run(e.id, d, String(e.exp_name || '').trim() || '(no description)', amt,
                 toTimestamp(e.created_at), toTimestamp(e.updated_at));
      expenseP += amt;
    }
    report.counts.expenses = src.expenses.length;
    report.anomalies.expenseBadDate = expBadDate;

    // ------------------------------------------------------- stock receipts
    const insReceipt = db.prepare(`
      INSERT INTO stock_receipt (product_id, receipt_date, quantity, amount_paise, note, created_by, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, NULL, ?, ?)`);

    function importReceipts(rows, pid, qtyField, dateField, label) {
      let count = 0;
      for (const r of rows) {
        const qty = Number(r[qtyField]) || 0;
        if (qty <= 0) continue;
        let d = toDate(r[dateField]);
        if (!d || d < '2000-01-01') d = toDate(r.created_at) ?? '2000-01-01';
        const amount = toPaise(r.amount);
        const ts = toTimestamp(r.created_at);
        insReceipt.run(pid, d, qty, amount, `imported from ${label}`, ts, toTimestamp(r.updated_at));
        const rid = db.prepare('SELECT last_insert_rowid() AS id').get().id;
        insLedger.run(pid, d, qty, 'RECEIPT', rid, '', null, ts);
        count++;
      }
      return count;
    }

    report.counts.stockReceipts =
      importReceipts(src.caps, productId.CAP, 'caps_count', 'added_date', 'caps') +
      importReceipts(src.waterbottlein, productId.BOTTLE, 'totbottles', 'indate', 'waterbottlein') +
      importReceipts(src.waterbagin, productId.BAG, 'totbags', 'indate', 'waterbagin');

    // ------------------------------------------- opening stock reconciliation
    // Historical inflows and outflows are now both in the ledger. For CAP the
    // result is heavily negative because purchases stopped being recorded in
    // Jan 2017 while sales ran to 2020. One explicit adjustment per product
    // brings on-hand to the supplied figure and leaves an auditable trail.
    const stockProducts = db.prepare('SELECT id, code FROM product WHERE tracks_stock = 1 ORDER BY code').all();
    report.reconciliation.stock = [];
    for (const p of stockProducts) {
      const computed = db.prepare('SELECT COALESCE(SUM(change_qty),0) AS q FROM stock_ledger WHERE product_id = ?').get(p.id).q;
      const target = args.openingStock[p.code] ?? 0;
      const delta = target - computed;
      if (delta !== 0) {
        insLedger.run(p.id, NOW.slice(0, 10), delta, 'OPENING',
          null, `migration reconciliation: historical ledger ${computed} -> opening ${target}`, null, NOW);
      }
      report.reconciliation.stock.push({ code: p.code, historicalLedger: computed, openingSet: target, adjustment: delta });
    }

    // ----------------------------------------------------- number sequences
    // Advance past the highest imported number so new documents cannot collide.
    const maxCan = src.canentry.reduce((m, r) => Math.max(m, r.id), 0);
    const maxCustNum = src.customer.reduce((m, c) => {
      const n = parseInt(String(c.cust_id || '').replace(/\D/g, ''), 10);
      return Number.isNaN(n) ? m : Math.max(m, n);
    }, 0);
    db.prepare('UPDATE number_sequence SET next_value = ?, updated_at = ? WHERE name = ?').run(maxCan + 1, NOW, 'sale');
    db.prepare('UPDATE number_sequence SET next_value = ?, updated_at = ? WHERE name = ?').run(maxCustNum + 1, NOW, 'customer');
    report.reconciliation.sequences = { sale: maxCan + 1, customer: maxCustNum + 1 };

    // ------------------------------------------------------------ branch name
    db.prepare('UPDATE branch SET name = ?, updated_at = ? WHERE id = 1').run('Royal Aqua Products', NOW);

    db.exec('COMMIT');

    // ------------------------------------------------------- reconciliation
    // Money is summed from `sale`, NOT through a join to `sale_line`: 755 legacy
    // rows have no line because they recorded zero cans, and 6 of those still
    // carry money - they are debt settlements the operator entered as a 0-can
    // sale. Joining through sale_line would silently drop them.
    const canMoney = db.prepare(`
      SELECT COALESCE(SUM(total_amount_paise),0)   AS total,
             COALESCE(SUM(paid_amount_paise),0)    AS paid,
             COALESCE(SUM(balance_amount_paise),0) AS bal
        FROM sale
       WHERE invoice_no LIKE 'WC-%' AND is_void = 0`).get();
    const canQty = db.prepare(`
      SELECT COALESCE(SUM(l.quantity),0) AS cans
        FROM sale s JOIN sale_line l ON l.sale_id = s.id
       WHERE l.product_id = ? AND s.is_void = 0`).get(productId.CAN);
    const canSales = { cans: canQty.cans, ...canMoney };

    const settlements = db.prepare(`
      SELECT COUNT(*) AS n, COALESCE(SUM(paid_amount_paise),0) AS paid
        FROM sale s
       WHERE s.invoice_no LIKE 'WC-%' AND s.is_void = 0
         AND s.paid_amount_paise > 0
         AND NOT EXISTS (SELECT 1 FROM sale_line l WHERE l.sale_id = s.id)`).get();
    report.anomalies.paymentOnlyEntries = settlements.n;
    if (settlements.n > 0) {
      report.notes.push(
        `${settlements.n} legacy rows recorded a payment of ${fmtRs(settlements.paid)} against zero cans - ` +
        `debt settlements entered through the sale screen. Imported as line-less sales so balances stay correct. ` +
        `Going forward the Payments screen records these properly.`);
    }

    report.reconciliation.cans = {
      legacyFloatSum: { cans: totals.cans, total: totals.totalP, paid: totals.paidP, balance: totals.balP },
      imported: { cans: canSales.cans, total: canSales.total, paid: canSales.paid, balance: canSales.bal },
      matches: totals.cans === canSales.cans && totals.totalP === canSales.total &&
               totals.paidP === canSales.paid && totals.balP === canSales.bal,
    };
    report.reconciliation.expensesPaise = expenseP;
    report.finishedAt = new Date().toISOString();

    db.exec('PRAGMA foreign_key_check;');
    db.exec('VACUUM;');
    db.exec('PRAGMA optimize;');

    // ------------------------------------------------------------------ print
    console.log('\n--- imported -------------------------------------------------');
    for (const [k, v] of Object.entries(report.counts)) console.log(`  ${k.padEnd(18)} ${v}`);

    console.log('\n--- anomalies handled ----------------------------------------');
    for (const [k, v] of Object.entries(report.anomalies)) if (v) console.log(`  ${k.padEnd(24)} ${v}`);

    console.log('\n--- can sales reconciliation ---------------------------------');
    const rc = report.reconciliation.cans;
    console.log(`  cans      legacy ${rc.legacyFloatSum.cans}   imported ${rc.imported.cans}`);
    console.log(`  total     legacy ${fmtRs(rc.legacyFloatSum.total)}   imported ${fmtRs(rc.imported.total)}`);
    console.log(`  paid      legacy ${fmtRs(rc.legacyFloatSum.paid)}   imported ${fmtRs(rc.imported.paid)}`);
    console.log(`  balance   legacy ${fmtRs(rc.legacyFloatSum.balance)}   imported ${fmtRs(rc.imported.balance)}`);
    console.log(`  ${rc.matches ? 'EXACT MATCH' : '*** MISMATCH ***'}`);
    console.log(`  expenses  ${fmtRs(expenseP)}`);

    console.log('\n--- stock ----------------------------------------------------');
    for (const s of report.reconciliation.stock) {
      console.log(`  ${s.code.padEnd(8)} historical ledger ${String(s.historicalLedger).padStart(10)}  ` +
                  `opening set to ${String(s.openingSet).padStart(8)}  (adjustment ${s.adjustment >= 0 ? '+' : ''}${s.adjustment})`);
    }

    console.log('\n--- notes ----------------------------------------------------');
    for (const n of report.notes) console.log(`  - ${n}`);

    if (args.report) {
      writeFileSync(resolve(args.report), JSON.stringify(report, null, 2));
      console.log(`\nreport written to ${resolve(args.report)}`);
    }
    console.log(`\ndone -> ${outPath}`);
    if (!rc.matches) process.exitCode = 2;
  } catch (err) {
    try { db.exec('ROLLBACK'); } catch { /* transaction already closed */ }
    throw err;
  } finally {
    db.close();
  }
}

try {
  main();
} catch (err) {
  console.error(`\nimport failed: ${err.message}`);
  if (process.env.DEBUG) console.error(err.stack);
  process.exit(1);
}
