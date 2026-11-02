import { useEffect, useState } from 'react';
import { api, type CapabilityRecord } from '../../api.ts';
import { useWorkspace, type RendererProps } from '../context.ts';

const STATES = ['discovered', 'inspected', 'tested', 'enabled', 'trusted'] as const;

/** Lifecycle, provenance and tests of the capabilities this task acquired or reused. */
export function CapabilityCard(_props: RendererProps) {
  const { events } = useWorkspace();
  const [all, setAll] = useState<CapabilityRecord[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const capabilityEvents = events.filter((e) => e.type.startsWith('capability.'));
  const ids = new Set(
    capabilityEvents
      .map((e) => (e.payload as { capabilityId?: string }).capabilityId)
      .filter((id): id is string => typeof id === 'string'),
  );
  const discovered = capabilityEvents.find((e) => e.type === 'capability.discovered');

  useEffect(() => {
    let cancelled = false;
    api
      .capabilities()
      .then((c) => !cancelled && setAll(c))
      .catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
  }, [capabilityEvents.length]);

  if (error)
    return (
      <p role="alert" className="pad">
        {error}
      </p>
    );
  const mine = (all ?? []).filter((c) => ids.has(c.id));

  return (
    <div className="pad capabilities">
      {discovered && (
        <p className="muted">
          Searched the allowlisted catalog for “{(discovered.payload as { need: string }).need}”:{' '}
          {(
            discovered.payload as { candidates: { package: string; eligible: boolean }[] }
          ).candidates
            .map((c) => `${c.package}${c.eligible ? '' : ' (ineligible)'}`)
            .join(', ')}
          .
        </p>
      )}
      {mine.length === 0 && <p className="muted">Looking for a suitable capability…</p>}
      {mine.map((c) => {
        const reached = c.state === 'rejected' ? -1 : STATES.indexOf(c.state);
        return (
          <section key={c.id} className="capability">
            <h4>
              {c.package} {c.version} <span className={`badge state-${c.state}`}>{c.state}</span>
            </h4>
            <ol className="lifecycle" aria-label="lifecycle">
              {STATES.map((s, i) => (
                <li key={s} className={i <= reached ? 'reached' : ''}>
                  {s}
                </li>
              ))}
            </ol>
            <p className="muted">
              {c.license} · used {c.uses}× · network {c.permissions.network}, mounted{' '}
              {c.permissions.mount} at <code>{c.permissions.path}</code>
            </p>
            {c.tests?.map((t) => (
              <p key={t.name}>
                <span className={`badge ${t.passed ? 'passed' : 'failed'}`}>
                  {t.passed ? 'test passed' : 'test failed'}
                </span>{' '}
                {t.description}
              </p>
            ))}
            {c.kind === 'mcp-server' && <McpTools tests={c.tests} />}
            <details>
              <summary>History ({c.history.length})</summary>
              <ul>
                {c.history.map((h) => (
                  <li key={h.at + h.to + h.reason}>
                    <time>{new Date(h.at).toLocaleTimeString()}</time> {h.from ?? '—'} → {h.to}:{' '}
                    {h.reason}
                  </li>
                ))}
              </ul>
            </details>
          </section>
        );
      })}
    </div>
  );
}

/** Tools the MCP server reported during its requirement test. Server text is untrusted. */
function McpTools({ tests }: { tests: CapabilityRecord['tests'] }) {
  const tools =
    (tests?.[0]?.result as { tools?: { name: string; description: string }[] } | null)?.tools ?? [];
  if (tools.length === 0) return null;
  return (
    <details>
      <summary>Tools offered by the server ({tools.length})</summary>
      <p className="muted">
        Descriptions come from the server itself and are shown as unverified text. Reality calls
        only the approved tools.
      </p>
      <ul>
        {tools.map((t) => (
          <li key={t.name}>
            <code>{t.name}</code> <span className="muted">{t.description.slice(0, 300)}</span>
          </li>
        ))}
      </ul>
    </details>
  );
}
