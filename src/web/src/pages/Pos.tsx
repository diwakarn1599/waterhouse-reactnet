import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSession } from '../state/session';
import { enqueueSale, flushOutbox, provisionalInvoiceNo, pruneReceipts } from '../db/outbox';
import type { CreateSaleRequest, Customer, PaymentMethod, Receipt } from '../api/types';
import { paymentMethods } from '../api/types';
import { Alert, Badge, Button, Card, Field, Input } from '../components/ui';
import { ReceiptView } from '../components/ReceiptView';
import { count, rupees, todayIso } from '../format';

type Mode = 'registered' | 'local';

/**
 * Says plainly where the cap number came from, so it is never ambiguous.
 *
 * Three states the operator actually cares about: confirmed with the server and
 * when, confirmed but with sales still queued on top, or not reachable at all.
 */
function CapFreshness({ asOf, online, queued }: { asOf: number | null; online: boolean; queued: number }) {
  const [, tick] = useState(0);

  // Re-render each second so "4s ago" does not sit frozen on screen.
  useEffect(() => {
    const timer = window.setInterval(() => tick((n) => n + 1), 1000);
    return () => window.clearInterval(timer);
  }, []);

  if (!online) {
    return (
      <span className="font-medium text-amber-700">
        Offline — count includes {queued} unsynced sale{queued === 1 ? '' : 's'} on this device.
      </span>
    );
  }
  if (asOf === null) return <span>Checking with the server…</span>;

  const seconds = Math.max(0, Math.round((Date.now() - asOf) / 1000));
  const ago = seconds < 5 ? 'just now' : seconds < 60 ? `${seconds}s ago` : `${Math.floor(seconds / 60)}m ago`;

  return (
    <span>
      Confirmed with server {ago}, rechecked every 15s.
      {queued > 0 && <> {queued} queued sale{queued === 1 ? '' : 's'} already deducted.</>}
    </span>
  );
}

/**
 * The counter screen.
 *
 * Design rule: completing a sale makes NO blocking network call. Customers,
 * rates and balances all arrived in the bootstrap payload, so selection, totals
 * and the receipt are computed locally in microseconds. The sale is written to
 * IndexedDB, printed, and forwarded in the background.
 *
 * Two entry modes:
 *
 *   Registered - search a customer, their agreed rate and outstanding balance
 *                are already loaded, and the bill may be part-paid on account.
 *
 *   Local      - walk-in trade with no customer at all. One tap on a rate, a
 *                quantity, done. Always settled in full, because there is no
 *                account to bill later.
 *
 * The local mode deliberately does NOT create or select a customer record. The
 * legacy system had no such concept, so operators booked walk-ins against a few
 * real customer accounts; those accounts accumulated meaningless balances and
 * every report had to exclude them by hard-coded id.
 */
