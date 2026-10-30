import Dexie, { type EntityTable } from 'dexie';
import { api, ApiError } from '../api/client';
import type { BootstrapData, CreateSaleRequest, CreateSaleResponse, Receipt } from '../api/types';

/**
 * Local durable store behind the till.
 *
 * The POS never waits on the network to complete a sale. A sale is written here
 * first, the receipt prints immediately, and a background worker forwards it.
 * If the server or the connection is down the counter keeps selling and the
 * queue drains later.
 *
 * Safe because a sale is an append-only fact that cannot conflict with another
 * sale, and because every queued item carries a clientUuid the server treats as
 * an idempotency key - a retry after a lost response can never double-bill.
 */

export interface OutboxEntry {
  /** Client-generated UUID, and the server's idempotency key. */
  clientUuid: string;
  request: CreateSaleRequest;
  /** Receipt shown to the operator, held until the server confirms. */
  receipt: Receipt;
  queuedAt: string;
  attempts: number;
  lastError?: string;
}

export interface SnapshotEntry {
  key: 'bootstrap';
  data: BootstrapData;
  fetchedAt: string;
}

const db = new Dexie('waterhouse') as Dexie & {
  outbox: EntityTable<OutboxEntry, 'clientUuid'>;
  receipts: EntityTable<Receipt, 'invoiceNo'>;
  snapshot: EntityTable<SnapshotEntry, 'key'>;
};

db.version(1).stores({
  outbox: 'clientUuid, queuedAt',
  receipts: 'invoiceNo, createdAt',
  snapshot: 'key',
});

// --------------------------------------------------------------------- reads

export async function loadSnapshot(): Promise<BootstrapData | undefined> {
  const row = await db.snapshot.get('bootstrap');
  return row?.data;
}

export async function saveSnapshot(data: BootstrapData): Promise<void> {
  await db.snapshot.put({ key: 'bootstrap', data, fetchedAt: new Date().toISOString() });
}

export async function pendingEntries(): Promise<OutboxEntry[]> {
  return db.outbox.orderBy('queuedAt').toArray();
}

export async function pendingCount(): Promise<number> {
  return db.outbox.count();
}

export async function recentReceipts(limit = 25): Promise<Receipt[]> {
  return db.receipts.orderBy('createdAt').reverse().limit(limit).toArray();
}

/**
 * Net balance change per customer still sitting in the outbox.
 *
 * The cached snapshot holds balances as of the last successful fetch. Applying
 * these deltas keeps the figure the operator sees correct while offline, so a
 * customer buying twice in a row sees their balance move both times.
 */
export async function pendingBalanceDeltas(): Promise<Map<number, number>> {
  const deltas = new Map<number, number>();
  for (const entry of await db.outbox.toArray()) {
    // A local walk-in has no customer and always settles in full, so it moves
    // no balance and must not be attributed to anyone.
    const customerId = entry.request.customerId;
    if (entry.request.isLocal || customerId === null) continue;

    const total = entry.request.lines.reduce((sum, line) => sum + line.quantity * line.rate, 0);
    const delta = total - entry.request.paidAmount;
    deltas.set(customerId, (deltas.get(customerId) ?? 0) + delta);
  }
  return deltas;
}

// -------------------------------------------------------------------- writes

export async function enqueueSale(request: CreateSaleRequest, receipt: Receipt): Promise<void> {
  await db.transaction('rw', db.outbox, db.receipts, async () => {
    await db.outbox.put({
      clientUuid: request.clientUuid,
      request,
      receipt,
      queuedAt: new Date().toISOString(),
      attempts: 0,
    });
    await db.receipts.put(receipt);
  });
}

/**
 * Caps already committed to by queued sales, per cap product.
 *
 * The cached snapshot holds on-hand as of the last successful fetch. Subtracting
 * these keeps the remaining count the operator sees honest while sales are still
 * waiting to sync - otherwise a till working offline would show the morning's
 * opening figure all day.
 */
export async function pendingCapUsage(): Promise<Map<number, number>> {
  const usage = new Map<number, number>();
  for (const entry of await db.outbox.toArray()) {
    for (const line of entry.request.lines) {
      if (!line.capProductId) continue;
      usage.set(line.capProductId, (usage.get(line.capProductId) ?? 0) + line.quantity);
    }
  }
  return usage;
}

/** Keep the receipt log from growing without bound on a long-lived till. */
export async function pruneReceipts(keep = 500): Promise<void> {
  const total = await db.receipts.count();
  if (total <= keep) return;
  const stale = await db.receipts.orderBy('createdAt').limit(total - keep).primaryKeys();
  await db.receipts.bulkDelete(stale);
}

