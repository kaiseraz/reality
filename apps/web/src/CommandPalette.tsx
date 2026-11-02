import { useEffect, useMemo, useRef, useState } from 'react';
import type { TaskSummary } from '@reality/schemas';
import { Icon, type IconName } from './ui/Icon.tsx';
import { statusOf } from './ui/status.ts';

export interface Command {
  id: string;
  group: string;
  label: string;
  icon: IconName;
  run: () => void;
}

interface PaletteProps {
  onClose: () => void;
  tasks: TaskSummary[];
  actions: Command[];
  openTask: (id: string) => void;
}

/** Ctrl/Cmd+K: jump to any task or run an action without the mouse. */
export function CommandPalette({ open, ...props }: PaletteProps & { open: boolean }) {
  // Mounted only while open, so every opening starts with an empty query.
  return open ? <Palette {...props} /> : null;
}

function Palette({ onClose, tasks, actions, openTask }: PaletteProps) {
  const [q, setQ] = useState('');
  const [index, setIndex] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    input.current?.focus();
  }, []);

  const items = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const taskCommands: Command[] = tasks.slice(0, 30).map((t) => ({
      id: t.id,
      group: 'Tasks',
      label: t.request,
      icon: statusOf(t.status).tone === 'ok' ? 'check' : 'arrow',
      run: () => openTask(t.id),
    }));
    return [...actions, ...taskCommands].filter(
      (c) => !needle || c.label.toLowerCase().includes(needle),
    );
  }, [q, tasks, actions, openTask]);

  const choose = (c: Command | undefined) => {
    if (!c) return;
    onClose();
    c.run();
  };

  let lastGroup = '';
  return (
    <div className="palette-backdrop" onMouseDown={onClose}>
      <div
        className="palette"
        role="dialog"
        aria-label="Command palette"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <input
          ref={input}
          value={q}
          placeholder="Search tasks and actions…"
          aria-label="Search tasks and actions"
          onChange={(e) => {
            setQ(e.target.value);
            setIndex(0);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Escape') onClose();
            else if (e.key === 'ArrowDown') {
              e.preventDefault();
              setIndex((i) => Math.min(items.length - 1, i + 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setIndex((i) => Math.max(0, i - 1));
            } else if (e.key === 'Enter') choose(items[index]);
          }}
        />
        <ul>
          {items.length === 0 && <li className="group">Nothing found</li>}
          {items.map((c, i) => {
            const header = c.group !== lastGroup ? c.group : null;
            lastGroup = c.group;
            return (
              <li key={c.id}>
                {header && <div className="group">{header}</div>}
                <button
                  className={i === index ? 'active' : ''}
                  onMouseEnter={() => setIndex(i)}
                  onClick={() => choose(c)}
                >
                  <Icon name={c.icon} />
                  <span className="grow">{c.label}</span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
