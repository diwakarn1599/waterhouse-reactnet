import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api, qs } from '../api/client';
import { useSession } from '../state/session';
import {
  Alert, Button, Card, EmptyState, Field, Input, Select, Spinner,
  Stat, Table, TableWrap, Td, Th,
} from '../components/ui';
import { addDays, count, displayDate, endOfMonth, rupees, startOfMonth, todayIso } from '../format';
import { paymentMethods } from '../api/types';

/**
 * One parameterised report screen replacing fourteen legacy endpoints.
 *
 * The old app had a separate controller action and Blade view for each of:
 * can daily/monthly/yearly/date-range, customer monthly/yearly/date-range, and
 * expense daily/monthly/yearly - each pair duplicated again as an AJAX twin, and
 * each building its HTML by string concatenation inside a 912-line controller.
 *
 * They are all the same query with a different GROUP BY and date window, so they
 * are one screen here. Every legacy view is reachable as a preset, and
 * combinations the old app could not produce - "bag sales by customer last
 * quarter" - now come for free.
 */

type Grouping = 'day' | 'month' | 'year' | 'customer' | 'product' | 'customerType';
type CustomerType = 'all' | 'registered' | 'local';
type Dataset = 'sales' | 'expenses';

interface SalesRow {
  key: string;
  label: string;
  quantity: number;
  total: number;
  paid: number;
  balance: number;
  saleCount: number;
}

interface ExpenseRow {
  key: string;
  label: string;
  amount: number;
  entryCount: number;
}

interface Preset {
  id: string;
  label: string;
  dataset: Dataset;
  groupBy: Grouping;
  range: () => { from: string; to: string };
}

const presets: Preset[] = [
  { id: 'sales-today',      label: 'Sales — today',            dataset: 'sales',    groupBy: 'customer', range: () => ({ from: todayIso(), to: todayIso() }) },
  { id: 'sales-month-day',  label: 'Sales — this month by day', dataset: 'sales',   groupBy: 'day',      range: () => ({ from: startOfMonth(todayIso()), to: endOfMonth(todayIso()) }) },
  { id: 'sales-year-month', label: 'Sales — this year by month', dataset: 'sales',  groupBy: 'month',    range: () => ({ from: `${todayIso().slice(0, 4)}-01-01`, to: `${todayIso().slice(0, 4)}-12-31` }) },
  { id: 'sales-all-year',   label: 'Sales — all years',         dataset: 'sales',   groupBy: 'year',     range: () => ({ from: '2000-01-01', to: todayIso() }) },
  { id: 'cust-month',       label: 'Customers — this month',    dataset: 'sales',   groupBy: 'customer', range: () => ({ from: startOfMonth(todayIso()), to: endOfMonth(todayIso()) }) },
  { id: 'cust-year',        label: 'Customers — this year',     dataset: 'sales',   groupBy: 'customer', range: () => ({ from: `${todayIso().slice(0, 4)}-01-01`, to: todayIso() }) },
  { id: 'by-product',       label: 'By product — this month',   dataset: 'sales',   groupBy: 'product',  range: () => ({ from: startOfMonth(todayIso()), to: endOfMonth(todayIso()) }) },
  { id: 'exp-today',        label: 'Expenses — today',          dataset: 'expenses', groupBy: 'day',     range: () => ({ from: todayIso(), to: todayIso() }) },
  { id: 'exp-month',        label: 'Expenses — this month',     dataset: 'expenses', groupBy: 'day',     range: () => ({ from: startOfMonth(todayIso()), to: endOfMonth(todayIso()) }) },
  { id: 'exp-year',         label: 'Expenses — this year',      dataset: 'expenses', groupBy: 'month',   range: () => ({ from: `${todayIso().slice(0, 4)}-01-01`, to: `${todayIso().slice(0, 4)}-12-31` }) },
];

