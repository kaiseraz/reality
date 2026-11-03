import { useState, type ReactNode } from 'react';
import { Icon } from '../ui/Icon.tsx';

/** A folder and what is in it, built from the flat list of paths the project folder reports. */
export interface TreeNode<T> {
  name: string;
  path: string;
  file?: T;
  children: TreeNode<T>[];
}

/** Folders first, then files, each by name; "results/pcb_design/board.kicad_pcb" nests twice. */
export function buildTree<T extends { path: string }>(files: T[]): TreeNode<T>[] {
  const root: TreeNode<T> = { name: '', path: '', children: [] };
  for (const f of files) {
    const parts = f.path.split(/[\\/]/).filter(Boolean);
    let at = root;
    parts.forEach((part, i) => {
      const path = parts.slice(0, i + 1).join('/');
      let next = at.children.find((c) => c.name === part && !c.file);
      if (i === parts.length - 1) {
        at.children.push({ name: part, path, file: f, children: [] });
        return;
      }
      if (!next) {
        next = { name: part, path, children: [] };
        at.children.push(next);
      }
      at = next;
    });
  }
  const sort = (nodes: TreeNode<T>[]) => {
    nodes.sort((a, b) =>
      Boolean(a.file) === Boolean(b.file) ? a.name.localeCompare(b.name) : a.file ? 1 : -1,
    );
    for (const n of nodes) sort(n.children);
  };
  sort(root.children);
  return root.children;
}

/** Folders open and close; each file row gets what the caller puts beside it (size, state). */
export function FileTree<T extends { path: string }>({
  files,
  aside,
  title,
}: {
  files: T[];
  aside: (file: T) => ReactNode;
  title?: (file: T) => string;
}) {
  const [closed, setClosed] = useState<Set<string>>(new Set());
  const toggle = (path: string) =>
    setClosed((c) => {
      const next = new Set(c);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  const rows = (nodes: TreeNode<T>[]): ReactNode =>
    nodes.map((n) =>
      n.file ? (
        <li key={n.path} className="tree-file" title={title?.(n.file) ?? n.path} role="treeitem">
          <Icon name="file" size={14} />
          <span className="tree-name">{n.name}</span>
          {aside(n.file)}
        </li>
      ) : (
        <li
          key={n.path}
          className="tree-folder"
          role="treeitem"
          aria-expanded={!closed.has(n.path)}
        >
          <button type="button" className="tree-row" onClick={() => toggle(n.path)}>
            <Icon
              name="chevron"
              size={12}
              className={`tree-chevron ${closed.has(n.path) ? '' : 'open'}`}
            />
            <Icon name={closed.has(n.path) ? 'folder' : 'folder-open'} size={14} />
            <span className="tree-name">{n.name}</span>
          </button>
          {!closed.has(n.path) && (
            <ul className="tree-children" role="group">
              {rows(n.children)}
            </ul>
          )}
        </li>
      ),
    );
  return (
    <ul className="file-tree" role="tree">
      {rows(buildTree(files))}
    </ul>
  );
}
