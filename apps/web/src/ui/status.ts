import type { TaskStatus } from '@reality/schemas';

export type Tone = 'ok' | 'warn' | 'bad' | 'info' | 'brand' | 'neutral';

export const STATUS: Record<TaskStatus, { label: string; tone: Tone; live?: boolean }> = {
  draft: { label: 'Draft', tone: 'neutral' },
  planning: { label: 'Planning', tone: 'brand', live: true },
  awaiting_approval: { label: 'Needs approval', tone: 'warn' },
  running: { label: 'Running', tone: 'info', live: true },
  completed: { label: 'Completed', tone: 'ok' },
  rejected: { label: 'Rejected', tone: 'neutral' },
  failed: { label: 'Failed', tone: 'bad' },
  budget_exceeded: { label: 'Budget exceeded', tone: 'bad' },
};

export function statusOf(s: string) {
  return STATUS[s as TaskStatus] ?? { label: s, tone: 'neutral' as Tone };
}

/** "just now", "5 min ago", "3 h ago", "2 d ago", or a date. */
export function relativeTime(iso: string, now = Date.now()): string {
  const s = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (s < 45) return 'just now';
  if (s < 3600) return `${Math.round(s / 60)} min ago`;
  if (s < 86_400) return `${Math.round(s / 3600)} h ago`;
  if (s < 7 * 86_400) return `${Math.round(s / 86_400)} d ago`;
  return new Date(iso).toLocaleDateString();
}
