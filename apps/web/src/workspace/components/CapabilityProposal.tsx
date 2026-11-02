interface Candidate {
  package: string;
  version: string | null;
  license: string | null;
  released: string | null;
  score: number;
  eligible: boolean;
  reasons: string[];
  fitNote: string;
}

interface Wheel {
  name: string;
  version: string | null;
  license: string;
  sizeBytes: number;
  nativeLibs: number;
}

export interface Proposal {
  capabilityId: string;
  need: string;
  package: string;
  version: string;
  fitNote: string;
  candidates: Candidate[];
  wheels: Wheel[];
  alreadyInBase: string[];
  totalNewBytes: number;
  vulnerabilities: { package: string; ids: string[] }[] | 'unknown';
  flags: string[];
  permissions: { network: string; filesystem: string; mountedAt: string };
  test: { name: string; description: string } | null;
  kind?: 'python-package' | 'mcp-server';
  mcp?: { allowedTools: string[]; launch: string; note: string };
}

const mb = (b: number) => `${(b / 1e6).toFixed(1)} MB`;

/** The full inspection report a human sees before any third-party code is installed. */
export function CapabilityProposalView({ proposal: p }: { proposal: Proposal }) {
  const vulns =
    p.vulnerabilities === 'unknown'
      ? 'unknown (database unreachable)'
      : p.vulnerabilities.some((v) => v.ids.length > 0)
        ? p.vulnerabilities
            .filter((v) => v.ids.length > 0)
            .map((v) => `${v.package}: ${v.ids.join(', ')}`)
            .join('; ')
        : `none known (OSV, ${p.vulnerabilities.length} packages checked)`;
  return (
    <div className="proposal">
      <p>
        <strong>
          Install capability: {p.package} {p.version}
        </strong>{' '}
        for “{p.need}”.
      </p>
      <p className="muted">{p.fitNote}</p>
      <h5>Candidates compared</h5>
      <table>
        <thead>
          <tr>
            <th>Package</th>
            <th>Version</th>
            <th>License</th>
            <th>Released</th>
            <th>Score</th>
          </tr>
        </thead>
        <tbody>
          {p.candidates.map((c) => (
            <tr key={c.package} className={c.package === p.package ? 'chosen' : ''}>
              <td title={c.fitNote}>
                {c.package === p.package ? '▶ ' : ''}
                {c.package}
              </td>
              <td>{c.version ?? '—'}</td>
              <td>{c.license ?? '—'}</td>
              <td>{c.released?.slice(0, 10) ?? '—'}</td>
              <td>{c.eligible ? c.score.toFixed(2) : `ineligible: ${c.reasons.join('; ')}`}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h5>
        New packages ({p.wheels.length}, {mb(p.totalNewBytes)})
      </h5>
      <ul>
        {p.wheels.map((w) => (
          <li key={w.name}>
            {w.name} {w.version} · {w.license} · {mb(w.sizeBytes)}
            {w.nativeLibs > 0 && <small className="muted"> · native code</small>}
          </li>
        ))}
      </ul>
      {p.alreadyInBase.length > 0 && (
        <p className="muted">
          Already in the sandbox, not reinstalled: {p.alreadyInBase.join(', ')}
        </p>
      )}
      <p>
        <strong>Known vulnerabilities:</strong> {vulns}
      </p>
      {p.flags.length > 0 && (
        <>
          <h5>Findings</h5>
          <ul>
            {p.flags.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
        </>
      )}
      <p>
        <strong>Permissions:</strong> network {p.permissions.network}, {p.permissions.filesystem} at{' '}
        <code>{p.permissions.mountedAt}</code>, only inside the sandbox.
      </p>
      {p.mcp && (
        <div className="mcp-box">
          <p>
            <strong>MCP server.</strong> {p.mcp.note}
          </p>
          <p>
            Allowed tools:{' '}
            {p.mcp.allowedTools.map((t) => (
              <code key={t}>{t}</code>
            ))}
            . Any other tool the server offers will not be called.
          </p>
          <details>
            <summary>Launch configuration (reviewed)</summary>
            <pre>{p.mcp.launch}</pre>
          </details>
        </div>
      )}
      {p.test && (
        <p>
          <strong>Requirement test before use:</strong> {p.test.description}
        </p>
      )}
    </div>
  );
}
