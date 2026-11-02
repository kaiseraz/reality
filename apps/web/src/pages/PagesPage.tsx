import { useEffect, useState, type FormEvent } from 'react';
import { api, type PageSummary } from '../api.ts';
import { Icon } from '../ui/Icon.tsx';
import { relativeTime } from '../ui/status.ts';

/** All pages: reports and documents written by you, your bots and your routines. */
export function PagesPage({ openPage }: { openPage: (id: string) => void }) {
  const [pages, setPages] = useState<PageSummary[] | null>(null);
  const [title, setTitle] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .pages()
      .then(setPages)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  }, []);

  const create = async (e: FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    try {
      const page = await api.createPage(title.trim(), `# ${title.trim()}\n`);
      openPage(page.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  };

  return (
    <div className="page">
      <header className="page-head">
        <div className="grow">
          <h1>Pages</h1>
          <p>
            Reports and notes that you, your bots and your routines write together. Every change is
            kept as a version, so anything can be compared and taken back.
          </p>
        </div>
      </header>
      <form className="card row" onSubmit={(e) => void create(e)}>
        <input
          className="grow"
          aria-label="Title of the new page"
          placeholder="Title of a new page, e.g. Weekly sales report"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
        />
        <button type="submit" className="btn-primary" disabled={!title.trim()}>
          <Icon name="plus" /> New page
        </button>
      </form>
      {error && (
        <p className="callout tone-bad" role="alert" style={{ marginTop: 12 }}>
          <Icon name="alert" /> <span>{error}</span>
        </p>
      )}
      {pages && pages.length === 0 && (
        <p className="muted" style={{ marginTop: 12 }}>
          No pages yet. Create one, or save a task result as a page from its conversation.
        </p>
      )}
      <ul className="plain source-list">
        {(pages ?? []).map((p) => (
          <li key={p.id} className="card clickable">
            <button className="page-row" onClick={() => openPage(p.id)}>
              <Icon name="file" />
              <span className="grow">
                <strong>{p.title}</strong>
                <small className="muted">
                  Version {p.version} · {p.author}: {p.change} · {relativeTime(p.updatedAt)}
                </small>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
