import { useCallback, useEffect, useMemo, useState } from 'react';
import { api, type PageDetail, type PageVersionInfo } from '../api.ts';
import { Icon } from '../ui/Icon.tsx';
import { relativeTime } from '../ui/status.ts';
import { lineDiff } from './diff.ts';
import { Markdown } from './markdown.tsx';

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/** One page: read, edit (as a new version), and compare or restore any earlier version. */
export function DocPage({
  id,
  openTask,
  onRemoved,
}: {
  id: string;
  openTask: (taskId: string) => void;
  onRemoved: () => void;
}) {
  const [page, setPage] = useState<PageDetail | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [change, setChange] = useState('');
  const [selected, setSelected] = useState<(PageVersionInfo & { content: string }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(() => {
    api
      .page(id)
      .then((p) => {
        setPage(p);
        setError(null);
      })
      .catch((e: unknown) => setError(message(e)));
  }, [id]);
  useEffect(load, [load]);

  const diff = useMemo(
    () => (selected && page ? lineDiff(selected.content, page.content) : null),
    [selected, page],
  );

  if (!page) {
    return (
      <div className="page">
        <p className={error ? 'bad' : 'muted'}>{error ?? 'Loading…'}</p>
      </div>
    );
  }

  const save = async () => {
    setBusy(true);
    setError(null);
    try {
      const saved = await api.savePage(page.id, {
        content: draft,
        change: change.trim() || 'Edited',
        baseVersion: page.version,
      });
      setPage(saved);
      setEditing(false);
      setChange('');
    } catch (err) {
      // A 409 means someone (or a routine) saved meanwhile: keep the draft, show the reason.
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };

  const restore = async (version: number) => {
    setBusy(true);
    try {
      setPage(await api.restorePage(page.id, version));
      setSelected(null);
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (!window.confirm(`Delete “${page.title}” with all ${page.versions.length} versions?`))
      return;
    await api.deletePage(page.id).catch((e: unknown) => setError(message(e)));
    onRemoved();
  };

  return (
    <div className="page doc-page">
      <header className="page-head">
        <div className="grow">
          <h1>{page.title}</h1>
          <p>
            Version {page.version} · {page.author}: {page.change} · {relativeTime(page.updatedAt)}
          </p>
        </div>
        {!editing && (
          <button
            className="btn-ghost"
            title="Save as PDF: the browser's print dialog, with only the document"
            onClick={() => {
              // The file is named after the page; the print styles leave only the document.
              const before = document.title;
              document.title = page.title;
              window.print();
              document.title = before;
            }}
          >
            <Icon name="file" /> PDF
          </button>
        )}
        {!editing && (
          <button
            onClick={() => {
              setDraft(page.content);
              setEditing(true);
              setSelected(null);
            }}
          >
            <Icon name="edit" /> Edit
          </button>
        )}
        <button className="btn-ghost" onClick={() => void remove()} aria-label="Delete page">
          <Icon name="x" />
        </button>
      </header>

      {error && (
        <p className="callout tone-bad" role="alert">
          <Icon name="alert" /> <span>{error}</span>
          {editing && (
            <button className="btn-ghost" onClick={load}>
              Load the newer version
            </button>
          )}
        </p>
      )}

      <div className="doc-layout">
        <div className="doc-main card">
          {editing ? (
            <div className="doc-editor">
              <textarea
                aria-label="Page content (Markdown)"
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                rows={22}
              />
              <div className="row">
                <input
                  className="grow"
                  aria-label="What did you change?"
                  placeholder="What did you change? (optional)"
                  value={change}
                  onChange={(e) => setChange(e.target.value)}
                />
                <button onClick={() => setEditing(false)} disabled={busy}>
                  Cancel
                </button>
                <button className="btn-primary" onClick={() => void save()} disabled={busy}>
                  Save as version {page.version + 1}
                </button>
              </div>
            </div>
          ) : selected && diff ? (
            <div>
              <div className="row doc-compare-head">
                <strong className="grow">
                  Version {selected.version} → current ({page.version})
                </strong>
                <button
                  className="btn-primary"
                  onClick={() => void restore(selected.version)}
                  disabled={busy || selected.version === page.version}
                >
                  <Icon name="undo" /> Restore version {selected.version}
                </button>
                <button className="btn-ghost" onClick={() => setSelected(null)}>
                  Close
                </button>
              </div>
              <pre className="diff" aria-label="Changes">
                {diff.map((l, i) => (
                  <div key={i} className={`diff-${l.kind}`}>
                    {l.kind === 'add' ? '+ ' : l.kind === 'del' ? '− ' : '  '}
                    {l.text}
                  </div>
                ))}
              </pre>
            </div>
          ) : page.content.trim() ? (
            <Markdown text={page.content} />
          ) : (
            <p className="muted">Empty page. Edit it, or let a routine add its results here.</p>
          )}
        </div>

        <aside className="doc-versions" aria-label="Versions">
          <h2 className="section-h">Versions</h2>
          <ol className="plain">
            {page.versions.map((v) => (
              <li key={v.version}>
                <button
                  className={`version ${selected?.version === v.version ? 'on' : ''}`}
                  onClick={() =>
                    void api
                      .pageVersion(page.id, v.version)
                      .then((full) => {
                        setSelected(full);
                        setEditing(false);
                      })
                      .catch((e: unknown) => setError(message(e)))
                  }
                >
                  <strong>
                    v{v.version}
                    {v.version === page.version ? ' · current' : ''}
                  </strong>
                  <span>
                    {v.author}: {v.change}
                  </span>
                  <small className="muted">{relativeTime(v.createdAt)}</small>
                </button>
                {v.taskId && (
                  <button className="link" onClick={() => openTask(v.taskId ?? '')}>
                    from task
                  </button>
                )}
              </li>
            ))}
          </ol>
        </aside>
      </div>
    </div>
  );
}
