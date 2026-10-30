import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, qs } from '../api/client';
import type { Customer, Paged } from '../api/types';
import { useSession } from '../state/session';
import {
  Alert, Button, Card, EmptyState, Field, Input, Select, Spinner,
  Table, TableWrap, Td, Th,
} from '../components/ui';
import { displayDate, rupees, startOfMonth, todayIso } from '../format';

interface PaymentRow {
  id: number;
  customerId: number;
  customerCode: string;
  customerName: string;
  paymentDate: string;
  amount: number;
  method: string;
  note: string;
  createdByName: string | null;
}

/**
 * Recording money received against an outstanding balance.
 *
 * New in this rewrite. The legacy app had no concept of a payment separate from
 * a sale, so operators recorded settlements as a sale of zero cans with a paid
 * amount - six such rows totalling Rs 13,775 came across in the import. Those
 * are preserved as they were; from here on settlements are recorded properly.
 */
export function PaymentsPage() {
  const { customers, refresh } = useSession();
  const queryClient = useQueryClient();

  const [customerId, setCustomerId] = useState<number | ''>('');
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState('CASH');
  const [paymentDate, setPaymentDate] = useState(todayIso());
  const [note, setNote] = useState('');
  const [search, setSearch] = useState('');
  const [from, setFrom] = useState(startOfMonth(todayIso()));
  const [to, setTo] = useState(todayIso());
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});

  const withBalance = useMemo(
    () => customers.filter((c) => c.balance !== 0).sort((a, b) => b.balance - a.balance),
    [customers],
  );

  const selected: Customer | undefined = useMemo(
    () => customers.find((c) => c.id === customerId),
    [customers, customerId],
  );

  const history = useQuery({
    queryKey: ['payments', { search, from, to }],
    queryFn: () => api.get<Paged<PaymentRow>>(`/api/payments${qs({ search, from, to, pageSize: 100 })}`),
  });

  const record = useMutation({
    mutationFn: () =>
      api.post('/api/payments', {
        clientUuid: crypto.randomUUID(),
        customerId: Number(customerId),
        paymentDate,
        amount: Number(amount),
        method,
        note: note.trim(),
      }),
    onSuccess: () => {
      setAmount(''); setNote(''); setCustomerId(''); setFieldErrors({});
      void queryClient.invalidateQueries({ queryKey: ['payments'] });
      void refresh();
    },
    onError: (error) => {
      if (error instanceof ApiError) setFieldErrors(error.fieldErrors);
    },
  });

  const errorFor = (field: string) => fieldErrors[field]?.[0];
  const amountValue = Number(amount) || 0;
  const balanceAfter = (selected?.balance ?? 0) - amountValue;

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-[400px_1fr]">
        <Card title="Record a payment">
          <div className="space-y-3">
            <Field label="Customer" error={errorFor('customerId')}>
              <Select value={customerId} onChange={(e) => setCustomerId(e.target.value ? Number(e.target.value) : '')}>
                <option value="">Select a customer</option>
                {customers.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.name} ({c.code}){c.balance !== 0 ? ` — ${rupees(c.balance)}` : ''}
                  </option>
                ))}
              </Select>
            </Field>

            {selected && (
              <Alert tone={selected.balance > 0 ? 'warn' : 'info'}>
                Outstanding: <strong className="tnum">{rupees(selected.balance)}</strong>
              </Alert>
            )}

            <Field label="Amount" error={errorFor('amount')}>
              <Input
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                inputMode="decimal"
                placeholder="0.00"
                className="tnum text-lg"
              />
            </Field>

            {selected && amountValue > 0 && (
              <p className="text-sm text-slate-600">
                Balance after:{' '}
                <span className={`tnum font-semibold ${balanceAfter > 0 ? 'text-red-600' : 'text-teal-700'}`}>
                  {rupees(balanceAfter)}
                </span>
                {balanceAfter < 0 && <span className="ml-1 text-xs text-slate-500">(credit)</span>}
              </p>
            )}

            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Date" error={errorFor('paymentDate')}>
                <Input type="date" value={paymentDate} max={todayIso()} onChange={(e) => setPaymentDate(e.target.value)} />
              </Field>
              <Field label="Method">
                <Select value={method} onChange={(e) => setMethod(e.target.value)}>
                  <option value="CASH">Cash</option>
                  <option value="UPI">UPI</option>
                  <option value="BANK">Bank transfer</option>
                  <option value="CHEQUE">Cheque</option>
                </Select>
              </Field>
            </div>

            <Field label="Note (optional)">
              <Input value={note} onChange={(e) => setNote(e.target.value)} />
            </Field>

            {record.isError && !Object.keys(fieldErrors).length && (
              <Alert tone="error">
                {record.error instanceof ApiError ? record.error.message : 'Could not record the payment.'}
              </Alert>
            )}
            {record.isSuccess && <Alert tone="success">Payment recorded.</Alert>}

            <Button
              type="button"
              className="w-full"
              disabled={record.isPending || !customerId || amountValue <= 0}
              onClick={() => record.mutate()}
            >
              {record.isPending ? 'Recording…' : 'Record payment'}
            </Button>
          </div>
        </Card>

        <Card title={`Outstanding balances (${withBalance.length})`}>
          {withBalance.length === 0 ? (
            <EmptyState message="No customer has an outstanding balance." />
          ) : (
            <TableWrap>
              <Table>
                <thead>
                  <tr>
                    <Th>Code</Th>
                    <Th>Customer</Th>
                    <Th>Phone</Th>
                    <Th align="right">Balance</Th>
                    <Th />
                  </tr>
                </thead>
                <tbody>
                  {withBalance.map((customer) => (
                    <tr key={customer.id}>
                      <Td className="font-mono text-xs">{customer.code}</Td>
                      <Td className="font-medium">{customer.name}</Td>
                      <Td className="text-slate-600">{customer.phone}</Td>
                      <Td align="right" className={`tnum font-medium ${customer.balance > 0 ? 'text-red-600' : 'text-teal-700'}`}>
                        {rupees(customer.balance)}
                      </Td>
                      <Td align="right">
                        <Button
                          variant="ghost"
                          type="button"
                          onClick={() => {
                            setCustomerId(customer.id);
                            setAmount(customer.balance > 0 ? String(customer.balance) : '');
                            window.scrollTo({ top: 0, behavior: 'smooth' });
                          }}
                        >
                          Settle
                        </Button>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </TableWrap>
          )}
        </Card>
      </div>

      <Card title="Payment history">
        <div className="mb-3 grid gap-3 sm:grid-cols-4">
          <Field label="Search"><Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Customer" /></Field>
          <Field label="From"><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
          <Field label="To"><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
        </div>

        {history.isPending ? (
          <Spinner />
        ) : history.isError ? (
          <Alert tone="error">Could not load payment history.</Alert>
        ) : history.data.items.length === 0 ? (
          <EmptyState message="No payments in this period." />
        ) : (
          <TableWrap>
            <Table>
              <thead>
                <tr>
                  <Th>Date</Th>
                  <Th>Customer</Th>
                  <Th>Method</Th>
                  <Th>Note</Th>
                  <Th>By</Th>
                  <Th align="right">Amount</Th>
                </tr>
              </thead>
              <tbody>
                {history.data.items.map((payment) => (
                  <tr key={payment.id}>
                    <Td>{displayDate(payment.paymentDate)}</Td>
                    <Td>
                      <span className="font-medium">{payment.customerName}</span>
                      <span className="ml-2 text-xs text-slate-500">{payment.customerCode}</span>
                    </Td>
                    <Td className="text-slate-600">{payment.method}</Td>
                    <Td className="text-slate-600">{payment.note}</Td>
                    <Td className="text-slate-600">{payment.createdByName ?? '—'}</Td>
                    <Td align="right" className="tnum font-medium">{rupees(payment.amount)}</Td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <Td /><Td /><Td /><Td /><Td className="text-right font-medium">Total</Td>
                  <Td align="right" className="tnum font-semibold">
                    {rupees(history.data.items.reduce((sum, p) => sum + p.amount, 0))}
                  </Td>
                </tr>
              </tfoot>
            </Table>
          </TableWrap>
        )}
      </Card>
    </div>
  );
}
