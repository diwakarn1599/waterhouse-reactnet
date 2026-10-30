import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, qs } from '../api/client';
import type { PaymentMethod, SaleDetail } from '../api/types';
import { paymentMethods } from '../api/types';
import { useSession } from '../state/session';
import {
  Alert, Badge, Button, Card, EmptyState, Field, Input, Select, Spinner,
  Stat, Table, TableWrap, Td, Th,
} from '../components/ui';
import { count, displayDate, displayDateTime, rupees, startOfMonth, todayIso } from '../format';

const statusTone = { PAID: 'green', PARTIAL: 'amber', UNPAID: 'red' } as const;

interface SaleRow {
  id: number;
  invoiceNo: string;
  saleDate: string;
  customerId: number | null;
  customerCode: string;
  customerName: string;
  isLocal: boolean;
  quantity: number;
  products: string;
  caps: string;
  totalAmount: number;
  paidAmount: number;
  balanceAmount: number;
  paymentStatus: 'PAID' | 'PARTIAL' | 'UNPAID';
  paymentMethod: PaymentMethod;
  isVoid: boolean;
  note: string;
  createdAt: string;
  createdByName: string | null;
}

interface SalesResponse {
  total: number;
  page: number;
  pageSize: number;
  items: SaleRow[];
  totals: { quantity: number; totalAmount: number; paidAmount: number; balanceAmount: number };
}

const blankFilters = () => ({
  search: '',
  from: startOfMonth(todayIso()),
  to: todayIso(),
  customerId: '' as number | '',
  status: '',
  customerType: 'all',
  paymentMethod: '',
  includeVoid: false,
});

