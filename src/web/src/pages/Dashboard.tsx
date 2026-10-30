import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { api, qs } from '../api/client';
import { paymentMethods } from '../api/types';
import {
  Alert, Badge, Card, EmptyState, Spinner, Stat, Table, TableWrap, Td, Th,
} from '../components/ui';
import { count, displayDate, rupees } from '../format';

interface SplitSide { saleCount: number; quantity: number; total: number; paid: number }
interface MethodRow { method: string; count: number; amount: number }

interface DashboardData {
  today: { saleCount: number; quantity: number; total: number; paid: number; balance: number };
  currentMonth: { quantity: number; total: number; paid: number; balance: number; expenses: number };
  previousMonth: { quantity: number; total: number; paid: number; balance: number; expenses: number };
  customerCount: number;
  totalOutstanding: number;

  payments: {
    today: { count: number; amount: number };
    month: { count: number; amount: number };
    byMethod: MethodRow[];
    recent: Array<{
      id: number; paymentDate: string; customerName: string; customerCode: string;
      amount: number; method: string;
    }>;
  };
  /** Counter takings plus balance collections — the real cash-in figure. */
  collectedToday: number;
  collectedMonth: number;

  split: {
    today: { registered: SplitSide; local: SplitSide };
    month: { registered: SplitSide; local: SplitSide };
  };
  salesByMethod: MethodRow[];

  stock: Array<{ productId: number; name: string; onHand: number }>;
  dailySales: Array<{ date: string; quantity: number; total: number }>;
  monthlySales: Array<{ month: string; quantity: number; total: number }>;
  topCustomers: Array<{ customerId: number; name: string; code: string; quantity: number; total: number }>;
  dormantCustomers: Array<{ customerId: number; name: string; code: string; lastSaleDate: string | null; balance: number }>;
}