export function PosPage() {
  const { data, customers, caps, capsAsOf, capsRefreshing, refreshCaps, applyLocalSale, online, queued } =
    useSession();

  const [mode, setMode] = useState<Mode>('registered');
  const [search, setSearch] = useState('');
  const [highlight, setHighlight] = useState(0);
  const [selected, setSelected] = useState<Customer | null>(null);
  const [quantity, setQuantity] = useState('');
  const [rate, setRate] = useState('');
  const [paid, setPaid] = useState('');
  const [method, setMethod] = useState<PaymentMethod>('CASH');
  // Sticky across sales: the counter usually works through one colour at a
  // time, so re-picking it on every sale would be pure friction.
  const [capProductId, setCapProductId] = useState<number | null>(null);
  const [note, setNote] = useState('');
  const [receipt, setReceipt] = useState<Receipt | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const searchRef = useRef<HTMLInputElement>(null);
  const quantityRef = useRef<HTMLInputElement>(null);
  const paidRef = useRef<HTMLInputElement>(null);

  const sellable = useMemo(() => (data?.products ?? []).filter((p) => p.isSellable), [data]);
  const [productId, setProductId] = useState<number | null>(null);
  const product = useMemo(
    () => sellable.find((p) => p.id === productId) ?? sellable[0] ?? null,
    [sellable, productId],
  );

  useEffect(() => {
    if (productId === null && sellable.length > 0) setProductId(sellable[0]!.id);
  }, [sellable, productId]);

  // Rates the counter actually uses, computed server-side from sales history.
  const quickRates = useMemo(
    () => (product && data ? data.quickRates[String(product.id)] ?? [] : []),
    [product, data],
  );

  const selectedCap = useMemo(
    () => caps.find((c) => c.id === capProductId) ?? null,
    [caps, capProductId],
  );

  // Default to the first colour that still has stock, so a fresh till is ready
  // to sell without touching the cap row at all.
  useEffect(() => {
    if (capProductId === null && caps.length > 0) {
      setCapProductId((caps.find((c) => c.onHand > 0) ?? caps[0]!).id);
    }
  }, [caps, capProductId]);

  const isLocal = mode === 'local';

  const focusEntry = useCallback(() => {
    window.setTimeout(() => quantityRef.current?.focus(), 0);
  }, []);

  // Switching mode resets the form and puts the cursor where entry starts.
  const switchMode = useCallback(
    (next: Mode) => {
      setMode(next);
      setSelected(null);
      setSearch('');
      setQuantity('');
      setPaid('');
      setNote('');
      setError(null);
      if (next === 'local') {
        setRate(String(quickRates[0] ?? product?.defaultRate ?? ''));
        focusEntry();
      } else {
        setRate('');
        window.setTimeout(() => searchRef.current?.focus(), 0);
      }
    },
    [quickRates, product, focusEntry],
  );

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  // ---- customer search, entirely local -------------------------------------
  const matches = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return [];
    return customers
      .filter(
        (c) =>
          c.name.toLowerCase().includes(term) ||
          c.code.toLowerCase().includes(term) ||
          c.phone.includes(term) ||
          c.companyName.toLowerCase().includes(term),
      )
      .slice(0, 8);
  }, [customers, search]);

  useEffect(() => setHighlight(0), [search]);

  const chooseCustomer = useCallback(
    (customer: Customer) => {
      setSelected(customer);
      setSearch('');
      const agreed = product ? customer.rates[String(product.id)] : undefined;
      setRate(String(agreed ?? product?.defaultRate ?? 0));
      setQuantity('');
      setPaid('');
      setError(null);
      focusEntry();
    },
    [product, focusEntry],
  );

  // ---- totals, computed locally on every keystroke -------------------------
  const quantityValue = Number(quantity) || 0;
  const rateValue = Number(rate) || 0;
  const total = Math.round(quantityValue * rateValue * 100) / 100;
  // A walk-in always settles in full: there is no account to carry a balance.
  const paidValue = isLocal ? total : paid === '' ? total : Number(paid) || 0;
  const balance = Math.round((total - paidValue) * 100) / 100;
  const previousBalance = selected?.balance ?? 0;

  const readyToSell = isLocal ? quantityValue > 0 && rateValue > 0 : selected !== null;

  const reset = useCallback(() => {
    setQuantity('');
    setPaid('');
    setNote('');
    setError(null);
    if (isLocal) {
      setRate(String(quickRates[0] ?? product?.defaultRate ?? ''));
      focusEntry();
    } else {
      setSelected(null);
      setRate('');
      setSearch('');
      window.setTimeout(() => searchRef.current?.focus(), 0);
    }
  }, [isLocal, quickRates, product, focusEntry]);

  const submit = useCallback(async () => {
    if (!product) return;
    if (!isLocal && !selected) {
      setError('Select a customer, or switch to Local.');
      return;
    }
    if (quantityValue <= 0) {
      setError('Enter a quantity greater than zero.');
      quantityRef.current?.focus();
      return;
    }
    if (rateValue <= 0) {
      setError('Enter a rate greater than zero.');
      return;
    }
    if (paidValue < 0) {
      setError('Paid amount cannot be negative.');
      return;
    }

    setSaving(true);
    setError(null);
    try {
      const clientUuid = crypto.randomUUID();
      const saleDate = data?.today ?? todayIso();

      const request: CreateSaleRequest = {
        clientUuid,
        saleDate,
        customerId: isLocal ? null : selected!.id,
        isLocal,
        lines: [{
          productId: product.id,
          quantity: quantityValue,
          rate: rateValue,
          // One cap per unit; the server derives the quantity from the line.
          capProductId: selectedCap?.id ?? null,
        }],
        paidAmount: paidValue,
        paymentMethod: method,
        note: note.trim(),
      };

      const localReceipt: Receipt = {
        invoiceNo: provisionalInvoiceNo(clientUuid),
        saleDate,
        customerCode: isLocal ? 'LOCAL' : selected!.code,
        customerName: isLocal ? 'Local / Walk-in' : selected!.name,
        isLocal,
        paymentMethod: method,
        lines: [{ name: product.name, quantity: quantityValue, rate: rateValue, amount: total, capName: selectedCap?.name ?? null }],
        totalAmount: total,
        paidAmount: paidValue,
        balanceAmount: balance,
        previousBalance: isLocal ? 0 : previousBalance,
        createdAt: new Date().toISOString(),
        synced: false,
      };

      // Durable first, then print. If the browser dies between these two lines
      // the sale is already safe and will sync on next open.
      await enqueueSale(request, localReceipt);

      setReceipt(localReceipt);
      if (!isLocal) applyLocalSale(selected!.id, balance);
      void pruneReceipts();
      void flushOutbox();

      reset();
    } catch (submitError) {
      setError(
        submitError instanceof Error
          ? `Could not record the sale locally: ${submitError.message}`
          : 'Could not record the sale.',
      );
    } finally {
      setSaving(false);
    }
  }, [
    product, isLocal, selected, quantityValue, rateValue, paidValue, total, balance,
    previousBalance, note, method, selectedCap, data, applyLocalSale, reset,
  ]);

  // ---- keyboard flow -------------------------------------------------------
  const onSearchKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (matches.length === 0) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      setHighlight((h) => Math.min(h + 1, matches.length - 1));
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      setHighlight((h) => Math.max(h - 1, 0));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const chosen = matches[highlight];
      if (chosen) chooseCustomer(chosen);
    } else if (event.key === 'Escape') {
      setSearch('');
    }
  };

  const onEntryKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      // Local: quantity -> Enter -> saved. Registered: quantity -> paid -> Enter.
      if (!isLocal && event.currentTarget === quantityRef.current) paidRef.current?.focus();
      else void submit();
    } else if (event.key === 'Escape') {
      reset();
    }
  };

  if (!data) return null;

  return (
    <div className="grid gap-4 lg:grid-cols-[1fr_360px]">
      <div className="space-y-4">
        {!online && (
          <Alert tone="warn">
            <strong>Offline.</strong> Sales are being saved on this device and will sync automatically.
            {queued > 0 ? ` ${queued} waiting.` : ''}
          </Alert>
        )}
        {online && queued > 0 && (
          <Alert tone="info">{queued} sale{queued === 1 ? '' : 's'} syncing in the background.</Alert>
        )}

        <Card title="New sale">
          {/* Mode switch. Local is a first-class entry path, not a special
              customer, so it gets equal billing at the top of the form. */}
          <div className="mb-4 inline-flex rounded-lg border border-slate-300 p-1">
            {([['registered', 'Registered customer'], ['local', 'Local / walk-in']] as const).map(
              ([value, label]) => (
                <button
                  key={value}
                  type="button"
                  onClick={() => switchMode(value)}
                  className={`rounded-md px-4 py-1.5 text-sm font-medium transition-colors ${
                    mode === value ? 'bg-teal-700 text-white' : 'text-slate-600 hover:bg-slate-100'
                  }`}
                >
                  {label}
                </button>
              ),
            )}
          </div>

          {mode === 'registered' && !selected ? (
            <div>
              <Field label="Customer" hint="Type a name, code or phone number. Arrow keys to choose, Enter to select.">
                <Input
                  ref={searchRef}
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                  onKeyDown={onSearchKeyDown}
                  placeholder="Search customer"
                  autoComplete="off"
                  className="text-lg"
                />
              </Field>

              {matches.length > 0 && (
                <ul className="mt-2 divide-y divide-slate-100 overflow-hidden rounded-md border border-slate-200">
                  {matches.map((customer, index) => (
                    <li key={customer.id}>
                      <button
                        type="button"
                        onMouseEnter={() => setHighlight(index)}
                        onClick={() => chooseCustomer(customer)}
                        className={`flex w-full items-center justify-between gap-3 px-3 py-2 text-left
                          ${index === highlight ? 'bg-teal-50' : 'bg-white hover:bg-slate-50'}`}
                      >
                        <span>
                          <span className="font-medium text-slate-800">{customer.name}</span>
                          <span className="ml-2 text-xs text-slate-500">{customer.code}</span>
                        </span>
                        <span className={`tnum text-sm ${customer.balance > 0 ? 'text-red-600' : 'text-slate-400'}`}>
                          {customer.balance !== 0 ? rupees(customer.balance) : ''}
                        </span>
                      </button>
                    </li>
                  ))}
                </ul>
              )}

              {search && matches.length === 0 && (
                <p className="mt-2 text-sm text-slate-500">
                  No customer matches “{search}”. Use <strong>Local / walk-in</strong> for an unregistered buyer.
                </p>
              )}
            </div>
          ) : (
            <div className="space-y-4">
              {selected ? (
                <div className="flex items-start justify-between gap-4 rounded-md bg-slate-50 px-3 py-2">
                  <div>
                    <div className="font-semibold text-slate-800">{selected.name}</div>
                    <div className="text-xs text-slate-500">
                      {selected.code}
                      {selected.companyName ? ` · ${selected.companyName}` : ''}
                      {selected.phone ? ` · ${selected.phone}` : ''}
                    </div>
                  </div>
                  <div className="text-right">
                    <div className="text-xs uppercase tracking-wide text-slate-500">Old balance</div>
                    <div className={`tnum font-semibold ${previousBalance > 0 ? 'text-red-600' : 'text-slate-600'}`}>
                      {rupees(previousBalance)}
                    </div>
                  </div>
                </div>
              ) : (
                <div className="rounded-md bg-teal-50 px-3 py-2 text-sm text-teal-900">
                  <strong>Local sale.</strong> No customer, no balance — settled in full at the counter.
                </div>
              )}

              {sellable.length > 1 && (
                <div className="flex flex-wrap gap-2">
                  {sellable.map((p) => (
                    <button
                      key={p.id}
                      type="button"
                      onClick={() => {
                        setProductId(p.id);
                        const next = isLocal
                          ? data.quickRates[String(p.id)]?.[0] ?? p.defaultRate
                          : selected?.rates[String(p.id)] ?? p.defaultRate;
                        setRate(String(next ?? 0));
                      }}
                      className={`rounded-md border px-3 py-1.5 text-sm font-medium
                        ${p.id === product?.id
                          ? 'border-teal-600 bg-teal-50 text-teal-800'
                          : 'border-slate-300 bg-white text-slate-600 hover:bg-slate-50'}`}
                    >
                      {p.name}
                    </button>
                  ))}
                </div>
              )}

              {/* Quick rates: one tap instead of typing. Derived from history,
                  so they reflect what this counter actually charges. */}
              {isLocal && quickRates.length > 0 && (
                <div>
                  <span className="mb-1 block text-sm font-medium text-slate-700">Rate</span>
                  <div className="flex flex-wrap gap-2">
                    {quickRates.map((r) => (
                      <button
                        key={r}
                        type="button"
                        onClick={() => { setRate(String(r)); focusEntry(); }}
                        className={`tnum rounded-md border px-4 py-2 text-base font-semibold transition-colors
                          ${Number(rate) === r
                            ? 'border-teal-600 bg-teal-600 text-white'
                            : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'}`}
                      >
                        ₹{r}
                      </button>
                    ))}
                  </div>
                </div>
              )}

              {/* Cap colour. One cap goes out with every unit, so this sits
                  next to the quantity rather than buried in a dropdown, and it
                  shows what is left of each colour as you pick. */}
              {caps.length > 0 && (
                <div>
                  <div className="mb-1 flex items-baseline justify-between">
                    <span className="text-sm font-medium text-slate-700">Cap</span>
                    {selectedCap && quantityValue > 0 && (
                      <span className="text-xs text-slate-500">
                        {count(quantityValue)} × {selectedCap.name} · {count(selectedCap.onHand - quantityValue)} left after this
                      </span>
                    )}
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {caps.map((cap) => {
                      const active = cap.id === capProductId;
                      const short = cap.onHand < quantityValue;
                      return (
                        <button
                          key={cap.id}
                          type="button"
                          onClick={() => setCapProductId(cap.id)}
                          className={`rounded-md border px-3 py-2 text-sm font-medium transition-colors
                            ${active
                              ? 'border-teal-600 bg-teal-600 text-white'
                              : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'}`}
                        >
                          {cap.name}
                          <span className={`tnum ml-2 text-xs ${
                            active ? 'text-teal-100' : short || cap.onHand <= 0 ? 'text-red-600' : 'text-slate-500'
                          }`}>
                            {count(cap.onHand)}
                          </span>
                        </button>
                      );
                    })}
                    <button
                      type="button"
                      onClick={() => setCapProductId(null)}
                      className={`rounded-md border px-3 py-2 text-sm font-medium transition-colors
                        ${capProductId === null
                          ? 'border-slate-600 bg-slate-600 text-white'
                          : 'border-slate-300 bg-white text-slate-500 hover:bg-slate-50'}`}
                    >
                      No cap
                    </button>
                  </div>

                  {/* Warn, never block. A customer is at the counter and the
                      caps are physically there; refusing the sale would mean a
                      paper bill. The ledger records what actually happened. */}
                  {selectedCap && quantityValue > 0 && selectedCap.onHand < quantityValue && (
                    <p className="mt-1 text-xs font-medium text-amber-700">
                      Only {count(selectedCap.onHand)} {selectedCap.name} left — this sale will take it to{' '}
                      {count(selectedCap.onHand - quantityValue)}. Ask admin to issue more.
                    </p>
                  )}
                </div>
              )}

              <div className="grid gap-3 sm:grid-cols-3">
                <Field label={`Quantity (${product?.unit ?? 'pcs'})`}>
                  <Input
                    ref={quantityRef}
                    value={quantity}
                    onChange={(e) => setQuantity(e.target.value)}
                    onKeyDown={onEntryKeyDown}
                    inputMode="numeric"
                    placeholder="0"
                    className="tnum text-lg"
                  />
                </Field>
                <Field
                  label="Rate"
                  hint={isLocal ? 'Tap a button above, or type.' : "This customer's agreed rate."}
                >
                  <Input
                    value={rate}
                    onChange={(e) => setRate(e.target.value)}
                    onKeyDown={onEntryKeyDown}
                    inputMode="decimal"
                    className="tnum text-lg"
                  />
                </Field>
                <Field label="Total">
                  <Input value={total.toFixed(2)} readOnly className="tnum bg-slate-100 text-lg font-semibold" />
                </Field>
              </div>

              <div className="grid gap-3 sm:grid-cols-3">
                {isLocal ? (
                  <Field label="Paid" hint="Walk-in sales settle in full.">
                    <Input value={total.toFixed(2)} readOnly className="tnum bg-slate-100 text-lg font-semibold" />
                  </Field>
                ) : (
                  <Field label="Paid" hint="Blank means paid in full.">
                    <Input
                      ref={paidRef}
                      value={paid}
                      onChange={(e) => setPaid(e.target.value)}
                      onKeyDown={onEntryKeyDown}
                      inputMode="decimal"
                      placeholder={total.toFixed(2)}
                      className="tnum text-lg"
                    />
                  </Field>
                )}

                <Field label="Balance this bill">
                  <Input
                    value={balance.toFixed(2)}
                    readOnly
                    className={`tnum bg-slate-100 text-lg font-semibold ${balance > 0 ? 'text-red-600' : ''}`}
                  />
                </Field>

                <Field label="Note (optional)">
                  <Input value={note} onChange={(e) => setNote(e.target.value)} onKeyDown={onEntryKeyDown} />
                </Field>
              </div>

              {/* Payment method. Buttons rather than a dropdown: it is set on
                  most sales, and a tap beats opening a select at a counter. */}
              <div>
                <span className="mb-1 block text-sm font-medium text-slate-700">Paid by</span>
                <div className="flex flex-wrap gap-2">
                  {paymentMethods
                    .filter((m) => m !== 'CREDIT' || !isLocal)
                    .map((m) => (
                      <button
                        key={m}
                        type="button"
                        onClick={() => setMethod(m)}
                        className={`rounded-md border px-3 py-1.5 text-sm font-medium transition-colors
                          ${method === m
                            ? 'border-teal-600 bg-teal-50 text-teal-800'
                            : 'border-slate-300 bg-white text-slate-600 hover:bg-slate-50'}`}
                      >
                        {m.charAt(0) + m.slice(1).toLowerCase()}
                      </button>
                    ))}
                </div>
              </div>

              {error && <Alert tone="error">{error}</Alert>}

              <div className="flex items-center justify-between gap-3">
                <div className="text-sm text-slate-500">
                  {isLocal ? (
                    <>Counter sale — nothing carried forward.</>
                  ) : (
                    <>
                      New balance after this sale:{' '}
                      <span className={`tnum font-semibold ${previousBalance + balance > 0 ? 'text-red-600' : 'text-slate-700'}`}>
                        {rupees(previousBalance + balance)}
                      </span>
                    </>
                  )}
                </div>
                <div className="flex gap-2">
                  <Button variant="secondary" onClick={reset} type="button">
                    Clear (Esc)
                  </Button>
                  <Button onClick={() => void submit()} disabled={saving || !readyToSell || quantityValue <= 0} type="button">
                    {saving ? 'Saving…' : 'Save & print (Enter)'}
                  </Button>
                </div>
              </div>
            </div>
          )}
        </Card>
      </div>

      <div className="space-y-4">
        <Card
          title="Dispensing slip"
          actions={
            receipt ? (
              <Button variant="secondary" onClick={() => window.print()} type="button">
                Print
              </Button>
            ) : null
          }
        >
          {receipt ? (
            <>
              {/* Framed on screen so the operator can see exactly what will
                  come off the roll - the preview is the printed output, not a
                  prettier version of it. */}
              <div className="rounded border border-dashed border-slate-300 bg-white p-3">
                <ReceiptView receipt={receipt} />
              </div>
              <p className="mt-2 text-xs text-slate-500">
                Internal slip only — no business details, totals or customer. The full record is
                under Sales.
              </p>
            </>
          ) : (
            <p className="py-6 text-center text-sm text-slate-500">
              The last sale's slip appears here, ready to print.
            </p>
          )}
        </Card>

        {/* Caps get their own panel, live and refreshable.
            They move from both ends all day - the counter draws them down, an
            administrator tops them up - so "as at last sync" is not good enough
            here. This shows the number, how fresh it is, and a way to settle a
            doubt immediately. */}
        <Card
          title="Caps"
          actions={
            <Button
              variant="secondary"
              type="button"
              onClick={() => void refreshCaps()}
              disabled={capsRefreshing}
            >
              {capsRefreshing ? 'Checking…' : 'Refresh'}
            </Button>
          }
        >
          <div className="space-y-1 text-sm">
            {caps.map((cap) => (
              <div key={cap.id} className="flex items-center justify-between">
                <span className={cap.id === capProductId ? 'font-medium text-teal-800' : 'text-slate-600'}>
                  {cap.name}
                  {cap.id === capProductId && <span className="ml-1 text-xs text-teal-600">· selling</span>}
                </span>
                <span className="tnum font-medium">
                  {cap.onHand < 0 ? <Badge tone="red">{count(cap.onHand)}</Badge> : count(cap.onHand)}
                </span>
              </div>
            ))}
          </div>
          <p className="mt-2 text-xs text-slate-500">
            <CapFreshness asOf={capsAsOf} online={online} queued={queued} />
          </p>
        </Card>

        <Card title="Other stock">
          <div className="space-y-1 text-sm">
            {/* Sellable stock only. Caps are tracked too, but they have their
                own live panel above - listing them twice, with the two figures
                refreshing on different timers, is exactly how a number starts
                looking untrustworthy. */}
            {(data.products ?? [])
              .filter((p) => p.tracksStock && p.isSellable)
              .map((p) => {
                const onHand = data.stock[String(p.id)] ?? 0;
                return (
                  <div key={p.id} className="flex items-center justify-between">
                    <span className="text-slate-600">{p.name}</span>
                    <span className="tnum font-medium">
                      {onHand < 0 ? <Badge tone="red">{count(onHand)}</Badge> : count(onHand)}
                    </span>
                  </div>
                );
              })}
          </div>
          <p className="mt-2 text-xs text-slate-500">As at last sync. Stock never blocks a sale.</p>
        </Card>
      </div>
    </div>
  );
}
