import { useState } from 'react';
import { useSession } from '../state/session';
import { ApiError } from '../api/client';
import { Alert, Button, Field, Input } from '../components/ui';

export function LoginPage() {
  const { signIn } = useSession();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await signIn(username.trim(), password);
    } catch (signInError) {
      if (signInError instanceof ApiError) {
        setError(
          signInError.isOffline
            ? 'Cannot reach the server. Check the network connection.'
            : signInError.status === 429
              ? 'Too many attempts. Wait a few minutes and try again.'
              : signInError.message,
        );
      } else {
        setError('Sign-in failed.');
      }
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-full items-center justify-center px-4 py-12">
      <form onSubmit={submit} className="w-full max-w-sm space-y-4 rounded-lg border border-slate-200 bg-white p-6 shadow-sm">
        <div>
          <h1 className="text-lg font-semibold text-slate-800">Waterhouse</h1>
          <p className="text-sm text-slate-500">Sign in to open the till.</p>
        </div>

        {error && <Alert tone="error">{error}</Alert>}

        <Field label="Username">
          <Input
            value={username}
            onChange={(e) => setUsername(e.target.value)}
            autoComplete="username"
            autoFocus
            required
          />
        </Field>

        <Field label="Password">
          <Input
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />
        </Field>

        <Button type="submit" disabled={busy} className="w-full">
          {busy ? 'Signing in…' : 'Sign in'}
        </Button>
      </form>
    </div>
  );
}
