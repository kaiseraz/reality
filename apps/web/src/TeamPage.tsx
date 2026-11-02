import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, type Account } from './api.ts';
import { Icon } from './ui/Icon.tsx';
import { relativeTime } from './ui/status.ts';

/** Admins add accounts here; each person then sees only their own tasks. */
export function TeamPage() {
  const [users, setUsers] = useState<Account[] | null>(null);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [role, setRole] = useState<'member' | 'admin'>('member');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  const load = useCallback(() => {
    api
      .users()
      .then(setUsers)
      .catch((e: unknown) =>
        setMessage({ ok: false, text: e instanceof Error ? e.message : String(e) }),
      );
  }, []);
  useEffect(load, [load]);

  const add = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      await api.addUser(email, password, role);
      setMessage({ ok: true, text: `Account for ${email} created. Share the password safely.` });
      setEmail('');
      setPassword('');
      load();
    } catch (err) {
      setMessage({ ok: false, text: err instanceof Error ? err.message : String(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="page">
      <header className="page-head">
        <div className="grow">
          <h1>Accounts</h1>
          <p>Accounts on this Reality server. Tasks and data are private to each account.</p>
        </div>
      </header>
      <form className="card team-form" onSubmit={(e) => void add(e)}>
        <strong>Add an account</strong>
        <div className="row">
          <input
            type="email"
            required
            placeholder="E-mail"
            aria-label="E-mail"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <input
            type="password"
            required
            minLength={10}
            autoComplete="new-password"
            placeholder="Initial password (10+ characters)"
            aria-label="Initial password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <select
            aria-label="Role"
            value={role}
            onChange={(e) => setRole(e.target.value === 'admin' ? 'admin' : 'member')}
          >
            <option value="member">Member</option>
            <option value="admin">Admin</option>
          </select>
          <button type="submit" className="btn-primary" disabled={busy}>
            <Icon name="plus" /> Add
          </button>
        </div>
        {message && (
          <p className={`callout ${message.ok ? 'tone-info' : 'tone-bad'}`} role="status">
            <Icon name={message.ok ? 'check' : 'alert'} /> <span>{message.text}</span>
          </p>
        )}
      </form>
      <div className="card" style={{ marginTop: 12, padding: 0 }}>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>E-mail</th>
                <th>Role</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {(users ?? []).map((u) => (
                <tr key={u.id}>
                  <td>{u.email}</td>
                  <td>
                    <span className={`badge ${u.role === 'admin' ? 'state-enabled' : ''}`}>
                      {u.role}
                    </span>
                  </td>
                  <td>{relativeTime(u.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