export function ReportsPage() {
  const { data, customers } = useSession();

  const [dataset, setDataset] = useState<Dataset>('sales');
  const [groupBy, setGroupBy] = useState<Grouping>('day');
  const [from, setFrom] = useState(startOfMonth(todayIso()));
  const [to, setTo] = useState(todayIso());
  const [productId, setProductId] = useState<number | ''>('');
  const [customerId, setCustomerId] = useState<number | ''>('');
  const [customerType, setCustomerType] = useState<CustomerType>('all');
  const [paymentMethod, setPaymentMethod] = useState('');

  const applyPreset = (preset: Preset) => {
    const range = preset.range();
    setDataset(preset.dataset);
    setGroupBy(preset.groupBy);
    setFrom(range.from);
    setTo(range.to);
  };

  const salesQuery = useQuery({
    queryKey: ['report', 'sales', { groupBy, from, to, productId, customerId, customerType, paymentMethod }],
    queryFn: () => api.get<{ rows: SalesRow[] }>(
      `/api/reports/sales${qs({ groupBy, from, to, productId, customerId, customerType, paymentMethod })}`,
    ),
    enabled: dataset === 'sales',
  });

  const expenseQuery = useQuery({
    queryKey: ['report', 'expenses', { groupBy, from, to }],
    queryFn: () => api.get<{ rows: ExpenseRow[] }>(
      `/api/reports/expenses${qs({ groupBy: groupBy === 'customer' || groupBy === 'product' ? 'day' : groupBy, from, to })}`,
    ),
    enabled: dataset === 'expenses',
  });

  const salesTotals = useMemo(() => {
    const rows = salesQuery.data?.rows ?? [];
    return {
      quantity: rows.reduce((s, r) => s + r.quantity, 0),
      total: rows.reduce((s, r) => s + r.total, 0),
      paid: rows.reduce((s, r) => s + r.paid, 0),
      balance: rows.reduce((s, r) => s + r.balance, 0),
      saleCount: rows.reduce((s, r) => s + r.saleCount, 0),
    };
  }, [salesQuery.data]);

  const expenseTotal = useMemo(
    () => (expenseQuery.data?.rows ?? []).reduce((s, r) => s + r.amount, 0),
    [expenseQuery.data],
  );

  const exportCsv = () => {
    const rows = dataset === 'sales' ? salesQuery.data?.rows ?? [] : expenseQuery.data?.rows ?? [];
    if (rows.length === 0) return;

    const header = dataset === 'sales'
      ? ['Group', 'Sales', 'Quantity', 'Total', 'Paid', 'Balance']
      : ['Group', 'Entries', 'Amount'];

    const body = rows.map((row) =>
      dataset === 'sales'
        ? [(row as SalesRow).label, (row as SalesRow).saleCount, (row as SalesRow).quantity,
           (row as SalesRow).total, (row as SalesRow).paid, (row as SalesRow).balance]
        : [(row as ExpenseRow).label, (row as ExpenseRow).entryCount, (row as ExpenseRow).amount],
    );

    const csv = [header, ...body]
      .map((line) => line.map((cell) => `"${String(cell).replace(/"/g, '""')}"`).join(','))
      .join('\n');

    const blob = new Blob([`﻿${csv}`], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${dataset}-${groupBy}-${from}-to-${to}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  const loading = dataset === 'sales' ? salesQuery.isPending : expenseQuery.isPending;
  const failed = dataset === 'sales' ? salesQuery.isError : expenseQuery.isError;

  return (
    <div className="space-y-4">
      <Card title="Reports">
        <div className="mb-4 flex flex-wrap gap-2">
          {presets.map((preset) => (
            <button
              key={preset.id}
              type="button"
              onClick={() => applyPreset(preset)}
              className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50"
            >
              {preset.label}
            </button>
          ))}
        </div>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Data">
            <Select value={dataset} onChange={(e) => setDataset(e.target.value as Dataset)}>
              <option value="sales">Sales</option>
              <option value="expenses">Expenses</option>
            </Select>
          </Field>
          <Field label="Group by">
            <Select value={groupBy} onChange={(e) => setGroupBy(e.target.value as Grouping)}>
              <option value="day">Day</option>
              <option value="month">Month</option>
              <option value="year">Year</option>
              {dataset === 'sales' && <option value="customer">Customer</option>}
              {dataset === 'sales' && <option value="customerType">Registered vs local</option>}
              {dataset === 'sales' && <option value="product">Product</option>}
            </Select>
          </Field>
          <Field label="From"><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
          <Field label="To"><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>

          {dataset === 'sales' && (
            <>
              <Field label="Paid by">
                <Select value={paymentMethod} onChange={(e) => setPaymentMethod(e.target.value)}>
                  <option value="">All methods</option>
                  {paymentMethods.map((m) => (
                    <option key={m} value={m}>{m.charAt(0) + m.slice(1).toLowerCase()}</option>
                  ))}
                </Select>
              </Field>
              <Field label="Customer type">
                <Select value={customerType} onChange={(e) => setCustomerType(e.target.value as CustomerType)}>
                  <option value="all">All sales</option>
                  <option value="registered">Registered only</option>
                  <option value="local">Local / walk-in only</option>
                </Select>
              </Field>
              <Field label="Product">
                <Select value={productId} onChange={(e) => setProductId(e.target.value ? Number(e.target.value) : '')}>
                  <option value="">All products</option>
                  {(data?.products ?? []).filter((p) => p.isSellable).map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </Select>
              </Field>
              <Field label="Customer">
                <Select value={customerId} onChange={(e) => setCustomerId(e.target.value ? Number(e.target.value) : '')}>
                  <option value="">All customers</option>
                  {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
                </Select>
              </Field>
            </>
          )}
        </div>

        <div className="mt-3 flex gap-2">
          <Button variant="secondary" type="button" onClick={() => { setFrom(addDays(todayIso(), -6)); setTo(todayIso()); }}>
            Last 7 days
          </Button>
          <Button variant="secondary" type="button" onClick={() => { setFrom(addDays(todayIso(), -29)); setTo(todayIso()); }}>
            Last 30 days
          </Button>
        </div>
      </Card>

      {loading ? (
        <Spinner />
      ) : failed ? (
        <Alert tone="error">Could not run this report.</Alert>
      ) : dataset === 'sales' ? (
        <>
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
            <Stat label="Sales" value={count(salesTotals.saleCount)} />
            <Stat label="Quantity" value={count(salesTotals.quantity)} />
            <Stat label="Total" value={rupees(salesTotals.total)} />
            <Stat label="Collected" value={rupees(salesTotals.paid)} tone="good" />
            <Stat label="Outstanding" value={rupees(salesTotals.balance)} tone={salesTotals.balance > 0 ? 'bad' : 'default'} />
          </div>

          <Card
            title={`${groupBy === 'customer' ? 'By customer' : groupBy === 'product' ? 'By product' : `By ${groupBy}`} — ${displayDate(from)} to ${displayDate(to)}`}
            actions={<Button variant="secondary" type="button" onClick={exportCsv}>Export CSV</Button>}
          >
            {(salesQuery.data?.rows.length ?? 0) === 0 ? (
              <EmptyState message="No sales in this period." />
            ) : (
              <TableWrap>
                <Table>
                  <thead>
                    <tr>
                      <Th>{groupBy === 'customer' ? 'Customer' : groupBy === 'product' ? 'Product' : 'Period'}</Th>
                      <Th align="right">Sales</Th>
                      <Th align="right">Qty</Th>
                      <Th align="right">Total</Th>
                      <Th align="right">Paid</Th>
                      <Th align="right">Balance</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {salesQuery.data!.rows.map((row) => (
                      <tr key={row.key}>
                        <Td className="font-medium">{row.label}</Td>
                        <Td align="right" className="tnum">{count(row.saleCount)}</Td>
                        <Td align="right" className="tnum">{count(row.quantity)}</Td>
                        <Td align="right" className="tnum">{rupees(row.total)}</Td>
                        <Td align="right" className="tnum">{rupees(row.paid)}</Td>
                        <Td align="right" className={`tnum ${row.balance > 0 ? 'text-red-600' : ''}`}>{rupees(row.balance)}</Td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="font-semibold">
                      <Td>Total</Td>
                      <Td align="right" className="tnum">{count(salesTotals.saleCount)}</Td>
                      <Td align="right" className="tnum">{count(salesTotals.quantity)}</Td>
                      <Td align="right" className="tnum">{rupees(salesTotals.total)}</Td>
                      <Td align="right" className="tnum">{rupees(salesTotals.paid)}</Td>
                      <Td align="right" className="tnum">{rupees(salesTotals.balance)}</Td>
                    </tr>
                  </tfoot>
                </Table>
              </TableWrap>
            )}
          </Card>
        </>
      ) : (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <Stat label="Entries" value={count((expenseQuery.data?.rows ?? []).reduce((s, r) => s + r.entryCount, 0))} />
            <Stat label="Total spent" value={rupees(expenseTotal)} tone="warn" />
          </div>

          <Card
            title={`Expenses by ${groupBy} — ${displayDate(from)} to ${displayDate(to)}`}
            actions={<Button variant="secondary" type="button" onClick={exportCsv}>Export CSV</Button>}
          >
            {(expenseQuery.data?.rows.length ?? 0) === 0 ? (
              <EmptyState message="No expenses in this period." />
            ) : (
              <TableWrap>
                <Table>
                  <thead>
                    <tr><Th>Period</Th><Th align="right">Entries</Th><Th align="right">Amount</Th></tr>
                  </thead>
                  <tbody>
                    {expenseQuery.data!.rows.map((row) => (
                      <tr key={row.key}>
                        <Td className="font-medium">{row.label}</Td>
                        <Td align="right" className="tnum">{count(row.entryCount)}</Td>
                        <Td align="right" className="tnum">{rupees(row.amount)}</Td>
                      </tr>
                    ))}
                  </tbody>
                  <tfoot>
                    <tr className="font-semibold">
                      <Td>Total</Td><Td />
                      <Td align="right" className="tnum">{rupees(expenseTotal)}</Td>
                    </tr>
                  </tfoot>
                </Table>
              </TableWrap>
            )}
          </Card>
        </>
      )}
    </div>
  );
}
