import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, qs } from '../api/client';
import { useSession } from '../state/session';
import {
  Alert, Badge, Button, Card, EmptyState, Field, Input, Select, Spinner,
  Stat, Table, TableWrap, Td, Th,
} from '../components/ui';
import { addDays, count, displayDate, endOfMonth, rupees, startOfMonth, todayIso } from '../format';

interface StockLevel {
  productId: number;
  code: string;
  name: string;
  unit: string;
  onHand: number;
}

interface LedgerRow {
  id: number;
  entryDate: string;
  productName: string;
  changeQty: number;
  refType: 'RECEIPT' | 'SALE' | 'ADJUSTMENT' | 'OPENING' | 'SNAPSHOT';
  refId: number | null;
  note: string;
  createdByName: string | null;
}

const refTone = {
  RECEIPT: 'green', SALE: 'slate', ADJUSTMENT: 'amber', OPENING: 'amber', SNAPSHOT: 'slate',
} as const;

/**
 * Stock is derived from an append-only ledger, never from a mutable counter.
 *
 * The legacy app kept one `caps.bal_caps` column and updated it with a
 * read-then-write outside any transaction, guarded by `bal_caps > 0`. Once it
 * went negative the guard silently stopped decrementing, and the figure has been
 * wrong for years - the imported data still contains -9, -19, -49 and -83.
 * Every movement here names its source row and nothing can drift.
 */
export function StockPage() {
  const { user, refresh } = useSession();
  const queryClient = useQueryClient();
  const [tab, setTab] = useState<'caps' | 'receipts' | 'ledger'>('caps');

  const levels = useQuery({
    queryKey: ['stock', 'levels'],
    queryFn: () => api.get<StockLevel[]>('/api/stock/levels'),
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['stock'] });
    void refresh();
  };

  return (
    <div className="space-y-4">
      {levels.isPending ? (
        <Spinner />
      ) : levels.isError ? (
        <Alert tone="error">Could not load stock levels.</Alert>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {levels.data.map((level) => (
            <Stat
              key={level.productId}
              label={level.name}
              value={count(level.onHand)}
              sub={level.unit}
              tone={level.onHand < 0 ? 'bad' : level.onHand === 0 ? 'warn' : 'default'}
            />
          ))}
        </div>
      )}

      {levels.data?.some((l) => l.onHand < 0) && (
        <Alert tone="warn">
          A negative figure means more has been sold than was recorded as received. Add the missing
          stock receipts, or post an adjustment to match a physical count.
        </Alert>
      )}

      <div className="flex gap-2">
        {([['caps', 'Caps'], ['receipts', 'Stock received'], ['ledger', 'Movement history']] as const).map(
          ([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => setTab(value)}
              className={`rounded-md px-3 py-1.5 text-sm font-medium ${
                tab === value ? 'bg-teal-50 text-teal-800' : 'text-slate-600 hover:bg-slate-100'
              }`}
            >
              {label}
            </button>
          ),
        )}
      </div>

      {tab === 'caps' && <CapsTab onChanged={invalidate} isAdmin={user?.role === 'admin'} />}
      {tab === 'receipts' && <ReceiptsTab onChanged={invalidate} isAdmin={user?.role === 'admin'} />}
      {tab === 'ledger' && <LedgerTab />}
    </div>
  );
}

interface CapLevel {
  productId: number;
  code: string;
  name: string;
  onHand: number;
  issuedToday: number;
  usedToday: number;
}

interface CapReportRow {
  productId: number;
  code: string;
  name: string;
  openingBalance: number;
  issued: number;
  used: number;
  adjusted: number;
  closingBalance: number;
}

/**
 * Caps: the morning issue, and how many of them went out.
 *
 * A cap is given away with every can, so the counter draws them down all day and
 * an administrator tops them up each morning. Both sides are ordinary
 * stock_ledger movements, which is why "used" here can be trusted - it is the
 * sum of real sale movements, not a counter anyone could have edited.
 */
