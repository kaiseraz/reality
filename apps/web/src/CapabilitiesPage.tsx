import { useEffect, useState } from 'react';
import { api, type CapabilityRecord } from './api.ts';
import { Icon } from './ui/Icon.tsx';
import { relativeTime } from './ui/status.ts';

const STATES = ['discovered', 'inspected', 'tested', 'enabled', 'trusted'] as const;

/** Everything Reality has acquired, with its lifecycle, tests and permissions. */
export function CapabilitiesPage() {
  const [caps, setCaps] = useState<CapabilityRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .capabilities()
      .then(setCaps)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  const usable = (caps ?? []).filter((c) => c.state === 'enabled' || c.state === 'trusted');
  const rejected = (caps ?? []).filter((c) => c.state === 'rejected');
  const uses = (caps ?? []).reduce((n, c) => n + c.uses, 0);

  return (
    <div className="page">
      <header className="page-head">
        <div className="grow">
          <h1>Capabilities</h1>
          <p>
            Tools Reality added when a task needed them. Each was inspected, approved by a person,
            installed into an isolated read-only layer and tested before first use.
          </p>
        </div>
      </header>
      {error && (
        <p className="callout tone-bad" role="alert">
          <Icon name="alert" /> <span>{error}</span>
        </p>
      )}
      {caps && (
        <div className="stat-row">
          <div className="stat">
            <div className="label">Available</div>
            <div className="value">{usable.length}</div>
          </div>
          <div className="stat">
            <div className="label">Trusted (3+ uses)</div>
            <div className="value">{caps.filter((c) => c.state === 'trusted').length}</div>
          </div>
          <div className="stat">
            <div className="label">Rejected</div>
            <div className="value">{rejected.length}</div>
          </div>
          <div className="stat">
            <div className="label">Total uses</div>
            <div className="value">{uses}</div>
          </div>
        </div>
      )}
      {caps && caps.length === 0 && (
        <div className="empty">
          <Icon name="puzzle" size={28} />
          <p>
            No capabilities yet. Ask a question that needs one, for example a seasonality analysis
            or an SQL query, and Reality proposes it for your approval.
          </p>
        </div>
      )}
      <div className="cap-grid">
        {(caps ?? []).map((c) => {
          const reached = c.state === 'rejected' ? -1 : STATES.indexOf(c.state);
          const passed = c.tests?.filter((t) => t.passed).length ?? 0;
          return (
            <article key={c.id} className="card">
              <div className="card-head">
                <Icon name={c.kind === 'mcp-server' ? 'command' : 'puzzle'} />
                <strong className="grow">{c.package}</strong>
                <span className={`badge state-${c.state}`}>{c.state}</span>
              </div>
              <p className="muted" style={{ fontSize: 13 }}>
                For “{c.need}”
              </p>
              <ol className="lifecycle" aria-label="lifecycle">
                {STATES.map((s, i) => (
                  <li key={s} className={i <= reached ? 'reached' : ''}>
                    {s}
                  </li>
                ))}
              </ol>
              <dl>
                <dt>Kind</dt>
                <dd>{c.kind === 'mcp-server' ? 'MCP server' : 'Python package'}</dd>
                <dt>Version</dt>
                <dd>{c.version ?? '—'}</dd>
                <dt>License</dt>
                <dd>{c.license ?? 'unknown'}</dd>
                <dt>Tests</dt>
                <dd>{c.tests ? `${passed}/${c.tests.length} passed` : 'not run'}</dd>
                <dt>Network</dt>
                <dd>{c.permissions.network}</dd>
                <dt>Uses</dt>
                <dd>{c.uses}</dd>
                <dt>Updated</dt>
                <dd>{relativeTime(c.updatedAt)}</dd>
              </dl>
              {c.limitations.length > 0 && (
                <details style={{ marginTop: 8, fontSize: 12 }}>
                  <summary>Limitations ({c.limitations.length})</summary>
                  <ul>
                    {c.limitations.map((l) => (
                      <li key={l}>{l}</li>
                    ))}
                  </ul>
                </details>
              )}
            </article>
          );
        })}
      </div>
    </div>
  );
}
