import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError, qs } from '../api/client';
import {
  Alert, Button, Card, EmptyState, Field, Input, Select, Spinner,
  Stat, Table, TableWrap, Td, Th,
} from '../components/ui';
import { displayDate, rupees, startOfMonth, todayIso } from '../format';

interface ExpenseRow {
  id: number;
  expenseDate: string;
  categoryId: number | null;
  categoryName: string | null;
  description: string;
  amount: number;
  note: string;
}

interface Category { id: number; name: string }

export function ExpensesPage() {
  const queryClient = useQueryClient();
  const [from, setFrom] = useState(startOfMonth(todayIso()));
  const [to, setTo] = useState(todayIso());
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<ExpenseRow | null>(null);

  const categories = useQuery({
    queryKey: ['expense-categories'],
    queryFn: () => api.get<Category[]>('/api/expenses/categories'),
  });

  const list = useQuery({
    queryKey: ['expenses', { from, to, search }],
    queryFn: () => api.get<{ items: ExpenseRow[]; total: number; totalAmount: number }>(
      `/api/expenses${qs({ from, to, search, pageSize: 200 })}`,
    ),
  });

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['expenses'] });

  return (
    <div className="space-y-4">
      <div className="grid gap-4 lg:grid-cols-[380px_1fr]">
        <ExpenseForm
          key={editing?.id ?? 'new'}
          expense={editing}
          categories={categories.data ?? []}
          onSaved={() => { setEditing(null); invalidate(); }}
          onCancel={() => setEditing(null)}
        />

        <div className="space-y-4">
          <Card title="Filters">
            <div className="grid gap-3 sm:grid-cols-3">
              <Field label="From"><Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></Field>
              <Field label="To"><Input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></Field>
              <Field label="Search"><Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Description" /></Field>
            </div>
          </Card>

          {list.data && (
            <div className="grid gap-3 sm:grid-cols-2">
              <Stat label="Entries" value={list.data.total} />
              <Stat label="Total spent" value={rupees(list.data.totalAmount)} tone="warn" />
            </div>
          )}
        </div>
      </div>

      <Card title="Expenses">
        {list.isPending ? (
          <Spinner />
        ) : list.isError ? (
          <Alert tone="error">Could not load expenses.</Alert>
        ) : list.data.items.length === 0 ? (
          <EmptyState message="No expenses in this period." />
        ) : (
          <TableWrap>
            <Table>
              <thead>
                <tr>
                  <Th>Date</Th><Th>Description</Th><Th>Category</Th><Th>Note</Th>
                  <Th align="right">Amount</Th><Th />
                </tr>
              </thead>
              <tbody>
                {list.data.items.map((expense) => (
                  <tr key={expense.id}>
                    <Td>{displayDate(expense.expenseDate)}</Td>
                    <Td className="font-medium">{expense.description}</Td>
                    <Td className="text-slate-600">{expense.categoryName ?? '—'}</Td>
                    <Td className="text-slate-600">{expense.note}</Td>
                    <Td align="right" className="tnum font-medium">{rupees(expense.amount)}</Td>
                    <Td align="right">
                      <Button variant="ghost" type="button" onClick={() => setEditing(expense)}>Edit</Button>
                    </Td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr>
                  <Td /><Td /><Td /><Td className="text-right font-medium">Total</Td>
                  <Td align="right" className="tnum font-semibold">{rupees(list.data.totalAmount)}</Td>
                  <Td />
                </tr>
              </tfoot>
            </Table>
          </TableWrap>
        )}
      </Card>
    </div>
  );
}

function ExpenseForm({
  expense, categories, onSaved, onCancel,
}: {
  expense: ExpenseRow | null;
  categories: Category[];
  onSaved: () => void;
  onCancel: () => void;
}) {
  const [expenseDate, setExpenseDate] = useState(expense?.expenseDate ?? todayIso());
  const [description, setDescription] = useState(expense?.description ?? '');
  const [categoryId, setCategoryId] = useState<number | ''>(expense?.categoryId ?? '');
  const [amount, setAmount] = useState(expense ? String(expense.amount) : '');
  const [note, setNote] = useState(expense?.note ?? '');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});

  const save = useMutation({
    mutationFn: () => {
      const body = {
        expenseDate,
        description: description.trim(),
        categoryId: categoryId === '' ? null : Number(categoryId),
        amount: Number(amount),
        note: note.trim(),
      };
      return expense ? api.put(`/api/expenses/${expense.id}`, body) : api.post('/api/expenses', body);
    },
    onSuccess: () => {
      if (!expense) { setDescription(''); setAmount(''); setNote(''); }
      setFieldErrors({});
      onSaved();
    },
    onError: (error) => { if (error instanceof ApiError) setFieldErrors(error.fieldErrors); },
  });

  const errorFor = (field: string) => fieldErrors[field]?.[0];

  return (
    <Card title={expense ? 'Edit expense' : 'Add expense'}>
      <div className="space-y-3">
        <Field label="Date" error={errorFor('expenseDate')}>
          <Input type="date" value={expenseDate} max={todayIso()} onChange={(e) => setExpenseDate(e.target.value)} />
        </Field>
        <Field label="Description" error={errorFor('description')}>
          <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Diesel, salary, repair" />
        </Field>
        <Field label="Category" hint="Optional. Imported expenses have none.">
          <Select value={categoryId} onChange={(e) => setCategoryId(e.target.value ? Number(e.target.value) : '')}>
            <option value="">Uncategorised</option>
            {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
          </Select>
        </Field>
        <Field label="Amount" error={errorFor('amount')}>
          <Input value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" className="tnum text-lg" />
        </Field>
        <Field label="Note (optional)">
          <Input value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>

        {save.isError && !Object.keys(fieldErrors).length && <Alert tone="error">Could not save this expense.</Alert>}

        <div className="flex gap-2">
          <Button
            type="button"
            disabled={save.isPending || !description.trim() || Number(amount) <= 0}
            onClick={() => save.mutate()}
          >
            {save.isPending ? 'Saving…' : expense ? 'Update' : 'Add'}
          </Button>
          {expense && <Button variant="secondary" type="button" onClick={onCancel}>Cancel</Button>}
        </div>
      </div>
    </Card>
  );
}