export function SalesPage() {
  const { user, customers } = useSession();
  const isAdmin = user?.role === 'admin';

  const [f, setF] = useState(blankFilters);
  const [page, setPage] = useState(1);
  const [selected, setSelected] = useState<number | null>(null);
  const [editing, setEditing] = useState<number | null>(null);

  const pageSize = 50;
  const set = <K extends keyof ReturnType<typeof blankFilters>>(
    key: K,
    value: ReturnType<typeof blankFilters>[K],
  ) => {
    setF((prev) => ({ ...prev, [key]: value }));
    setPage(1);
  };

  const query = useQuery({
    queryKey: ['sales', { ...f, page }],
    queryFn: () =>
      api.get<SalesResponse>(
        `/api/sales${qs({
          search: f.search, from: f.from, to: f.to, customerId: f.customerId,
          status: f.status, customerType: f.customerType === 'all' ? '' : f.customerType,
          paymentMethod: f.paymentMethod, includeVoid: f.includeVoid, page, pageSize,
        })}`,
      ),
  });

  const totalPages = query.data ? Math.max(1, Math.ceil(query.data.total / pageSize)) : 1;

  const selectedCustomer = useMemo(
    () => customers.find((c) => c.id === f.customerId),
    [customers, f.customerId],
  );

  return (
    <div className="space-y-4">
      <Card
        title="Filters"
        actions={
          <Button variant="secondary" type="button" onClick={() => { setF(blankFilters()); setPage(1); }}>
            Reset
          </Button>
        }
      >
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Search" hint="Name, code or invoice number">
            <Input value={f.search} onChange={(e) => set('search', e.target.value)} placeholder="Search" />
          </Field>

          {/* Customer filter proper - a dropdown of real accounts, not just a
              text match, so picking "Sekar" cannot also catch "Sekaran". */}
          <Field label="Customer" hint={selectedCustomer ? `Balance ${rupees(selectedCustomer.balance)}` : 'All customers'}>
            <Select
              value={f.customerId}
              onChange={(e) => set('customerId', e.target.value ? Number(e.target.value) : '')}
            >
              <option value="">All customers</option>
              {customers.map((c) => (
                <option key={c.id} value={c.id}>{c.name} ({c.code})</option>
              ))}
            </Select>
          </Field>

          <Field label="From"><Input type="date" value={f.from} onChange={(e) => set('from', e.target.value)} /></Field>
          <Field label="To"><Input type="date" value={f.to} onChange={(e) => set('to', e.target.value)} /></Field>

          <Field label="Customer type">
            <Select value={f.customerType} onChange={(e) => set('customerType', e.target.value)}>
              <option value="all">All sales</option>
              <option value="registered">Registered only</option>
              <option value="local">Local / walk-in only</option>
            </Select>
          </Field>

          <Field label="Payment status">
            <Select value={f.status} onChange={(e) => set('status', e.target.value)}>
              <option value="">Any status</option>
              <option value="PAID">Paid</option>
              <option value="PARTIAL">Partial</option>
              <option value="UNPAID">Unpaid</option>
            </Select>
          </Field>

          <Field label="Paid by">
            <Select value={f.paymentMethod} onChange={(e) => set('paymentMethod', e.target.value)}>
              <option value="">Any method</option>
              {paymentMethods.map((m) => (
                <option key={m} value={m}>{m.charAt(0) + m.slice(1).toLowerCase()}</option>
              ))}
            </Select>
          </Field>

          <label className="flex items-end gap-2 pb-2 text-sm text-slate-600">
            <input
              type="checkbox"
              checked={f.includeVoid}
              onChange={(e) => set('includeVoid', e.target.checked)}
            />
            Include voided
          </label>
        </div>
      </Card>

      {/* Totals for the whole filtered set, not just the visible page. A
          filtered view is nearly always a question about money. */}
      {query.data && (
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="Sales" value={count(query.data.total)} sub={`${count(query.data.totals.quantity)} units`} />
          <Stat label="Billed" value={rupees(query.data.totals.totalAmount)} />
          <Stat label="Collected" value={rupees(query.data.totals.paidAmount)} tone="good" />
          <Stat
            label="Outstanding"
            value={rupees(query.data.totals.balanceAmount)}
            tone={query.data.totals.balanceAmount > 0 ? 'bad' : 'default'}
          />
        </div>
      )}

      <Card
        title={query.data ? `${count(query.data.total)} sale${query.data.total === 1 ? '' : 's'}` : 'Results'}
        actions={
          totalPages > 1 ? (
            <div className="flex items-center gap-2 text-sm">
              <Button variant="secondary" type="button" disabled={page <= 1} onClick={() => setPage((p) => p - 1)}>
                Previous
              </Button>
              <span className="tnum text-slate-500">{page} / {totalPages}</span>
              <Button variant="secondary" type="button" disabled={page >= totalPages} onClick={() => setPage((p) => p + 1)}>
                Next
              </Button>
            </div>
          ) : null
        }
      >
        {query.isPending ? (
          <Spinner />
        ) : query.isError ? (
          <Alert tone="error">Could not load sales.</Alert>
        ) : query.data.items.length === 0 ? (
          <EmptyState message="No sales match these filters." />
        ) : (
          <TableWrap>
            <Table>
              <thead>
                <tr>
                  <Th>Invoice</Th>
                  <Th>Date</Th>
                  <Th>Customer</Th>
                  <Th>Item</Th>
                  <Th>Cap</Th>
                  <Th align="right">Qty</Th>
                  <Th align="right">Total</Th>
                  <Th align="right">Paid</Th>
                  <Th align="right">Balance</Th>
                  <Th>Paid by</Th>
                  <Th>Status</Th>
                  <Th>By</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {query.data.items.map((sale) => (
                  <tr key={sale.id} className={sale.isVoid ? 'opacity-50' : ''}>
                    <Td className="font-mono text-xs">{sale.invoiceNo}</Td>
                    <Td className="whitespace-nowrap">{displayDate(sale.saleDate)}</Td>
                    <Td>
                      {sale.isLocal ? (
                        <Badge tone="amber">Local</Badge>
                      ) : (
                        <>
                          <span className="font-medium">{sale.customerName}</span>
                          <span className="ml-2 text-xs text-slate-500">{sale.customerCode}</span>
                        </>
                      )}
                    </Td>
                    <Td className="text-slate-600">{sale.products || '—'}</Td>
                    <Td className="text-slate-600">{sale.caps || '—'}</Td>
                    <Td align="right" className="tnum">{count(sale.quantity)}</Td>
                    <Td align="right" className="tnum">{rupees(sale.totalAmount)}</Td>
                    <Td align="right" className="tnum">{rupees(sale.paidAmount)}</Td>
                    <Td align="right" className={`tnum ${sale.balanceAmount > 0 ? 'text-red-600' : ''}`}>
                      {rupees(sale.balanceAmount)}
                    </Td>
                    <Td className="text-slate-600">{titleCase(sale.paymentMethod)}</Td>
                    <Td>
                      {sale.isVoid
                        ? <Badge tone="slate">Void</Badge>
                        : <Badge tone={statusTone[sale.paymentStatus]}>{sale.paymentStatus}</Badge>}
                    </Td>
                    <Td className="text-xs text-slate-500">{sale.createdByName ?? '—'}</Td>
                    <Td align="right">
                      <div className="flex justify-end gap-1">
                        <Button variant="ghost" type="button" onClick={() => setSelected(sale.id)}>View</Button>
                        {isAdmin && !sale.isVoid && (
                          <Button variant="ghost" type="button" onClick={() => setEditing(sale.id)}>Edit</Button>
                        )}
                      </div>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </TableWrap>
        )}
      </Card>

      {editing !== null && (
        <EditSalePanel id={editing} onClose={() => setEditing(null)} />
      )}

      {selected !== null && (
        <SaleDetailPanel id={selected} onClose={() => setSelected(null)} canVoid={isAdmin} />
      )}
    </div>
  );
}

const titleCase = (s: string) => (s ? s.charAt(0) + s.slice(1).toLowerCase() : '');

/* -------------------------------------------------------------------------- */
/*  Edit                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Correct a recorded sale.
 *
 * Admin only. The invoice number is preserved, stock is corrected by
 * compensating movements rather than rewriting history, and the change lands in
 * the audit log. A voided sale cannot be edited.
 */
function EditSalePanel({ id, onClose }: { id: number; onClose: () => void }) {
  const { data, customers, caps } = useSession();
  const queryClient = useQueryClient();

  const detail = useQuery({
    queryKey: ['sale', id],
    queryFn: () => api.get<SaleDetail>(`/api/sales/${id}`),
  });

  const [form, setForm] = useState<{
    saleDate: string; customerId: number | ''; isLocal: boolean;
    productId: number | ''; quantity: string; rate: string; capProductId: number | '';
    paidAmount: string; paymentMethod: PaymentMethod; note: string;
  } | null>(null);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});

  // Seed the form once the sale loads. Kept in an effect-free guard so the
  // operator's in-progress edits are never clobbered by a background refetch.
  if (detail.data && form === null) {
    const line = detail.data.lines[0];
    setForm({
      saleDate: detail.data.saleDate,
      customerId: detail.data.customerId ?? '',
      isLocal: detail.data.isLocal,
      productId: line?.productId ?? '',
      quantity: line ? String(line.quantity) : '',
      rate: line ? String(line.rate) : '',
      capProductId: line?.capProductId ?? '',
      paidAmount: String(detail.data.paidAmount),
      paymentMethod: detail.data.paymentMethod,
      note: detail.data.note,
    });
  }

  const save = useMutation({
    mutationFn: () => {
      const f = form!;
      return api.put(`/api/sales/${id}`, {
        clientUuid: null,
        saleDate: f.saleDate,
        customerId: f.isLocal ? null : Number(f.customerId),
        isLocal: f.isLocal,
        lines: [{
          productId: Number(f.productId),
          quantity: Number(f.quantity),
          rate: Number(f.rate),
          capProductId: f.capProductId === '' ? null : Number(f.capProductId),
        }],
        paidAmount: f.isLocal ? 0 : Number(f.paidAmount),
        paymentMethod: f.paymentMethod,
        note: f.note,
      });
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['sales'] });
      void queryClient.invalidateQueries({ queryKey: ['sale', id] });
      onClose();
    },
    onError: (error) => { if (error instanceof ApiError) setFieldErrors(error.fieldErrors); },
  });

  const update = <K extends keyof NonNullable<typeof form>>(key: K, value: NonNullable<typeof form>[K]) =>
    setForm((prev) => (prev ? { ...prev, [key]: value } : prev));

  const errorFor = (field: string) => fieldErrors[field]?.[0];
  const total = form ? Math.round((Number(form.quantity) || 0) * (Number(form.rate) || 0) * 100) / 100 : 0;
  const paidValue = form?.isLocal ? total : Number(form?.paidAmount) || 0;
  const balance = Math.round((total - paidValue) * 100) / 100;

  return (
    <Card
      title={detail.data ? `Edit ${detail.data.invoiceNo}` : 'Edit sale'}
      actions={<Button variant="secondary" type="button" onClick={onClose}>Close</Button>}
    >
      {detail.isPending || !form ? (
        <Spinner />
      ) : detail.isError ? (
        <Alert tone="error">Could not load this sale.</Alert>
      ) : (
        <div className="space-y-4">
          <Alert tone="warn">
            Editing a recorded sale. The invoice number stays the same, stock is corrected
            automatically, and the change is written to the audit log.
          </Alert>

          <div className="grid gap-3 sm:grid-cols-3">
            <Field label="Date" error={errorFor('saleDate')}>
              <Input type="date" value={form.saleDate} max={data?.today} onChange={(e) => update('saleDate', e.target.value)} />
            </Field>

            <Field label="Sale type">
              <Select
                value={form.isLocal ? 'local' : 'registered'}
                onChange={(e) => {
                  const local = e.target.value === 'local';
                  setForm((p) => (p ? { ...p, isLocal: local, customerId: local ? '' : p.customerId } : p));
                }}
              >
                <option value="registered">Registered customer</option>
                <option value="local">Local / walk-in</option>
              </Select>
            </Field>

            <Field label="Customer" error={errorFor('customerId')}>
              <Select
                value={form.customerId}
                disabled={form.isLocal}
                onChange={(e) => update('customerId', e.target.value ? Number(e.target.value) : '')}
              >
                <option value="">{form.isLocal ? 'None (walk-in)' : 'Select a customer'}</option>
                {customers.map((c) => (
                  <option key={c.id} value={c.id}>{c.name} ({c.code})</option>
                ))}
              </Select>
            </Field>
          </div>

          <div className="grid gap-3 sm:grid-cols-4">
            <Field label="Item" error={errorFor('lines[0].productId')}>
              <Select value={form.productId} onChange={(e) => update('productId', e.target.value ? Number(e.target.value) : '')}>
                {(data?.products ?? []).filter((p) => p.isSellable).map((p) => (
                  <option key={p.id} value={p.id}>{p.name}</option>
                ))}
              </Select>
            </Field>
            <Field label="Cap">
              <Select value={form.capProductId} onChange={(e) => update('capProductId', e.target.value ? Number(e.target.value) : '')}>
                <option value="">No cap</option>
                {caps.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
              </Select>
            </Field>
            <Field label="Quantity" error={errorFor('lines[0].quantity')}>
              <Input value={form.quantity} onChange={(e) => update('quantity', e.target.value)} inputMode="numeric" className="tnum" />
            </Field>
            <Field label="Rate" error={errorFor('lines[0].rate')}>
              <Input value={form.rate} onChange={(e) => update('rate', e.target.value)} inputMode="decimal" className="tnum" />
            </Field>
          </div>

          <div className="grid gap-3 sm:grid-cols-4">
            <Field label="Total">
              <Input value={total.toFixed(2)} readOnly className="tnum bg-slate-100 font-semibold" />
            </Field>
            <Field label="Paid" hint={form.isLocal ? 'Walk-ins settle in full.' : undefined} error={errorFor('paidAmount')}>
              <Input
                value={form.isLocal ? total.toFixed(2) : form.paidAmount}
                readOnly={form.isLocal}
                onChange={(e) => update('paidAmount', e.target.value)}
                inputMode="decimal"
                className={`tnum ${form.isLocal ? 'bg-slate-100' : ''}`}
              />
            </Field>
            <Field label="Balance">
              <Input
                value={balance.toFixed(2)}
                readOnly
                className={`tnum bg-slate-100 font-semibold ${balance > 0 ? 'text-red-600' : ''}`}
              />
            </Field>
            <Field label="Paid by">
              <Select value={form.paymentMethod} onChange={(e) => update('paymentMethod', e.target.value as PaymentMethod)}>
                {paymentMethods.map((m) => <option key={m} value={m}>{titleCase(m)}</option>)}
              </Select>
            </Field>
          </div>

          <Field label="Note">
            <Input value={form.note} onChange={(e) => update('note', e.target.value)} />
          </Field>

          {save.isError && !Object.keys(fieldErrors).length && (
            <Alert tone="error">
              {save.error instanceof ApiError ? save.error.message : 'Could not save this sale.'}
            </Alert>
          )}

          <div className="flex gap-2">
            <Button
              type="button"
              disabled={save.isPending || Number(form.quantity) <= 0 || (!form.isLocal && !form.customerId)}
              onClick={() => save.mutate()}
            >
              {save.isPending ? 'Saving…' : 'Save changes'}
            </Button>
            <Button variant="secondary" type="button" onClick={onClose}>Cancel</Button>
          </div>
        </div>
      )}
    </Card>
  );
}