function CapsTab({ onChanged, isAdmin }: { onChanged: () => void; isAdmin: boolean }) {
  const queryClient = useQueryClient();
  const [issueDate, setIssueDate] = useState(todayIso());
  const [quantities, setQuantities] = useState<Record<number, string>>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});

  const [from, setFrom] = useState(todayIso());
  const [to, setTo] = useState(todayIso());

  const levels = useQuery({
    queryKey: ['stock', 'caps'],
    queryFn: () => api.get<CapLevel[]>('/api/stock/caps'),
  });

  const report = useQuery({
    queryKey: ['stock', 'caps', 'report', { from, to }],
    queryFn: () => api.get<{
      items: CapReportRow[];
      daily: Array<{ entryDate: string; productId: number; name: string; issued: number; used: number }>;
      totals: { issued: number; used: number; closingBalance: number };
    }>(`/api/stock/caps/report${qs({ from, to })}`),
  });

  const issue = useMutation({
    mutationFn: () =>
      api.post('/api/stock/caps/issue', {
        issueDate,
        lines: Object.entries(quantities)
          .map(([productId, q]) => ({ productId: Number(productId), quantity: Number(q) || 0 }))
          .filter((l) => l.quantity > 0),
      }),
    onSuccess: () => {
      setQuantities({});
      setFieldErrors({});
      void queryClient.invalidateQueries({ queryKey: ['stock'] });
      onChanged();
    },
    onError: (error) => { if (error instanceof ApiError) setFieldErrors(error.fieldErrors); },
  });

  const entered = Object.values(quantities).reduce((sum, q) => sum + (Number(q) || 0), 0);

  const preset = (f: string, t: string) => { setFrom(f); setTo(t); };
  const today = todayIso();

  return (
    <div className="space-y-4">
      {levels.isPending ? (
        <Spinner />
      ) : levels.isError ? (
        <Alert tone="error">Could not load cap stock.</Alert>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {levels.data.map((cap) => (
            <div key={cap.productId} className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
              <div className="text-xs font-medium uppercase tracking-wide text-slate-500">{cap.name}</div>
              <div className={`tnum mt-1 text-3xl font-semibold ${
                cap.onHand < 0 ? 'text-red-600' : cap.onHand === 0 ? 'text-amber-600' : 'text-slate-900'
              }`}>
                {count(cap.onHand)}
              </div>
              <div className="mt-2 flex gap-4 text-xs text-slate-500">
                <span>Issued today <span className="tnum font-medium text-teal-700">+{count(cap.issuedToday)}</span></span>
                <span>Used today <span className="tnum font-medium text-slate-700">−{count(cap.usedToday)}</span></span>
              </div>
            </div>
          ))}
        </div>
      )}

      {isAdmin && (
        <Card title="Issue caps for the day">
          <p className="mb-3 text-sm text-slate-600">
            Record how many of each colour were taken out. This adds to what the counter can sell —
            enter only the new caps, not a running total.
          </p>

          <div className="grid gap-3 sm:grid-cols-4">
            <Field label="Date" error={fieldErrors.issueDate?.[0]}>
              <Input type="date" value={issueDate} max={today} onChange={(e) => setIssueDate(e.target.value)} />
            </Field>
            {(levels.data ?? []).map((cap) => (
              <Field key={cap.productId} label={cap.name} hint={`${count(cap.onHand)} on hand`}>
                <Input
                  value={quantities[cap.productId] ?? ''}
                  onChange={(e) => setQuantities((q) => ({ ...q, [cap.productId]: e.target.value }))}
                  inputMode="numeric"
                  placeholder="0"
                  className="tnum text-lg"
                />
              </Field>
            ))}
          </div>

          {fieldErrors.lines?.[0] && <div className="mt-3"><Alert tone="error">{fieldErrors.lines[0]}</Alert></div>}
          {issue.isSuccess && <div className="mt-3"><Alert tone="success">Issued. The Sell screen picks this up within a minute, or immediately on its next sale.</Alert></div>}

          <div className="mt-3 flex items-center gap-3">
            <Button type="button" disabled={issue.isPending || entered <= 0} onClick={() => issue.mutate()}>
              {issue.isPending ? 'Saving…' : `Issue ${entered > 0 ? count(entered) : ''} caps`}
            </Button>
            {entered > 0 && <span className="text-sm text-slate-500">across {Object.values(quantities).filter((q) => Number(q) > 0).length} colour(s)</span>}
          </div>
        </Card>
      )}

      <Card
        title="Caps issued vs used"
        actions={
          <div className="flex flex-wrap gap-1">
            <Button variant="secondary" type="button" onClick={() => preset(today, today)}>Today</Button>
            <Button variant="secondary" type="button" onClick={() => preset(addDays(today, -6), today)}>7 days</Button>
            <Button variant="secondary" type="button" onClick={() => preset(startOfMonth(today), endOfMonth(today))}>Month</Button>
            <Button variant="secondary" type="button" onClick={() => preset(`${today.slice(0, 4)}-01-01`, `${today.slice(0, 4)}-12-31`)}>Year</Button>
          </div>
        }
      >
        <div className="mb-3 grid gap-3 sm:grid-cols-3">
          <Field label="From"><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
          <Field label="To"><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
        </div>

        {report.isPending ? (
          <Spinner />
        ) : report.isError ? (
          <Alert tone="error">Could not load the cap report.</Alert>
        ) : (
          <TableWrap>
            <Table>
              <thead>
                <tr>
                  <Th>Colour</Th>
                  <Th align="right">Opening</Th>
                  <Th align="right">Issued</Th>
                  <Th align="right">Used</Th>
                  <Th align="right">Adjusted</Th>
                  <Th align="right">Closing</Th>
                </tr>
              </thead>
              <tbody>
                {report.data.items.map((row) => (
                  <tr key={row.productId}>
                    <Td className="font-medium">{row.name}</Td>
                    <Td align="right" className="tnum text-slate-500">{count(row.openingBalance)}</Td>
                    <Td align="right" className="tnum text-teal-700">+{count(row.issued)}</Td>
                    <Td align="right" className="tnum">−{count(row.used)}</Td>
                    <Td align="right" className="tnum text-slate-500">
                      {row.adjusted === 0 ? '—' : (row.adjusted > 0 ? '+' : '') + count(row.adjusted)}
                    </Td>
                    <Td align="right" className={`tnum font-semibold ${row.closingBalance < 0 ? 'text-red-600' : ''}`}>
                      {count(row.closingBalance)}
                    </Td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="font-semibold">
                  <Td>Total</Td>
                  <Td />
                  <Td align="right" className="tnum">+{count(report.data.totals.issued)}</Td>
                  <Td align="right" className="tnum">−{count(report.data.totals.used)}</Td>
                  <Td />
                  <Td align="right" className="tnum">{count(report.data.totals.closingBalance)}</Td>
                </tr>
              </tfoot>
            </Table>
          </TableWrap>
        )}

        <p className="mt-2 text-xs text-slate-500">
          Opening + issued − used ± adjusted = closing. Every figure comes from the movement
          ledger, so the arithmetic always closes.
        </p>
      </Card>
    </div>
  );
}

function ReceiptsTab({ onChanged, isAdmin }: { onChanged: () => void; isAdmin: boolean }) {
  const { data } = useSession();
  const [productId, setProductId] = useState<number | ''>('');
  const [receiptDate, setReceiptDate] = useState(todayIso());
  const [quantity, setQuantity] = useState('');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});

  const [adjustProductId, setAdjustProductId] = useState<number | ''>('');
  const [countedQty, setCountedQty] = useState('');
  const [adjustNote, setAdjustNote] = useState('');

  const stocked = (data?.products ?? []).filter((p) => p.tracksStock);

  const list = useQuery({
    queryKey: ['stock', 'receipts'],
    queryFn: () => api.get<{ items: Array<{
      id: number; receiptDate: string; productName: string; quantity: number; amount: number; note: string;
    }> }>(`/api/stock/receipts${qs({ pageSize: 100 })}`),
  });

  const add = useMutation({
    mutationFn: () =>
      api.post('/api/stock/receipts', {
        productId: Number(productId),
        receiptDate,
        quantity: Number(quantity),
        amount: amount === '' ? 0 : Number(amount),
        note: note.trim(),
      }),
    onSuccess: () => {
      setQuantity(''); setAmount(''); setNote(''); setFieldErrors({});
      void list.refetch();
      onChanged();
    },
    onError: (error) => { if (error instanceof ApiError) setFieldErrors(error.fieldErrors); },
  });

  const adjust = useMutation({
    mutationFn: () =>
      api.post('/api/stock/adjustments', {
        productId: Number(adjustProductId),
        countedQuantity: Number(countedQty),
        note: adjustNote.trim(),
      }),
    onSuccess: () => {
      setCountedQty(''); setAdjustNote('');
      void list.refetch();
      onChanged();
    },
  });

  const errorFor = (field: string) => fieldErrors[field]?.[0];

  return (
    <div className="grid gap-4 lg:grid-cols-[380px_1fr]">
      <div className="space-y-4">
        <Card title="Record stock received">
          <div className="space-y-3">
            <Field label="Item" error={errorFor('productId')}>
              <Select value={productId} onChange={(e) => setProductId(e.target.value ? Number(e.target.value) : '')}>
                <option value="">Select an item</option>
                {stocked.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </Select>
            </Field>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Date" error={errorFor('receiptDate')}>
                <Input type="date" value={receiptDate} max={todayIso()} onChange={(e) => setReceiptDate(e.target.value)} />
              </Field>
              <Field label="Quantity" error={errorFor('quantity')}>
                <Input value={quantity} onChange={(e) => setQuantity(e.target.value)} inputMode="numeric" className="tnum" />
              </Field>
            </div>
            <Field label="Cost (optional)" error={errorFor('amount')}>
              <Input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" className="tnum" placeholder="0.00" />
            </Field>
            <Field label="Note (optional)">
              <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Supplier, bill number" />
            </Field>
            {add.isError && !Object.keys(fieldErrors).length && <Alert tone="error">Could not save.</Alert>}
            <Button
              type="button"
              className="w-full"
              disabled={add.isPending || !productId || Number(quantity) <= 0}
              onClick={() => add.mutate()}
            >
              {add.isPending ? 'Saving…' : 'Add receipt'}
            </Button>
          </div>
        </Card>

        {isAdmin && (
          <Card title="Adjust to a physical count">
            <div className="space-y-3">
              <Alert tone="info">
                Enter what you actually counted. The difference is posted as a single
                auditable adjustment rather than editing history.
              </Alert>
              <Field label="Item">
                <Select value={adjustProductId} onChange={(e) => setAdjustProductId(e.target.value ? Number(e.target.value) : '')}>
                  <option value="">Select an item</option>
                  {stocked.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
                </Select>
              </Field>
              <Field label="Counted quantity">
                <Input value={countedQty} onChange={(e) => setCountedQty(e.target.value)} inputMode="numeric" className="tnum" />
              </Field>
              <Field label="Reason">
                <Input value={adjustNote} onChange={(e) => setAdjustNote(e.target.value)} placeholder="Stock take, breakage" />
              </Field>
              <Button
                variant="secondary"
                type="button"
                className="w-full"
                disabled={adjust.isPending || !adjustProductId || countedQty === '' || !adjustNote.trim()}
                onClick={() => adjust.mutate()}
              >
                {adjust.isPending ? 'Posting…' : 'Post adjustment'}
              </Button>
            </div>
          </Card>
        )}
      </div>

      <Card title="Recent receipts">
        {list.isPending ? (
          <Spinner />
        ) : list.isError ? (
          <Alert tone="error">Could not load receipts.</Alert>
        ) : list.data.items.length === 0 ? (
          <EmptyState message="No stock receipts recorded yet." />
        ) : (
          <TableWrap>
            <Table>
              <thead>
                <tr><Th>Date</Th><Th>Item</Th><Th align="right">Qty</Th><Th align="right">Cost</Th><Th>Note</Th></tr>
              </thead>
              <tbody>
                {list.data.items.map((row) => (
                  <tr key={row.id}>
                    <Td>{displayDate(row.receiptDate)}</Td>
                    <Td className="font-medium">{row.productName}</Td>
                    <Td align="right" className="tnum">{count(row.quantity)}</Td>
                    <Td align="right" className="tnum">{row.amount ? rupees(row.amount) : '—'}</Td>
                    <Td className="text-slate-600">{row.note}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </TableWrap>
        )}
      </Card>
    </div>
  );
}

function LedgerTab() {
  const { data } = useSession();
  const [productId, setProductId] = useState<number | ''>('');
  const [from, setFrom] = useState(startOfMonth(todayIso()));
  const [to, setTo] = useState(todayIso());

  const ledger = useQuery({
    queryKey: ['stock', 'ledger', { productId, from, to }],
    queryFn: () => api.get<{ items: LedgerRow[] }>(`/api/stock/ledger${qs({ productId, from, to, pageSize: 200 })}`),
  });

  return (
    <Card title="Movement history">
      <div className="mb-3 grid gap-3 sm:grid-cols-4">
        <Field label="Item">
          <Select value={productId} onChange={(e) => setProductId(e.target.value ? Number(e.target.value) : '')}>
            <option value="">All items</option>
            {(data?.products ?? []).filter((p) => p.tracksStock).map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </Select>
        </Field>
        <Field label="From"><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
        <Field label="To"><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
      </div>

      {ledger.isPending ? (
        <Spinner />
      ) : ledger.isError ? (
        <Alert tone="error">Could not load the ledger.</Alert>
      ) : ledger.data.items.length === 0 ? (
        <EmptyState message="No movements in this period." />
      ) : (
        <TableWrap>
          <Table>
            <thead>
              <tr><Th>Date</Th><Th>Item</Th><Th>Type</Th><Th>Reference</Th><Th>Note</Th><Th align="right">Change</Th></tr>
            </thead>
            <tbody>
              {ledger.data.items.map((row) => (
                <tr key={row.id}>
                  <Td>{displayDate(row.entryDate)}</Td>
                  <Td className="font-medium">{row.productName}</Td>
                  <Td><Badge tone={refTone[row.refType]}>{row.refType}</Badge></Td>
                  <Td className="font-mono text-xs text-slate-500">{row.refId ?? '—'}</Td>
                  <Td className="text-slate-600">{row.note}</Td>
                  <Td align="right" className={`tnum font-medium ${row.changeQty < 0 ? 'text-red-600' : 'text-teal-700'}`}>
                    {row.changeQty > 0 ? '+' : ''}{count(row.changeQty)}
                  </Td>
                </tr>
              ))}
            </tbody>
          </Table>
        </TableWrap>
      )}
    </Card>
  );
}
