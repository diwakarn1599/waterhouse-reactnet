import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../api/client';
import { useSession } from '../state/session';
import {
  Alert, Badge, Button, Card, Field, Input, Select, Spinner,
  Table, TableWrap, Td, Th,
} from '../components/ui';
import { displayDateTime } from '../format';

interface AdminUser {
  id: number;
  username: string;
  displayName: string;
  email: string;
  role: 'admin' | 'operator';
  isActive: boolean;
  canSignIn: boolean;
  lastLoginAt: string | null;
}

export function AdminPage() {
  const [tab, setTab] = useState<'users' | 'rates' | 'branch' | 'backup'>('users');

  return (
    <div className="space-y-4">
      <div className="flex gap-2">
        {([['users', 'Users'], ['rates', 'Local rates'], ['branch', 'Branch details'], ['backup', 'Backup']] as const).map(([value, label]) => (
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
        ))}
      </div>

      {tab === 'users' && <UsersTab />}
      {tab === 'rates' && <LocalRatesTab />}
      {tab === 'branch' && <BranchTab />}
      {tab === 'backup' && <BackupTab />}
    </div>
  );
}

interface LocalRateProduct {
  productId: number;
  code: string;
  name: string;
  rates: number[];
}

/**
 * The rate buttons the counter sees in Local / walk-in mode.
 *
 * These were originally derived from sales history so they would need no
 * configuration. That was unpredictable in practice - a single local sale at one
 * rate collapsed the whole button set to that rate - and a POS has to show the
 * same buttons every time. They are explicit now.
 */
function LocalRatesTab() {
  const { refresh } = useSession();
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ['admin', 'local-rates'],
    queryFn: () => api.get<LocalRateProduct[]>('/api/admin/local-rates'),
  });

  return (
    <div className="space-y-4">
      <Alert tone="info">
        These appear as one-tap rate buttons on the Sell screen when
        <strong> Local / walk-in </strong> is selected. They do not affect registered
        customers, who use their own agreed rate.
      </Alert>

      {query.isPending ? (
        <Spinner />
      ) : query.isError ? (
        <Alert tone="error">Could not load local rates.</Alert>
      ) : (
        query.data.map((product) => (
          <RateEditor
            key={product.productId}
            product={product}
            onSaved={() => {
              void queryClient.invalidateQueries({ queryKey: ['admin', 'local-rates'] });
              // The POS reads these from the bootstrap payload, so it has to be
              // refetched or the counter keeps the old buttons until reload.
              void refresh();
            }}
          />
        ))
      )}
    </div>
  );
}

function RateEditor({ product, onSaved }: { product: LocalRateProduct; onSaved: () => void }) {
  const [rates, setRates] = useState<string[]>(
    product.rates.length > 0 ? product.rates.map(String) : ['', '', ''],
  );
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});

  const save = useMutation({
    mutationFn: () =>
      api.put(`/api/admin/local-rates/${product.productId}`, {
        rates: rates.map((r) => Number(r)).filter((r) => r > 0),
      }),
    onSuccess: () => { setFieldErrors({}); onSaved(); },
    onError: (error) => { if (error instanceof ApiError) setFieldErrors(error.fieldErrors); },
  });

  const parsed = rates.map((r) => Number(r)).filter((r) => r > 0);
  const unique = new Set(parsed).size === parsed.length;

  const setAt = (index: number, value: string) =>
    setRates((prev) => prev.map((r, i) => (i === index ? value : r)));

  return (
    <Card
      title={product.name}
      actions={
        <Button
          variant="secondary"
          type="button"
          onClick={() => setRates((prev) => [...prev, ''])}
          disabled={rates.length >= 8}
        >
          Add rate
        </Button>
      }
    >
      <div className="space-y-3">
        <div className="grid gap-3 sm:grid-cols-4">
          {rates.map((rate, index) => (
            <Field key={index} label={`Button ${index + 1}`}>
              <div className="flex gap-1">
                <Input
                  value={rate}
                  onChange={(e) => setAt(index, e.target.value)}
                  inputMode="decimal"
                  placeholder="0.00"
                  className="tnum"
                />
                {rates.length > 1 && (
                  <button
                    type="button"
                    onClick={() => setRates((prev) => prev.filter((_, i) => i !== index))}
                    className="rounded-md border border-slate-300 px-2 text-slate-400 hover:bg-red-50 hover:text-red-600"
                    aria-label={`Remove button ${index + 1}`}
                  >
                    ×
                  </button>
                )}
              </div>
            </Field>
          ))}
        </div>

        {parsed.length > 0 && (
          <div>
            <span className="mb-1 block text-xs uppercase tracking-wide text-slate-500">Preview</span>
            <div className="flex flex-wrap gap-2">
              {[...parsed].sort((a, b) => a - b).map((r) => (
                <span key={r} className="tnum rounded-md border border-slate-300 bg-white px-4 py-2 text-base font-semibold">
                  ₹{r}
                </span>
              ))}
            </div>
          </div>
        )}

        {!unique && <Alert tone="warn">Duplicate rates will be merged into one button.</Alert>}
        {fieldErrors.rates?.[0] && <Alert tone="error">{fieldErrors.rates[0]}</Alert>}
        {save.isSuccess && <Alert tone="success">Saved. The Sell screen now shows these buttons.</Alert>}

        <Button type="button" disabled={save.isPending || parsed.length === 0} onClick={() => save.mutate()}>
          {save.isPending ? 'Saving…' : 'Save rates'}
        </Button>
      </div>
    </Card>
  );
}

