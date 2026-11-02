import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { api, type KnowledgeHit, type KnowledgeSource, type Work } from '../api.ts';
import { Icon } from '../ui/Icon.tsx';
import { relativeTime } from '../ui/status.ts';
import { citations } from '../workspace/Research.tsx';

type Adding = 'note' | 'url' | 'file';

const KIND: Record<KnowledgeSource['kind'], string> = {
  note: 'Note',
  url: 'Web page',
  file: 'File',
};

const message = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Knowledge: your own sources (notes, web pages, text files) that research steps search,
 * and a direct literature search. Everything found keeps its source and line.
 */
export function KnowledgePage() {
  const [sources, setSources] = useState<KnowledgeSource[] | null>(null);
  const [adding, setAdding] = useState<Adding>('note');
  const [name, setName] = useState('');
  const [text, setText] = useState('');
  const [url, setUrl] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [tab, setTab] = useState<'mine' | 'literature'>('mine');
  const [q, setQ] = useState('');
  const [hits, setHits] = useState<KnowledgeHit[] | null>(null);
  const [works, setWorks] = useState<Work[] | null>(null);
  const [searching, setSearching] = useState(false);

  const load = useCallback(() => {
    api
      .knowledge()
      .then(setSources)
      .catch((e: unknown) => setError(message(e)));
  }, []);
  useEffect(load, [load]);

  const add = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (adding === 'note') await api.addKnowledge({ kind: 'note', name, text });
      else if (adding === 'url') {
        await api.addKnowledge({ kind: 'url', url, ...(name.trim() ? { name } : {}) });
      } else if (file) {
        await api.addKnowledge({ kind: 'file', name: file.name, text: await file.text() });
      }
      setName('');
      setText('');
      setUrl('');
      setFile(null);
      load();
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };

  const search = async (e: FormEvent) => {
    e.preventDefault();
    if (q.trim().length < 2) return;
    setSearching(true);
    setError(null);
    try {
      if (tab === 'mine') setHits(await api.searchKnowledge(q.trim()));
      else setWorks(await api.literature(q.trim()));
    } catch (err) {
      setError(message(err));
    } finally {
      setSearching(false);
    }
  };

  const remove = async (id: string) => {
    await api.deleteKnowledge(id).catch((e: unknown) => setError(message(e)));
    load();
  };

  const canAdd =
    adding === 'note'
      ? name.trim() && text.trim()
      : adding === 'url'
        ? /^https?:\/\//i.test(url.trim())
        : file !== null;

  return (
    <div className="page">
      <header className="page-head">
        <div className="grow">
          <h1>Knowledge</h1>
          <p>
            Your own sources and the scholarly literature. Tasks without data search both and cite
            what they use; nothing here is sent to an AI model unless a task quotes it.
          </p>
        </div>
      </header>

      <form className="card knowledge-search" onSubmit={(e) => void search(e)} role="search">
        <div className="seg" role="tablist" aria-label="Where to search">
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'mine'}
            className={tab === 'mine' ? 'on' : ''}
            onClick={() => setTab('mine')}
          >
            Your sources
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === 'literature'}
            className={tab === 'literature' ? 'on' : ''}
            onClick={() => setTab('literature')}
          >
            Literature (OpenAlex)
          </button>
        </div>
        <div className="row">
          <input
            type="search"
            aria-label="Search terms"
            placeholder={
              tab === 'mine' ? 'Search your notes and pages' : 'e.g. urban heat island tree canopy'
            }
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <button type="submit" className="btn-primary" disabled={searching || q.trim().length < 2}>
            <Icon name="search" /> {searching ? 'Searching…' : 'Search'}
          </button>
        </div>
        {tab === 'mine' && hits && (
          <ol className="plain hits">
            {hits.length === 0 && <li className="muted">Nothing matches.</li>}
            {hits.map((h, i) => (
              <li key={`${h.sourceId}-${h.line}-${i}`}>
                <div className="hit-head">
                  <strong>{h.source}</strong>
                  <span className="muted">
                    line {h.line} · match {Math.round(h.score * 100)}%
                  </span>
                </div>
                <p>{h.text.length > 420 ? `${h.text.slice(0, 420)}…` : h.text}</p>
              </li>
            ))}
          </ol>
        )}
        {tab === 'literature' && works && (
          <ol className="plain hits">
            {works.length === 0 && <li className="muted">No works found.</li>}
            {works.map((w, i) => (
              <li key={`${w.doi ?? w.title}-${i}`}>
                <div className="hit-head">
                  <strong>
                    {w.url ? (
                      <a href={w.url} target="_blank" rel="noreferrer noopener">
                        {w.title}
                      </a>
                    ) : (
                      w.title
                    )}
                  </strong>
                  <span className="muted">
                    {[w.authors, w.year, w.venue, citations(w.citedBy)].filter(Boolean).join(' · ')}
                  </span>
                </div>
                {w.abstract && (
                  <p>{w.abstract.length > 420 ? `${w.abstract.slice(0, 420)}…` : w.abstract}</p>
                )}
                {w.doi && <small className="muted">DOI {w.doi}</small>}
              </li>
            ))}
          </ol>
        )}
      </form>

      <h2 className="section-h">Your sources</h2>
      <form className="card knowledge-add" onSubmit={(e) => void add(e)}>
        <div className="seg" role="tablist" aria-label="Kind of source">
          {(['note', 'url', 'file'] as const).map((k) => (
            <button
              key={k}
              type="button"
              role="tab"
              aria-selected={adding === k}
              className={adding === k ? 'on' : ''}
              onClick={() => setAdding(k)}
            >
              {KIND[k]}
            </button>
          ))}
        </div>
        {adding === 'note' && (
          <>
            <input
              aria-label="Title"
              placeholder="Title"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
            <textarea
              aria-label="Note"
              rows={4}
              placeholder="Facts, decisions, definitions, anything a task should know"
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          </>
        )}
        {adding === 'url' && (
          <div className="row">
            <input
              type="url"
              aria-label="Address"
              placeholder="https://…"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
            <input
              aria-label="Name (optional)"
              placeholder="Name (optional)"
              value={name}
              onChange={(e) => setName(e.target.value)}
            />
          </div>
        )}
        {adding === 'file' && (
          <input
            type="file"
            aria-label="Text file"
            accept=".txt,.md,.markdown,.csv,.json,.html,.htm,.xml,.tex,.bib,text/*"
            onChange={(e) => setFile(e.target.files?.[0] ?? null)}
          />
        )}
        <div>
          <button type="submit" className="btn-primary" disabled={busy || !canAdd}>
            <Icon name="plus" /> {busy ? 'Reading…' : 'Add source'}
          </button>
        </div>
      </form>
      {error && (
        <p className="callout tone-bad" role="alert" style={{ marginTop: 12 }}>
          <Icon name="alert" /> <span>{error}</span>
        </p>
      )}

      {sources && sources.length === 0 && (
        <p className="muted" style={{ marginTop: 12 }}>
          No sources yet. Add a note or a web page; research tasks will search it.
        </p>
      )}
      <ul className="plain source-list">
        {(sources ?? []).map((s) => (
          <li key={s.id} className="card">
            <Icon name={s.kind === 'url' ? 'arrow' : s.kind === 'file' ? 'file' : 'edit'} />
            <span className="grow">
              <strong>{s.name}</strong>
              <small className="muted">
                {KIND[s.kind]} · {s.passages} passages · {s.words.toLocaleString()} words ·{' '}
                {relativeTime(s.createdAt)}
                {s.error ? ` · ${s.error}` : ''}
              </small>
            </span>
            <button
              className="btn-ghost"
              onClick={() => void remove(s.id)}
              aria-label={`Remove ${s.name}`}
            >
              <Icon name="x" />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