/* -------------------------------------------------------------------------- */
/*  Detail                                                                     */
/* -------------------------------------------------------------------------- */

function SaleDetailPanel({ id, onClose, canVoid }: { id: number; onClose: () => void; canVoid: boolean }) {
  const queryClient = useQueryClient();
  const [reason, setReason] = useState('');
  const [confirming, setConfirming] = useState(false);

  const detail = useQuery({
    queryKey: ['sale', id],
    queryFn: () => api.get<SaleDetail>(`/api/sales/${id}`),
  });

  const voidSale = useMutation({
    mutationFn: () => api.post(`/api/sales/${id}/void`, { reason }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['sales'] });
      void queryClient.invalidateQueries({ queryKey: ['sale', id] });
      setConfirming(false);
      setReason('');
    },
  });

  return (
    <Card
      title={detail.data ? `Invoice ${detail.data.invoiceNo}` : 'Sale'}
      actions={<Button variant="secondary" type="button" onClick={onClose}>Close</Button>}
    >
      {detail.isPending ? (
        <Spinner />
      ) : detail.isError ? (
        <Alert tone="error">Could not load this sale.</Alert>
      ) : (
        <div className="space-y-4">
          {detail.data.isVoid && <Alert tone="warn">This sale is voided and excluded from all totals.</Alert>}

          <div className="grid gap-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
            <Detail label="Date" value={displayDate(detail.data.saleDate)} />
            <Detail
              label="Customer"
              value={detail.data.isLocal
                ? 'Local / Walk-in'
                : `${detail.data.customerName} (${detail.data.customerCode})`}
            />
            <Detail label="Sale type" value={detail.data.isLocal ? 'Local / walk-in' : 'Registered'} />
            <Detail label="Status" value={detail.data.isVoid ? 'Void' : detail.data.paymentStatus} />
            <Detail label="Paid by" value={titleCase(detail.data.paymentMethod)} />
            <Detail label="Entered by" value={detail.data.createdByName ?? '—'} />
            <Detail label="Entered at" value={displayDateTime(detail.data.createdAt)} />
            <Detail label="Invoice" value={detail.data.invoiceNo} />
          </div>

          <TableWrap>
            <Table>
              <thead>
                <tr>
                  <Th>Item</Th><Th>Cap</Th>
                  <Th align="right">Qty</Th><Th align="right">Rate</Th><Th align="right">Amount</Th>
                </tr>
              </thead>
              <tbody>
                {detail.data.lines.map((line, index) => (
                  <tr key={index}>
                    <Td className="font-medium">{line.productName}</Td>
                    <Td className="text-slate-600">{line.capName ?? '—'}</Td>
                    <Td align="right" className="tnum">{count(line.quantity)}</Td>
                    <Td align="right" className="tnum">{rupees(line.rate)}</Td>
                    <Td align="right" className="tnum">{rupees(line.amount)}</Td>
                  </tr>
                ))}
                {detail.data.lines.length === 0 && (
                  <tr>
                    {/* 755 imported rows recorded no quantity; six carry a
                        payment. Debt settlements entered through the legacy sale
                        screen, kept intact rather than discarded. */}
                    <Td><span className="text-slate-500">No items — this entry recorded a payment only.</span></Td>
                    <Td /><Td /><Td /><Td />
                  </tr>
                )}
              </tbody>
            </Table>
          </TableWrap>

          <div className="grid gap-2 text-sm sm:grid-cols-3">
            <Detail label="Total" value={rupees(detail.data.totalAmount)} />
            <Detail label="Paid" value={rupees(detail.data.paidAmount)} />
            <Detail label="Balance" value={rupees(detail.data.balanceAmount)} />
          </div>

          {detail.data.note && <Alert tone="info">{detail.data.note}</Alert>}

          {canVoid && !detail.data.isVoid && (
            <div className="border-t border-slate-200 pt-4">
              {!confirming ? (
                <Button variant="danger" type="button" onClick={() => setConfirming(true)}>Void this sale</Button>
              ) : (
                <div className="space-y-2">
                  <Alert tone="warn">
                    Voiding reverses the stock movements and removes this sale from all totals.
                    The record is kept, never deleted.
                  </Alert>
                  <Field label="Reason">
                    <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why is this being voided?" />
                  </Field>
                  {voidSale.isError && <Alert tone="error">Could not void this sale.</Alert>}
                  <div className="flex gap-2">
                    <Button
                      variant="danger"
                      type="button"
                      disabled={!reason.trim() || voidSale.isPending}
                      onClick={() => voidSale.mutate()}
                    >
                      {voidSale.isPending ? 'Voiding…' : 'Confirm void'}
                    </Button>
                    <Button variant="secondary" type="button" onClick={() => setConfirming(false)}>Cancel</Button>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      )}
    </Card>
  );
}

function Detail({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wide text-slate-500">{label}</div>
      <div className="font-medium text-slate-800">{value}</div>
    </div>
  );
}