// --------------------------------------------------------------------- flush

export interface FlushResult {
  attempted: number;
  accepted: number;
  failed: number;
  offline: boolean;
}

let flushing = false;

/**
 * Push queued sales to the server.
 *
 * Never throws: a flush failure must not surface as an error at the counter,
 * because the sale is already safely recorded locally. Entries stay queued and
 * the next flush retries them.
 */
export async function flushOutbox(): Promise<FlushResult> {
  if (flushing) return { attempted: 0, accepted: 0, failed: 0, offline: false };
  flushing = true;
  try {
    const entries = await pendingEntries();
    if (entries.length === 0) return { attempted: 0, accepted: 0, failed: 0, offline: false };

    // Cap the batch so a long offline stretch flushes in steady chunks rather
    // than one request large enough to time out.
    const batch = entries.slice(0, 100);

    let response: { accepted: number; failed: number; results: BatchItemResult[] };
    try {
      response = await api.post('/api/sales/batch', batch.map((entry) => entry.request));
    } catch (error) {
      if (error instanceof ApiError && error.isOffline) {
        return { attempted: batch.length, accepted: 0, failed: 0, offline: true };
      }
      await recordAttempt(batch, error instanceof Error ? error.message : 'Unknown error');
      return { attempted: batch.length, accepted: 0, failed: batch.length, offline: false };
    }

    const succeeded: string[] = [];
    const failures: Array<{ clientUuid: string; error: string }> = [];

    for (const result of response.results) {
      if (result.ok) {
        succeeded.push(result.clientUuid);
        if (result.sale) await confirmReceipt(result.clientUuid, result.sale);
      } else {
        failures.push({ clientUuid: result.clientUuid, error: result.error ?? 'Rejected' });
      }
    }

    if (succeeded.length > 0) await db.outbox.bulkDelete(succeeded);
    for (const failure of failures) {
      const entry = await db.outbox.get(failure.clientUuid);
      if (entry) {
        await db.outbox.put({ ...entry, attempts: entry.attempts + 1, lastError: failure.error });
      }
    }

    return {
      attempted: batch.length,
      accepted: succeeded.length,
      failed: failures.length,
      offline: false,
    };
  } finally {
    flushing = false;
  }
}

interface BatchItemResult {
  clientUuid: string;
  ok: boolean;
  error?: string;
  sale?: CreateSaleResponse;
}

async function recordAttempt(entries: OutboxEntry[], message: string): Promise<void> {
  await db.transaction('rw', db.outbox, async () => {
    for (const entry of entries) {
      await db.outbox.put({ ...entry, attempts: entry.attempts + 1, lastError: message });
    }
  });
}

/**
 * Replace the provisional local invoice number with the authoritative one the
 * server allocated, so a reprint matches the books.
 */
async function confirmReceipt(clientUuid: string, sale: CreateSaleResponse): Promise<void> {
  const entry = await db.outbox.get(clientUuid);
  if (!entry) return;
  await db.transaction('rw', db.receipts, async () => {
    await db.receipts.delete(entry.receipt.invoiceNo);
    await db.receipts.put({ ...entry.receipt, invoiceNo: sale.invoiceNo, synced: true });
  });
}

/**
 * Start background syncing: on regaining connectivity, on tab focus, and on a
 * slow timer as a backstop for a connection that never fires an online event.
 */
export function startOutboxSync(onChange: (result: FlushResult) => void | Promise<void>): () => void {
  let timer: number | undefined;

  const run = () => {
    void flushOutbox().then((result) => {
      // Awaited so a caller that needs to reload state before releasing its
      // local deductions can do so without a gap. Errors are swallowed: a
      // failed refresh must never surface at the counter.
      if (result.attempted > 0) return Promise.resolve(onChange(result)).catch(() => undefined);
      return undefined;
    });
  };

  const onOnline = () => run();
  const onFocus = () => run();

  window.addEventListener('online', onOnline);
  window.addEventListener('focus', onFocus);
  timer = window.setInterval(run, 30_000);
  run();

  return () => {
    window.removeEventListener('online', onOnline);
    window.removeEventListener('focus', onFocus);
    if (timer !== undefined) window.clearInterval(timer);
  };
}

/** Provisional invoice number shown until the server assigns the real one. */
export function provisionalInvoiceNo(clientUuid: string): string {
  return `LOCAL-${clientUuid.slice(0, 8).toUpperCase()}`;
}

export { db as localDb };
