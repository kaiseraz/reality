import { api, type Mission } from '../api.ts';
import { Icon } from '../ui/Icon.tsx';

/**
 * Commands typed into a message box, like in Claude Code. A mission is not a page of its own:
 * it is the same team working through the night on one goal, started from the chat.
 */
export const COMMANDS = [
  {
    name: 'mission',
    args: '<goal>',
    label: 'Work on it overnight',
    detail: 'The team keeps going until the goal is met or 8 hours are up.',
  },
  {
    name: 'routine',
    args: '<what and when>',
    label: 'Repeat it on a schedule',
    detail: 'For example: every Monday at 8, check the new papers on lipases.',
  },
] as const;
export type CommandName = (typeof COMMANDS)[number]['name'];

/** "/mission find …" → the command and what follows; null for an ordinary message. */
export function parseCommand(text: string): { name: CommandName; rest: string } | null {
  const m = /^\/([a-z]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  const name = COMMANDS.find((c) => c.name === m?.[1])?.name;
  return name ? { name, rest: (m?.[2] ?? '').trim() } : null;
}

/** The commands that fit while the person is still typing the name, e.g. "/mi". */
export function matchingCommands(draft: string) {
  const m = /^\/([a-z]*)$/.exec(draft);
  return m ? COMMANDS.filter((c) => c.name.startsWith(m[1] ?? '')) : [];
}

/** Starts a mission for these bots and returns the chat it runs in. */
export async function startMission(goal: string, botIds: string[]): Promise<Mission> {
  if (goal.length < 5) throw new Error('Say what the mission is for: /mission <goal>.');
  return api.createMission({
    goal,
    botIds,
    criteria: [],
    hours: 8,
    maxTasks: 10,
    autoApprove: true,
    allowInstalls: [],
    allowDomains: [],
    maxRounds: 12,
  });
}

export function CommandMenu({ draft, onPick }: { draft: string; onPick: (text: string) => void }) {
  const shown = matchingCommands(draft);
  if (!shown.length) return null;
  return (
    <div className="command-menu" role="listbox" aria-label="Commands">
      {shown.map((c) => (
        <button
          key={c.name}
          type="button"
          role="option"
          aria-selected={false}
          className="command-item"
          onMouseDown={(e) => {
            // Keeps the focus in the message box.
            e.preventDefault();
            onPick(`/${c.name} `);
          }}
        >
          <Icon name={c.name === 'mission' ? 'target' : 'clock'} size={15} />
          <span className="command-name">
            /{c.name} <span className="muted">{c.args}</span>
          </span>
          <span className="command-label">
            {c.label}
            <span className="muted small"> {c.detail}</span>
          </span>
        </button>
      ))}
    </div>
  );
}
