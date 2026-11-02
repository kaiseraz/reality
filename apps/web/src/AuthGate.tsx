import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, type Me } from './api.ts';
import { App } from './App.tsx';
import { BrandMark, Icon } from './ui/Icon.tsx';
import { useTheme } from './ui/hooks.ts';

/** Shows sign-in (or first-run setup) when accounts are on; otherwise the app directly. */
export function AuthGate() {
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string | null>(null);
  useTheme(); // applies the saved theme on the sign-in screen too

  const load = useCallback(() => {
    api
      .me()
      .then((m) => {
        setMe(m);
        setError(null);
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  useEffect(() => {
    load();
    // Any 401 (expired session) brings the sign-in screen back.
    window.addEventListener('reality-unauthenticated', load);
    return () => window.removeEventListener('reality-unauthenticated', load);
  }, [load]);

  if (!me) {
    return (
      <div className="auth-screen">
        <div className="auth-card">
          <BrandMark className="auth-mark" />
          {error ? (
            <p className="callout tone-bad" role="alert">
              <Icon name="alert" /> <span>Server unreachable: {error}</span>
            </p>
          ) : (
            <p className="muted">Loading…</p>
          )}
        </div>
      </div>
    );
  }
  if (me.authEnabled && !me.user) return <SignIn setup={me.setupRequired} onDone={load} />;
  return (
    <App
      user={me.user}
      onLogout={me.authEnabled ? () => void api.logout().then(load) : undefined}
    />
  );
}

function SignIn({ setup, onDone }: { setup: boolean; onDone: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (setup) await api.setup(email, password);
      else await api.login(email, password);
      onDone();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-screen">
      <form className="auth-card" onSubmit={(e) => void submit(e)}>
        <BrandMark className="auth-mark" />
        <h1>{setup ? 'Welcome to Reality' : 'Sign in to Reality'}</h1>
        <p className="muted">
          {setup
            ? 'Create the first account. It becomes the administrator and can invite others.'
            : 'Your tasks, data and results are private to your account.'}
        </p>
        <label>
          E-mail
          <input
            type="email"
            autoComplete="username"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </label>
        <label>
          Password
          <input
            type="password"
            autoComplete={setup ? 'new-password' : 'current-password'}
            required
            minLength={setup ? 10 : 1}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        {setup && <span className="hint">At least 10 characters.</span>}
        {error && (
          <p className="callout tone-bad" role="alert">
            <Icon name="alert" /> <span>{error}</span>
          </p>
        )}
        <button type="submit" className="btn-primary btn-lg" disabled={busy}>
          <Icon name={setup ? 'user' : 'lock'} />
          {busy ? 'Please wait…' : setup ? 'Create account' : 'Sign in'}
        </button>
      </form>
    </div>
  );
}
