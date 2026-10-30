import { useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../api/client';
import type { Customer } from '../api/types';
import { useSession } from '../state/session';
import {
  Alert, Badge, Button, Card, EmptyState, Field, Input, Spinner,
  Table, TableWrap, Td, Th,
} from '../components/ui';
import { rupees } from '../format';

interface CustomerForm {
  id?: number;
  name: string;
  companyName: string;
  phone: string;
  address: string;
  isActive: boolean;
  rates: Record<string, string>;
}

const blankForm = (): CustomerForm => ({
  name: '', companyName: '', phone: '', address: '', isActive: true, rates: {},
});

export function CustomersPage() {
  const { data, customers, refresh, user } = useSession();
  const [search, setSearch] = useState('');
  const [editing, setEditing] = useState<CustomerForm | null>(null);
  const [showInactive, setShowInactive] = useState(false);

  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return customers;
    return customers.filter(
      (c) =>
        c.name.toLowerCase().includes(term) ||
        c.code.toLowerCase().includes(term) ||
        c.phone.includes(term) ||
        c.companyName.toLowerCase().includes(term),
    );
  }, [customers, search]);

  const toForm = (customer: Customer): CustomerForm => ({
    id: customer.id,
    name: customer.name,
    companyName: customer.companyName,
    phone: customer.phone,
    address: '',
    isActive: true,
    rates: Object.fromEntries(Object.entries(customer.rates).map(([k, v]) => [k, String(v)])),
  });

  if (!data) return <Spinner />;

  return (
    <div className="space-y-4">
      <Card
        title={`Customers (${filtered.length})`}
        actions={<Button type="button" onClick={() => setEditing(blankForm())}>Add customer</Button>}
      >
        <div className="mb-3 flex flex-wrap items-end gap-3">
          <div className="min-w-[240px] flex-1">
            <Field label="Search">
              <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Name, code or phone" />
            </Field>
          </div>
          <label className="flex items-center gap-2 pb-2 text-sm text-slate-600">
            <input type="checkbox" checked={showInactive} onChange={(e) => setShowInactive(e.target.checked)} />
            Show inactive
          </label>
        </div>

        {filtered.length === 0 ? (
          <EmptyState message="No customers match that search." />
        ) : (
          <TableWrap>
            <Table>
              <thead>
                <tr>
                  <Th>Code</Th>
                  <Th>Name</Th>
                  <Th>Company</Th>
                  <Th>Phone</Th>
                  {data.products.filter((p) => p.isSellable).map((p) => (
                    <Th key={p.id} align="right">{p.name} rate</Th>
                  ))}
                  <Th align="right">Balance</Th>
                  <Th />
                </tr>
              </thead>
              <tbody>
                {filtered.map((customer) => (
                  <tr key={customer.id}>
                    <Td className="font-mono text-xs">{customer.code}</Td>
                    <Td className="font-medium">{customer.name}</Td>
                    <Td className="text-slate-600">{customer.companyName}</Td>
                    <Td className="text-slate-600">{customer.phone}</Td>
                    {data.products.filter((p) => p.isSellable).map((p) => (
                      <Td key={p.id} align="right" className="tnum">
                        {customer.rates[String(p.id)] !== undefined
                          ? rupees(customer.rates[String(p.id)]!)
                          : <span className="text-slate-400">—</span>}
                      </Td>
                    ))}
                    <Td align="right" className={`tnum ${customer.balance > 0 ? 'text-red-600 font-medium' : ''}`}>
                      {customer.balance !== 0 ? rupees(customer.balance) : <span className="text-slate-400">—</span>}
                    </Td>
                    <Td align="right">
                      <Button variant="ghost" type="button" onClick={() => setEditing(toForm(customer))}>Edit</Button>
                    </Td>
                  </tr>
                ))}
              </tbody>
            </Table>
          </TableWrap>
        )}
      </Card>

      {editing && (
        <CustomerEditor
          form={editing}
          canEditRates={user?.role === 'admin'}
          onClose={() => setEditing(null)}
          onSaved={() => { setEditing(null); void refresh(); }}
        />
      )}
    </div>
  );
}

function CustomerEditor({
  form: initial, canEditRates, onClose, onSaved,
}: {
  form: CustomerForm;
  canEditRates: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const { data } = useSession();
  const queryClient = useQueryClient();
  const [form, setForm] = useState(initial);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});

  const save = useMutation({
    mutationFn: async () => {
      const body = {
        name: form.name.trim(),
        companyName: form.companyName.trim(),
        phone: form.phone.trim(),
        address: form.address.trim(),
        isActive: form.isActive,
        rates: Object.entries(form.rates)
          .filter(([, value]) => value !== '' && !Number.isNaN(Number(value)))
          .map(([productId, value]) => ({ productId: Number(productId), rate: Number(value) })),
      };
      return form.id
        ? api.put(`/api/customers/${form.id}`, body)
        : api.post('/api/customers', body);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['customers'] });
      onSaved();
    },
    onError: (error) => {
      if (error instanceof ApiError) setFieldErrors(error.fieldErrors);
    },
  });

  const set = <K extends keyof CustomerForm>(key: K, value: CustomerForm[K]) =>
    setForm((f) => ({ ...f, [key]: value }));

  const errorFor = (field: string) => fieldErrors[field]?.[0];

  return (
    <Card
      title={form.id ? `Edit ${form.name}` : 'New customer'}
      actions={<Button variant="secondary" type="button" onClick={onClose}>Close</Button>}
    >
      <div className="space-y-4">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Name" error={errorFor('name')}>
            <Input value={form.name} onChange={(e) => set('name', e.target.value)} autoFocus />
          </Field>
          <Field label="Company" error={errorFor('companyName')}>
            <Input value={form.companyName} onChange={(e) => set('companyName', e.target.value)} />
          </Field>
          <Field label="Phone" error={errorFor('phone')}>
            <Input value={form.phone} onChange={(e) => set('phone', e.target.value)} />
          </Field>
          <Field label="Address" error={errorFor('address')}>
            <Input value={form.address} onChange={(e) => set('address', e.target.value)} />
          </Field>
        </div>

        <div>
          <h3 className="mb-2 text-sm font-medium text-slate-700">Agreed rates</h3>
          {!canEditRates && (
            <Alert tone="info">Only an administrator can change agreed rates.</Alert>
          )}
          <div className="mt-2 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {(data?.products ?? []).filter((p) => p.isSellable).map((product) => (
              <Field
                key={product.id}
                label={product.name}
                hint={`Default ${rupees(product.defaultRate)}`}
              >
                <Input
                  value={form.rates[String(product.id)] ?? ''}
                  onChange={(e) => set('rates', { ...form.rates, [String(product.id)]: e.target.value })}
                  inputMode="decimal"
                  placeholder="Use default"
                  disabled={!canEditRates}
                  className="tnum"
                />
              </Field>
            ))}
          </div>
        </div>

        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input type="checkbox" checked={form.isActive} onChange={(e) => set('isActive', e.target.checked)} />
          Active
          {!form.isActive && <Badge tone="slate">Hidden from the till</Badge>}
        </label>

        {save.isError && !Object.keys(fieldErrors).length && (
          <Alert tone="error">
            {save.error instanceof ApiError ? save.error.message : 'Could not save this customer.'}
          </Alert>
        )}

        <div className="flex gap-2">
          <Button type="button" disabled={save.isPending || !form.name.trim()} onClick={() => save.mutate()}>
            {save.isPending ? 'Saving…' : 'Save'}
          </Button>
          <Button variant="secondary" type="button" onClick={onClose}>Cancel</Button>
        </div>
      </div>
    </Card>
  );
}
