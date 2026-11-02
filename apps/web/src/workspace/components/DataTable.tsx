import { useEffect, useState } from 'react';
import { api, type RowsPage } from '../../api.ts';
import type { RendererProps } from '../context.ts';

/**
 * Server-paged, server-sorted table. Paging and sorting are local view state (queries,
 * not actions): they change what is shown, never the task or workspace.
 */
export function DataTable({ instance }: RendererProps) {
  const binding = instance.bindings.rows;
  const pageSize = typeof instance.props.pageSize === 'number' ? instance.props.pageSize : 50;
  const [offset, setOffset] = useState(0);
  const [sort, setSort] = useState<{ column: string; desc: boolean } | null>(null);
  const [page, setPage] = useState<RowsPage | null>(null);
  const [error, setError] = useState<string | null>(null);

  const artifactId = binding?.kind === 'artifact' ? binding.artifact.id : null;
  useEffect(() => {
    if (!artifactId) return;
    let cancelled = false;
    api
      .rows(artifactId, {
        offset,
        limit: pageSize,
        ...(sort ? { sort: sort.column, desc: sort.desc } : {}),
      })
      .then((p) => !cancelled && setPage(p))
      .catch((e: unknown) => !cancelled && setError(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
  }, [artifactId, offset, pageSize, sort]);

  if (!artifactId) return <p className="muted pad">No dataset bound.</p>;
  if (error)
    return (
      <p role="alert" className="pad">
        {error}
      </p>
    );
  if (!page) return <p className="muted pad">Loading data…</p>;

  const toggleSort = (column: string) => {
    setOffset(0);
    setSort((s) => (s?.column === column ? { column, desc: !s.desc } : { column, desc: false }));
  };
  const last = Math.min(page.offset + page.rows.length, page.total);

  return (
    <div className="table-wrap">
      <table>
        <thead>
          <tr>
            {page.columns.map((c) => (
              <th key={c.name} className={c.type}>
                <button data-local="sort" onClick={() => toggleSort(c.name)} title={`${c.type}`}>
                  {c.name}
                  {sort?.column === c.name ? (sort.desc ? ' ▼' : ' ▲') : ''}
                </button>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {page.rows.map((row, i) => (
            <tr key={page.offset + i}>
              {page.columns.map((c) => (
                <td
                  key={c.name}
                  className={c.type}
                  title={typeof row[c.name] === 'number' ? String(row[c.name]) : undefined}
                >
                  {row[c.name] === null ? (
                    <span className="muted">—</span>
                  ) : (
                    formatCell(row[c.name])
                  )}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      <div className="row pad">
        <button
          data-local="page"
          disabled={offset === 0}
          onClick={() => setOffset(Math.max(0, offset - pageSize))}
        >
          Previous
        </button>
        <span data-testid="range">
          {page.offset + 1}–{last} of {page.total}
        </span>
        <button
          data-local="page"
          disabled={last >= page.total}
          onClick={() => setOffset(offset + pageSize)}
        >
          Next
        </button>
      </div>
    </div>
  );
}

/**
 * Display only: readable decimals (4 below 100, else 2), which also hides binary
 * floating-point noise (180332.88999999998). The full value is in the cell's tooltip.
 */
export function formatCell(v: unknown): string {
  if (typeof v !== 'number' || Number.isInteger(v)) return String(v);
  const digits = Math.abs(v) >= 100 ? 2 : 4;
  const rounded = Number(v.toFixed(digits));
  return rounded === 0 && v !== 0 ? String(Number(v.toPrecision(3))) : String(rounded);
}
