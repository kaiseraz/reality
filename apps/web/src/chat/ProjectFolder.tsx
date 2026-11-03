import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { api, type FolderListing, type FolderStatus } from '../api.ts';
import { Icon } from '../ui/Icon.tsx';
import { FileTree } from './FileTree.tsx';

const nameOf = (path: string) => path.split(/[\\/]/).filter(Boolean).pop() ?? path;
const sizeOf = (bytes: number) =>
  bytes < 1024 * 1024
    ? `${Math.max(1, Math.round(bytes / 1024))} KB`
    : `${(bytes / 1024 / 1024).toFixed(1)} MB`;

/** The chat's folder in its header: a click opens it, or chooses one while there is none. */
export function FolderChip({
  chatId,
  path,
  onChange,
}: {
  chatId: string;
  path: string | null;
  onChange: () => void;
}) {
  const [picking, setPicking] = useState(false);
  return (
    <span className="folder-chip">
      <button
        type="button"
        className="btn-ghost small"
        title={path ?? 'Choose where this work is saved on your computer'}
        onClick={() =>
          path ? void api.openChatFolder(chatId).catch(() => setPicking(true)) : setPicking(true)
        }
      >
        <Icon name="folder" size={14} /> {path ? nameOf(path) : 'Choose folder'}
      </button>
      {picking && (
        <FolderPicker
          chatId={chatId}
          start={path}
          onClose={() => setPicking(false)}
          onChosen={() => {
            setPicking(false);
            onChange();
          }}
        />
      )}
    </span>
  );
}

/** A browser cannot hand over a real path, so Reality shows this computer's folders itself. */
function FolderPicker({
  chatId,
  start,
  onClose,
  onChosen,
}: {
  chatId: string;
  start: string | null;
  onClose: () => void;
  onChosen: () => void;
}) {
  const [at, setAt] = useState<string | undefined>(start ?? undefined);
  const [list, setList] = useState<FolderListing | null>(null);
  const [fresh, setFresh] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    api
      .folders(at)
      .then((l) => {
        if (live) setList(l);
      })
      .catch((e: unknown) => {
        if (live) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      live = false;
    };
  }, [at]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const separator = list?.path.includes('\\') ? '\\' : '/';
  const choose = () => {
    if (!list) return;
    const base = list.path.replace(/[\\/]+$/, '');
    const path = fresh.trim() ? `${base}${separator}${fresh.trim()}` : list.path;
    setError(null);
    api
      .setChatFolder(chatId, path)
      .then(onChosen)
      .catch((e: unknown) => setError(e instanceof Error ? e.message : String(e)));
  };

  // On the page itself: the panels it opens from clip what is inside them.
  return createPortal(
    <div className="folder-overlay" role="dialog" aria-label="Choose a folder">
      <div className="folder-dialog">
        <h2>Where should this work be saved?</h2>
        <p className="muted small">
          Reality copies finished files here. Files you changed are never overwritten, and nothing
          here is deleted. Bots cannot see this folder.
        </p>
        <div className="folder-roots">
          {list?.roots.map((r) => (
            <button
              key={r.path}
              type="button"
              className="btn-ghost small"
              onClick={() => setAt(r.path)}
            >
              {r.name}
            </button>
          ))}
        </div>
        <div className="folder-path">
          <button
            type="button"
            className="btn-ghost small"
            disabled={!list?.parent}
            onClick={() => list?.parent && setAt(list.parent)}
            aria-label="Up one folder"
          >
            ↑
          </button>
          <code title={list?.path}>{list?.path ?? '…'}</code>
        </div>
        <ul className="folder-list">
          {list?.dirs.map((d) => (
            <li key={d}>
              <button
                type="button"
                onClick={() => {
                  if (list) setAt(`${list.path.replace(/[\\/]+$/, '')}${separator}${d}`);
                }}
              >
                <Icon name="folder" size={14} /> {d}
              </button>
            </li>
          ))}
          {list && list.dirs.length === 0 && <li className="muted small">No folders here.</li>}
        </ul>
        <label className="folder-new">
          <span className="small">New folder here (optional)</span>
          <input value={fresh} maxLength={80} onChange={(e) => setFresh(e.target.value)} />
        </label>
        {error && (
          <p className="callout tone-bad" role="alert">
            {error}
          </p>
        )}
        <div className="folder-actions">
          <button type="button" className="btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn-primary" disabled={!list} onClick={choose}>
            Use this folder
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}

const STATE: Record<FolderStatus['files'][number]['state'], string> = {
  copied: '',
  'beside-yours': 'You changed the original; this is the new version beside it',
  'too-big': 'Too big to copy',
  waiting: 'Waiting: the file is in use',
};

/** What is in the project, and what has arrived on the person's computer. */
export function FilesPanel({ chatId, onChange }: { chatId: string; onChange: () => void }) {
  const [status, setStatus] = useState<FolderStatus | null>(null);
  const [picking, setPicking] = useState(false);
  useEffect(() => {
    let live = true;
    const load = () =>
      api
        .chatFolder(chatId)
        .then((s) => {
          if (live) setStatus(s);
        })
        .catch(() => undefined);
    void load();
    const t = setInterval(() => void load(), 4000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, [chatId]);
  if (!status) return null;
  return (
    <div className="files-panel">
      <p className="muted small" title={status.path ?? undefined}>
        {status.path ? `Saved in ${status.path}` : 'No folder yet.'}
      </p>
      <div className="files-actions">
        {status.path && (
          <button
            type="button"
            className="btn-ghost small"
            onClick={() => void api.openChatFolder(chatId).catch(() => undefined)}
          >
            <Icon name="folder" size={14} /> Open folder
          </button>
        )}
        <button type="button" className="btn-ghost small" onClick={() => setPicking(true)}>
          Change folder
        </button>
      </div>
      {picking && (
        <FolderPicker
          chatId={chatId}
          start={status.path}
          onClose={() => setPicking(false)}
          onChosen={() => {
            setPicking(false);
            onChange();
          }}
        />
      )}
      {status.files.length === 0 ? (
        <p className="muted">Nothing here yet. Finished work appears as the bots make it.</p>
      ) : (
        <FileTree
          files={status.files}
          title={(f) => STATE[f.state] || f.path}
          aside={(f) => (
            <>
              {STATE[f.state] && <span className="pc-needs">{STATE[f.state]}</span>}
              <span className="muted small tree-size">{sizeOf(f.size)}</span>
            </>
          )}
        />
      )}
    </div>
  );
}