export function DashboardPage() {
  const [paymentMethod, setPaymentMethod] = useState('');

  const query = useQuery({
    queryKey: ['dashboard', paymentMethod],
    queryFn: () => api.get<DashboardData>(`/api/dashboard${qs({ paymentMethod })}`),
  });

  const filterBar = (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-sm text-slate-500">Paid by</span>
      <button
        type="button"
        onClick={() => setPaymentMethod('')}
        className={`rounded-md border px-3 py-1.5 text-sm font-medium ${
          paymentMethod === ''
            ? 'border-teal-600 bg-teal-50 text-teal-800'
            : 'border-slate-300 bg-white text-slate-600 hover:bg-slate-50'
        }`}
      >
        All
      </button>
      {paymentMethods.map((m) => (
        <button
          key={m}
          type="button"
          onClick={() => setPaymentMethod(m)}
          className={`rounded-md border px-3 py-1.5 text-sm font-medium ${
            paymentMethod === m
              ? 'border-teal-600 bg-teal-50 text-teal-800'
              : 'border-slate-300 bg-white text-slate-600 hover:bg-slate-50'
          }`}
        >
          {titleCase(m)}
        </button>
      ))}
    </div>
  );

  if (query.isPending) return <div className="space-y-4">{filterBar}<Spinner /></div>;
  if (query.isError) {
    return <div className="space-y-4">{filterBar}<Alert tone="error">Could not load the dashboard.</Alert></div>;
  }

  const d = query.data;
  const monthDelta = d.previousMonth.total > 0
    ? ((d.currentMonth.total - d.previousMonth.total) / d.previousMonth.total) * 100
    : null;

  return (
    <div className="space-y-4">
      {filterBar}
      {paymentMethod && (
        <Alert tone="info">
          Showing only <strong>{titleCase(paymentMethod)}</strong> sales and payments. The
          by-method tables below stay unfiltered so the headline figures keep their context.
        </Alert>
      )}

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Today's sales" value={count(d.today.saleCount)} sub={`${count(d.today.quantity)} units`} />
        {/* Cash in = tendered at the counter + collected against old balances.
            Either number on its own understates the day. */}
        <Stat
          label="Cash in today"
          value={rupees(d.collectedToday)}
          tone="good"
          sub={`${rupees(d.today.paid)} at counter + ${rupees(d.payments.today.amount)} collected`}
        />
        <Stat
          label="Total outstanding"
          value={rupees(d.totalOutstanding)}
          tone={d.totalOutstanding > 0 ? 'bad' : 'default'}
          sub={`${d.customerCount} customers`}
        />
        <Stat
          label="This month"
          value={rupees(d.currentMonth.total)}
          sub={monthDelta === null
            ? 'No comparison'
            : `${monthDelta >= 0 ? '+' : ''}${monthDelta.toFixed(1)}% vs last month`}
          tone={monthDelta === null ? 'default' : monthDelta >= 0 ? 'good' : 'warn'}
        />
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Month quantity" value={count(d.currentMonth.quantity)} sub={`Last month ${count(d.previousMonth.quantity)}`} />
        <Stat label="Cash in this month" value={rupees(d.collectedMonth)} tone="good"
              sub={`${d.payments.month.count} balance payment${d.payments.month.count === 1 ? '' : 's'}`} />
        <Stat label="Month credit given" value={rupees(d.currentMonth.balance)} tone={d.currentMonth.balance > 0 ? 'warn' : 'default'} />
        <Stat label="Month expenses" value={rupees(d.currentMonth.expenses)} tone="warn" sub={`Last month ${rupees(d.previousMonth.expenses)}`} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <SplitCard title="Registered vs local — today" split={d.split.today} />
        <SplitCard title="Registered vs local — this month" split={d.split.month} />
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Payments received this month">
          {d.payments.byMethod.length === 0 ? (
            <EmptyState message="No balance payments recorded this month." />
          ) : (
            <TableWrap>
              <Table>
                <thead>
                  <tr><Th>Method</Th><Th align="right">Count</Th><Th align="right">Amount</Th></tr>
                </thead>
                <tbody>
                  {d.payments.byMethod.map((row) => (
                    <tr key={row.method}>
                      <Td className="font-medium">{titleCase(row.method)}</Td>
                      <Td align="right" className="tnum">{count(row.count)}</Td>
                      <Td align="right" className="tnum">{rupees(row.amount)}</Td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="font-semibold">
                    <Td>Total</Td>
                    <Td align="right" className="tnum">{count(d.payments.month.count)}</Td>
                    <Td align="right" className="tnum">{rupees(d.payments.month.amount)}</Td>
                  </tr>
                </tfoot>
              </Table>
            </TableWrap>
          )}
        </Card>

        <Card title="Counter takings by method this month">
          {d.salesByMethod.length === 0 ? (
            <EmptyState message="No sales this month." />
          ) : (
            <TableWrap>
              <Table>
                <thead>
                  <tr><Th>Method</Th><Th align="right">Sales</Th><Th align="right">Amount</Th></tr>
                </thead>
                <tbody>
                  {d.salesByMethod.map((row) => (
                    <tr key={row.method}>
                      <Td className="font-medium">{titleCase(row.method)}</Td>
                      <Td align="right" className="tnum">{count(row.count)}</Td>
                      <Td align="right" className="tnum">{rupees(row.amount)}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </TableWrap>
          )}
        </Card>
      </div>

      <Card title="Recent balance payments">
        {d.payments.recent.length === 0 ? (
          <EmptyState message="No payments recorded yet." />
        ) : (
          <TableWrap>
            <Table>
              <thead>
                <tr><Th>Date</Th><Th>Customer</Th><Th>Method</Th><Th align="right">Amount</Th></tr>
              </thead>
              <tbody>
                {d.payments.recent.map((p) => (
                  <tr key={p.id}>
                    <Td>{displayDate(p.paymentDate)}</Td>
                    <Td>
                      <span className="font-medium">{p.customerName}</span>
                      <span className="ml-2 text-xs text-slate-500">{p.customerCode}</span>
                    </Td>
                    <Td className="text-slate-600">{titleCase(p.method)}</Td>
                    <Td align="right" className="tnum font-medium">{rupees(p.amount)}</Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </TableWrap>
        )}
      </Card>

      {d.stock.some((s) => s.onHand < 0) && (
        <Alert tone="warn">
          Negative stock: {d.stock.filter((s) => s.onHand < 0).map((s) => `${s.name} (${s.onHand})`).join(', ')}.
          More has been sold than recorded as received.
        </Alert>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Daily sales this month">
          {d.dailySales.length === 0 ? (
            <EmptyState message="No sales yet this month." />
          ) : (
            <ResponsiveContainer width="100%" height={240}>
              <LineChart data={d.dailySales} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis dataKey="date" tickFormatter={(v: string) => v.slice(8)} fontSize={11} stroke="#94a3b8" />
                <YAxis fontSize={11} stroke="#94a3b8" width={44} />
                {/* Recharts types these callbacks loosely (ValueType / ReactNode),
                    so coerce rather than asserting a narrower signature. */}
                <Tooltip
                  formatter={(value) => [count(Number(value)), 'Quantity']}
                  labelFormatter={(label) => displayDate(String(label))}
                />
                <Line type="monotone" dataKey="quantity" stroke="#0d9488" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          )}
        </Card>

        <Card title="Monthly sales">
          {d.monthlySales.length === 0 ? (
            <EmptyState message="Not enough history yet." />
          ) : (
            <ResponsiveContainer width="100%" height={240}>
              <BarChart data={d.monthlySales} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis dataKey="month" fontSize={11} stroke="#94a3b8" />
                <YAxis fontSize={11} stroke="#94a3b8" width={44} />
                <Tooltip formatter={(value) => count(Number(value))} />
                <Bar dataKey="quantity" fill="#14b8a6" radius={[3, 3, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          )}
        </Card>
      </div>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card title="Top customers this month">
          {d.topCustomers.length === 0 ? (
            <EmptyState message="No sales yet this month." />
          ) : (
            <TableWrap>
              <Table>
                <thead>
                  <tr><Th>Customer</Th><Th align="right">Qty</Th><Th align="right">Value</Th></tr>
                </thead>
                <tbody>
                  {d.topCustomers.map((customer) => (
                    <tr key={customer.customerId}>
                      <Td>
                        <span className="font-medium">{customer.name}</span>
                        <span className="ml-2 text-xs text-slate-500">{customer.code}</span>
                      </Td>
                      <Td align="right" className="tnum">{count(customer.quantity)}</Td>
                      <Td align="right" className="tnum">{rupees(customer.total)}</Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </TableWrap>
          )}
        </Card>

        {/* Carried over from the legacy dashboard, where it was the most recent
            feature added. It is the closest thing the business has to a churn
            warning, so it stays prominent. */}
        <Card title="Not bought in 2+ days">
          {d.dormantCustomers.length === 0 ? (
            <EmptyState message="Every active customer has bought recently." />
          ) : (
            <TableWrap>
              <Table>
                <thead>
                  <tr><Th>Customer</Th><Th>Last sale</Th><Th align="right">Balance</Th></tr>
                </thead>
                <tbody>
                  {d.dormantCustomers.map((customer) => (
                    <tr key={customer.customerId}>
                      <Td>
                        <span className="font-medium">{customer.name}</span>
                        <span className="ml-2 text-xs text-slate-500">{customer.code}</span>
                      </Td>
                      <Td>
                        {customer.lastSaleDate
                          ? displayDate(customer.lastSaleDate)
                          : <Badge tone="slate">Never</Badge>}
                      </Td>
                      <Td align="right" className={`tnum ${customer.balance > 0 ? 'text-red-600' : ''}`}>
                        {customer.balance !== 0 ? rupees(customer.balance) : '—'}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </TableWrap>
          )}
        </Card>
      </div>

      <Card title="Stock on hand">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {d.stock.map((item) => (
            <Stat
              key={item.productId}
              label={item.name}
              value={count(item.onHand)}
              tone={item.onHand < 0 ? 'bad' : item.onHand === 0 ? 'warn' : 'default'}
            />
          ))}
        </div>
      </Card>
    </div>
  );
}

const titleCase = (s: string) => s.charAt(0) + s.slice(1).toLowerCase();

/**
 * Registered vs local revenue.
 *
 * The legacy app could only approximate this by excluding a hard-coded list of
 * customer ids from the daily sheet. Local is now a property of the sale, so
 * this is an exact split.
 */
function SplitCard({ title, split }: {
  title: string;
  split: { registered: SplitSide; local: SplitSide };
}) {
  const total = split.registered.total + split.local.total;
  const localShare = total > 0 ? (split.local.total / total) * 100 : 0;

  return (
    <Card title={title}>
      {total === 0 ? (
        <EmptyState message="No sales in this period." />
      ) : (
        <div className="space-y-3">
          <div className="flex h-2 overflow-hidden rounded-full bg-slate-100">
            <div className="bg-teal-600" style={{ width: `${100 - localShare}%` }} />
            <div className="bg-amber-500" style={{ width: `${localShare}%` }} />
          </div>

          <TableWrap>
            <Table>
              <thead>
                <tr><Th /><Th align="right">Sales</Th><Th align="right">Qty</Th><Th align="right">Revenue</Th><Th align="right">Share</Th></tr>
              </thead>
              <tbody>
                <tr>
                  <Td><span className="inline-block h-2 w-2 rounded-full bg-teal-600" /> <span className="font-medium">Registered</span></Td>
                  <Td align="right" className="tnum">{count(split.registered.saleCount)}</Td>
                  <Td align="right" className="tnum">{count(split.registered.quantity)}</Td>
                  <Td align="right" className="tnum">{rupees(split.registered.total)}</Td>
                  <Td align="right" className="tnum">{(100 - localShare).toFixed(1)}%</Td>
                </tr>
                <tr>
                  <Td><span className="inline-block h-2 w-2 rounded-full bg-amber-500" /> <span className="font-medium">Local / walk-in</span></Td>
                  <Td align="right" className="tnum">{count(split.local.saleCount)}</Td>
                  <Td align="right" className="tnum">{count(split.local.quantity)}</Td>
                  <Td align="right" className="tnum">{rupees(split.local.total)}</Td>
                  <Td align="right" className="tnum">{localShare.toFixed(1)}%</Td>
                </tr>
              </tbody>
              <tfoot>
                <tr className="font-semibold">
                  <Td>Total</Td>
                  <Td align="right" className="tnum">{count(split.registered.saleCount + split.local.saleCount)}</Td>
                  <Td align="right" className="tnum">{count(split.registered.quantity + split.local.quantity)}</Td>
                  <Td align="right" className="tnum">{rupees(total)}</Td>
                  <Td />
                </tr>
              </tfoot>
            </Table>
          </TableWrap>
        </div>
      )}
    </Card>
  );
}