function UsersTab() {
  const queryClient = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [passwordFor, setPasswordFor] = useState<AdminUser | null>(null);

  const users = useQuery({
    queryKey: ['admin', 'users'],
    queryFn: () => api.get<AdminUser[]>('/api/admin/users'),
  });

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['admin', 'users'] });

  return (
    <div className="space-y-4">
      <Card
        title="Users"
        actions={<Button type="button" onClick={() => setCreating(true)}>Add user</Button>}
      >
        {users.isPending ? (
          <Spinner />
        ) : users.isError ? (
          <Alert tone="error">Could not load users.</Alert>
        ) : (
          <>
            {users.data.some((u) => !u.canSignIn) && (
              <Alert tone="warn">
                Some accounts have no password and cannot sign in. These came across from the
                legacy database, whose password hashes are in a format this application does not
                implement. Set a password to enable each account.
              </Alert>
            )}
            <TableWrap>
              <Table>
                <thead>
                  <tr>
                    <Th>Username</Th><Th>Name</Th><Th>Role</Th><Th>Status</Th><Th>Last sign-in</Th><Th />
                  </tr>
                </thead>
                <tbody>
                  {users.data.map((user) => (
                    <tr key={user.id}>
                      <Td className="font-mono text-xs">{user.username}</Td>
                      <Td className="font-medium">{user.displayName}</Td>
                      <Td><Badge tone={user.role === 'admin' ? 'green' : 'slate'}>{user.role}</Badge></Td>
                      <Td>
                        {!user.isActive
                          ? <Badge tone="slate">Inactive</Badge>
                          : user.canSignIn
                            ? <Badge tone="green">Active</Badge>
                            : <Badge tone="amber">No password</Badge>}
                      </Td>
                      <Td className="text-slate-600">{user.lastLoginAt ? displayDateTime(user.lastLoginAt) : '—'}</Td>
                      <Td align="right">
                        <Button variant="ghost" type="button" onClick={() => setPasswordFor(user)}>
                          Set password
                        </Button>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </Table>
            </TableWrap>
          </>
        )}
      </Card>

      {creating && <CreateUser onDone={() => { setCreating(false); invalidate(); }} onCancel={() => setCreating(false)} />}
      {passwordFor && (
        <SetPassword user={passwordFor} onDone={() => { setPasswordFor(null); invalidate(); }} onCancel={() => setPasswordFor(null)} />
      )}
    </div>
  );
}

function CreateUser({ onDone, onCancel }: { onDone: () => void; onCancel: () => void }) {
  const [username, setUsername] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [role, setRole] = useState<'admin' | 'operator'>('operator');
  const [password, setPassword] = useState('');
  const [fieldErrors, setFieldErrors] = useState<Record<string, string[]>>({});

  const create = useMutation({
    mutationFn: () => api.post('/api/admin/users', { username: username.trim(), displayName: displayName.trim(), role, password }),
    onSuccess: onDone,
    onError: (error) => { if (error instanceof ApiError) setFieldErrors(error.fieldErrors); },
  });

  return (
    <Card title="New user" actions={<Button variant="secondary" type="button" onClick={onCancel}>Close</Button>}>
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Username" error={fieldErrors.username?.[0]}>
          <Input value={username} onChange={(e) => setUsername(e.target.value)} autoFocus />
        </Field>
        <Field label="Display name" error={fieldErrors.displayName?.[0]}>
          <Input value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        </Field>
        <Field label="Role">
          <Select value={role} onChange={(e) => setRole(e.target.value as 'admin' | 'operator')}>
            <option value="operator">Operator</option>
            <option value="admin">Administrator</option>
          </Select>
        </Field>
        <Field label="Password" error={fieldErrors.password?.[0]} hint="At least 8 characters.">
          <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
      </div>
      {create.isError && !Object.keys(fieldErrors).length && <Alert tone="error">Could not create this user.</Alert>}
      <div className="mt-3">
        <Button
          type="button"
          disabled={create.isPending || !username.trim() || password.length < 8}
          onClick={() => create.mutate()}
        >
          {create.isPending ? 'Creating…' : 'Create user'}
        </Button>
      </div>
    </Card>
  );
}

function SetPassword({ user, onDone, onCancel }: { user: AdminUser; onDone: () => void; onCancel: () => void }) {
  const [password, setPassword] = useState('');
  const save = useMutation({
    mutationFn: () => api.post(`/api/admin/users/${user.id}/password`, { newPassword: password }),
    onSuccess: onDone,
  });

  return (
    <Card title={`Set password for ${user.displayName}`} actions={<Button variant="secondary" type="button" onClick={onCancel}>Close</Button>}>
      <div className="max-w-sm space-y-3">
        <Field label="New password" hint="At least 8 characters.">
          <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoFocus />
        </Field>
        {save.isError && <Alert tone="error">Could not set the password.</Alert>}
        <Button type="button" disabled={save.isPending || password.length < 8} onClick={() => save.mutate()}>
          {save.isPending ? 'Saving…' : 'Set password'}
        </Button>
      </div>
    </Card>
  );
}

function BranchTab() {
  const { data, refresh } = useSession();
  const [form, setForm] = useState({
    name: data?.branch.name ?? '',
    address: data?.branch.address ?? '',
    phone: data?.branch.phone ?? '',
    gstin: data?.branch.gstin ?? '',
    receiptFooter: data?.branch.receiptFooter ?? '',
  });

  const save = useMutation({
    mutationFn: () => api.put('/api/admin/branch', form),
    onSuccess: () => void refresh(),
  });

  const set = (key: keyof typeof form, value: string) => setForm((f) => ({ ...f, [key]: value }));

  return (
    <Card title="Branch details">
      <p className="mb-4 text-sm text-slate-600">
        These appear on every printed receipt.
      </p>
      <div className="grid max-w-3xl gap-3 sm:grid-cols-2">
        <Field label="Business name"><Input value={form.name} onChange={(e) => set('name', e.target.value)} /></Field>
        <Field label="Phone"><Input value={form.phone} onChange={(e) => set('phone', e.target.value)} /></Field>
        <Field label="Address"><Input value={form.address} onChange={(e) => set('address', e.target.value)} /></Field>
        <Field label="GSTIN"><Input value={form.gstin} onChange={(e) => set('gstin', e.target.value)} /></Field>
        <Field label="Receipt footer"><Input value={form.receiptFooter} onChange={(e) => set('receiptFooter', e.target.value)} /></Field>
      </div>
      {save.isSuccess && <div className="mt-3"><Alert tone="success">Saved.</Alert></div>}
      {save.isError && <div className="mt-3"><Alert tone="error">Could not save.</Alert></div>}
      <div className="mt-3">
        <Button type="button" disabled={save.isPending} onClick={() => save.mutate()}>
          {save.isPending ? 'Saving…' : 'Save'}
        </Button>
      </div>
    </Card>
  );
}

function BackupTab() {
  const status = useQuery({
    queryKey: ['admin', 'backup'],
    queryFn: () => api.get<{ databaseSizeBytes: number; lastBackupAt: string | null; walSizeBytes: number }>('/api/admin/backup/status'),
  });

  const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

  return (
    <div className="space-y-4">
      <Card title="Backup">
        {status.isPending ? (
          <Spinner />
        ) : status.isError ? (
          <Alert tone="error">Could not read backup status.</Alert>
        ) : (
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-3">
              <div>
                <div className="text-xs uppercase tracking-wide text-slate-500">Database size</div>
                <div className="tnum font-medium">{mb(status.data.databaseSizeBytes)}</div>
              </div>
              <div>
                <div className="text-xs uppercase tracking-wide text-slate-500">Write-ahead log</div>
                <div className="tnum font-medium">{mb(status.data.walSizeBytes)}</div>
              </div>
              <div>
                <div className="text-xs uppercase tracking-wide text-slate-500">Last download</div>
                <div className="font-medium">
                  {status.data.lastBackupAt ? displayDateTime(status.data.lastBackupAt) : 'Never'}
                </div>
              </div>
            </div>

            <Alert tone="info">
              This downloads a consistent snapshot taken with SQLite's online backup API, so it is
              safe to run while the till is in use. It is a manual copy, not your backup strategy —
              continuous replication should be configured on the server (see docs/DEPLOYMENT.md).
            </Alert>

            <a
              href="/api/admin/backup/download"
              className="inline-flex items-center gap-2 rounded-md bg-teal-700 px-4 py-2 text-sm font-medium text-white hover:bg-teal-800"
            >
              Download a snapshot
            </a>
          </div>
        )}
      </Card>

      <Card title="Restoring">
        <ol className="list-decimal space-y-1 pl-5 text-sm text-slate-600">
          <li>Stop the service: <code className="rounded bg-slate-100 px-1">systemctl stop waterhouse</code></li>
          <li>Replace <code className="rounded bg-slate-100 px-1">data/waterhouse.db</code> with the snapshot.</li>
          <li>Delete any leftover <code className="rounded bg-slate-100 px-1">-wal</code> and <code className="rounded bg-slate-100 px-1">-shm</code> files beside it.</li>
          <li>Start the service again.</li>
        </ol>
        <p className="mt-3 text-sm text-slate-600">
          Test this on a copy once a quarter. An untested backup is not a backup.
        </p>
      </Card>
    </div>
  );
}
