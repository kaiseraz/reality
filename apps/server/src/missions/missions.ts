import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import { z } from 'zod';
import type { BotService } from '../bots/bots.ts';
import type { ChatStore } from '../chat/store.ts';
import type { UsageLedger } from '../llm/usage.ts';
import type { CheckResult, StepResult } from '../orchestrator/graph.ts';
import type { PageStore } from '../pages/pages.ts';
import type { TaskService } from '../tasks/task-service.ts';
import {
  checkCriterion,
  Criterion,
  evidenceFrom,
  unbackedNumbers,
  verdictOf,
  type CriterionResult,
  type Evidence,
  type Verdict,
} from '../verification/criteria.ts';

/**
 * Research missions (adapted from Astra's overnight assignments): say the goal and how
 * success is measured in the evening, read the report in the morning. A team works on it in
 * a chat within a budget of hours, tasks and model cost (credits), in rounds led by the lead.
 * What may happen without asking is set at the start (libraries to install, sites to visit);
 * anything else waits for the morning without holding up the rest. Evidence comes only from
 * Reality tasks whose independent checks passed, and the verdict is computed here: a bot that
 * reports success while a criterion is missed closes the mission as failed, and both are
 * recorded.
 */

export const CreateMissionRequest = z.object({
  goal: z.string().trim().min(5).max(4000),
  botIds: z.array(z.uuid()).min(1).max(6),
  criteria: z.array(Criterion).max(10).default([]),
  hours: z.number().min(0.05).max(24).default(8),
  maxTasks: z.number().int().min(1).max(50).default(10),
  autoApprove: z.boolean().default(true),
  /** Most the mission may spend on model calls, in the configured unit; none: no limit. */
  costBudget: z.number().positive().max(1_000_000).optional(),
  /** Libraries it may install without asking (package names), after inspection passes. */
  allowInstalls: z.array(z.string().trim().min(1).max(100)).max(50).default([]),
  /** Sites the bots' computers may visit without asking (domains, subdomains included). */
  allowDomains: z.array(z.string().trim().min(1).max(253)).max(50).default([]),
  /** How many rounds of plan, work and review the lead may run. */
  maxRounds: z.number().int().min(1).max(100).default(12),
});
export type CreateMissionRequest = z.infer<typeof CreateMissionRequest>;

export type MissionStatus =
  'running' | 'finished' | 'failed' | 'stopped' | 'timeout' | 'out_of_budget';

/** Why a mission closes. */
export type CloseKind = 'done' | 'timeout' | 'stopped' | 'stalled' | 'budget';

/** Share of the cost budget after which the team is told to wrap up. */
export const WARN_AT = 0.8;

export interface MissionView {
  id: string;
  chatId: string;
  goal: string;
  status: MissionStatus;
  verdict: Verdict | null;
  summary: string | null;
  reportPageId: string | null;
  hours: number;
  maxTasks: number;
  autoApprove: boolean;
  startedAt: string;
  endsAt: string;
  finishedAt: string | null;
  tasksUsed: number;
  /** Cost budget in costUnit, or null for none. */
  costBudget: number | null;
  /** What has been spent so far, in costUnit. */
  spent: number;
  costUnit: string;
  allowInstalls: string[];
  allowDomains: string[];
  rounds: number;
  maxRounds: number;
  /** Decisions waiting for the user: plans or installs outside the frame, questions. */
  openDecisions: string[];
  criteria: CriterionResult[];
  liveVerdict: Verdict;
  journal: { text: string; at: string }[];
}

interface MissionRow {
  id: string;
  owner_id: string | null;
  chat_id: string;
  goal: string;
  criteria: Criterion[];
  hours: string;
  max_tasks: number;
  auto_approve: boolean;
  status: MissionStatus;
  verdict: Verdict | null;
  summary: string | null;
  report_page_id: string | null;
  started_at: Date;
  ends_at: Date;
  finished_at: Date | null;
  cost_budget: string | null;
  allow_installs: string[];
  allow_domains: string[];
  warned: boolean;
  rounds: number;
  max_rounds: number;
}

export class MissionService {
  constructor(
    private readonly deps: {
      pool: pg.Pool;
      store: ChatStore;
      tasks: TaskService;
      pages: PageStore;
      bots: BotService;
      /** Counts model use; without it, cost budgets are not enforced. */
      usage?: UsageLedger;
      now?: () => Date;
    },
  ) {}

  private now() {
    return this.deps.now?.() ?? new Date();
  }

  async create(ownerId: string | null, req: CreateMissionRequest): Promise<MissionView> {
    const names: string[] = [];
    for (const id of req.botIds) names.push((await this.deps.bots.get(id))?.name ?? 'Bot');
    const chat = await this.deps.store.create(
      ownerId,
      'group',
      `Mission: ${req.goal.replace(/\s+/g, ' ').slice(0, 60)}`,
      [...new Set(req.botIds)],
    );
    const id = randomUUID();
    const ends = new Date(this.now().getTime() + req.hours * 3_600_000);
    await this.deps.pool.query(
      `INSERT INTO missions (id, owner_id, chat_id, goal, criteria, hours, max_tasks, auto_approve, status, ends_at,
                             cost_budget, allow_installs, allow_domains, max_rounds)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, 'running', $9, $10, $11, $12, $13)`,
      [
        id,
        ownerId,
        chat.id,
        req.goal,
        JSON.stringify(req.criteria),
        req.hours,
        req.maxTasks,
        req.autoApprove,
        ends,
        req.costBudget ?? null,
        JSON.stringify(req.allowInstalls.map((p) => p.toLowerCase())),
        JSON.stringify(req.allowDomains.map((d) => d.toLowerCase().replace(/^\*\./, ''))),
        req.maxRounds,
      ],
    );
    await this.deps.store.add(chat.id, {
      role: 'system',
      text:
        `Mission started for ${names.join(', ')}: ${req.goal}\n` +
        `Budget: ${req.hours} h, up to ${req.maxTasks} tasks` +
        (req.costBudget !== undefined ? `, ${req.costBudget} ${this.unit()} of model use` : '') +
        `, ${req.maxRounds} rounds. ` +
        (req.allowInstalls.length
          ? `May install without asking: ${req.allowInstalls.join(', ')}. `
          : '') +
        (req.allowDomains.length
          ? `May visit without asking: ${req.allowDomains.join(', ')}. `
          : '') +
        (req.criteria.length
          ? `Success means: ${req.criteria.map((c) => `${c.field} ${describe(c)}`).join('; ')}.`
          : 'No measurable criteria were set; the report will say so.'),
    });
    await this.journal(id, 'Mission started.');
    const view = await this.get(id, ownerId);
    if (!view) throw new Error('mission vanished');
    return view;
  }

  async list(ownerId: string | null): Promise<MissionView[]> {
    const { rows } = await this.deps.pool.query<MissionRow>(
      'SELECT * FROM missions WHERE owner_id IS NOT DISTINCT FROM $1 ORDER BY started_at DESC',
      [ownerId],
    );
    return Promise.all(rows.map((r) => this.view(r)));
  }

  async get(id: string, ownerId: string | null): Promise<MissionView | undefined> {
    const { rows } = await this.deps.pool.query<MissionRow>(
      'SELECT * FROM missions WHERE id = $1 AND owner_id IS NOT DISTINCT FROM $2',
      [id, ownerId],
    );
    return rows[0] ? this.view(rows[0]) : undefined;
  }

  /** The mission a chat belongs to, if any (any status). */
  async forChat(chatId: string): Promise<MissionView | undefined> {
    const { rows } = await this.deps.pool.query<MissionRow>(
      'SELECT * FROM missions WHERE chat_id = $1 ORDER BY started_at DESC LIMIT 1',
      [chatId],
    );
    return rows[0] ? this.view(rows[0]) : undefined;
  }

  async forChatOfMission(missionId: string): Promise<MissionView | undefined> {
    const { rows } = await this.deps.pool.query<MissionRow>(
      'SELECT * FROM missions WHERE id = $1',
      [missionId],
    );
    return rows[0] ? this.view(rows[0]) : undefined;
  }

  async journal(missionId: string, text: string): Promise<void> {
    await this.deps.pool.query('INSERT INTO mission_journal (mission_id, text) VALUES ($1, $2)', [
      missionId,
      text.slice(0, 1000),
    ]);
  }

  /** Evidence from the mission's tasks whose independent checks all passed. */
  async evidence(chatId: string): Promise<{ evidence: Evidence[]; tasks: TaskLine[] }> {
    const { rows } = await this.deps.pool.query<{ task_id: string }>(
      'SELECT r.task_id FROM chat_runs r JOIN tasks t ON t.id = r.task_id WHERE r.chat_id = $1 ORDER BY t.created_at',
      [chatId],
    );
    const evidence: Evidence[] = [];
    const tasks: TaskLine[] = [];
    for (const { task_id } of rows) {
      const task = await this.deps.tasks.get(task_id);
      if (!task) continue;
      const checks = (task.state?.verification ?? []) as CheckResult[];
      const machine = checks.filter((c) => c.status !== 'unverified');
      const passed = machine.filter((c) => c.status === 'passed').length;
      const trusted = task.status === 'completed' && passed === machine.length;
      tasks.push({
        id: task.id,
        request: task.request,
        status: task.status,
        passed,
        checks: machine.length,
        trusted,
      });
      if (!trusted) continue;
      for (const e of evidenceFrom((task.state?.stepResults ?? []) as StepResult[])) {
        evidence.push({
          ...e,
          id: `B${evidence.length + 1}`,
          stepId: `${task.id.slice(0, 8)}/${e.stepId}`,
        });
      }
    }
    return { evidence, tasks };
  }

  /** The unit model costs are counted in. */
  unit(): string {
    return this.deps.usage?.pricing.unit ?? 'k tokens';
  }

  /** What the mission's chat has spent on model calls so far. */
  async spent(chatId: string): Promise<number> {
    return (await this.deps.usage?.spentForChat(chatId)) ?? 0;
  }

  /** Marks that the team was told the budget is nearly used; true the first time only. */
  async warnOnce(missionId: string): Promise<boolean> {
    const { rowCount } = await this.deps.pool.query(
      'UPDATE missions SET warned = true WHERE id = $1 AND warned = false',
      [missionId],
    );
    return (rowCount ?? 0) > 0;
  }

  /** Starts the next round of work; returns its number, or null when no round is left. */
  async nextRound(missionId: string): Promise<number | null> {
    const { rows } = await this.deps.pool.query<{ rounds: number }>(
      `UPDATE missions SET rounds = rounds + 1
        WHERE id = $1 AND status = 'running' AND rounds < max_rounds
        RETURNING rounds`,
      [missionId],
    );
    return rows[0]?.rounds ?? null;
  }

  /** Decisions in the mission's chat that wait for the user. */
  async openDecisions(chatId: string): Promise<string[]> {
    const out: string[] = [];
    for (const run of await this.deps.store.openRuns()) {
      if (run.chatId !== chatId || run.status !== 'awaiting_approval') continue;
      const task = await this.deps.tasks.get(run.taskId);
      const pending = task?.pendingApproval as {
        kind?: string;
        proposal?: { package?: unknown };
      } | null;
      out.push(
        pending?.kind === 'capability-approval'
          ? `Install ${String(pending.proposal?.package ?? 'a library')} for: ${task?.request ?? run.taskId}`
          : `Plan: ${task?.request ?? run.taskId}`,
      );
    }
    for (const m of await this.deps.store.messages(chatId)) {
      const c = m.card;
      if (c?.kind === 'access' && c.status === 'open') out.push(`Web access to ${c.domain}`);
      if (c?.kind === 'question' && c.status === 'open') out.push(`Question: ${c.question}`);
    }
    return out;
  }

  async tasksUsed(chatId: string): Promise<number> {
    const { rows } = await this.deps.pool.query<{ n: string }>(
      'SELECT COUNT(*) AS n FROM chat_runs WHERE chat_id = $1',
      [chatId],
    );
    return Number(rows[0]?.n ?? 0);
  }

  /**
   * Closes a mission. The verdict comes from the criteria and the verified evidence, never
   * from the bot's summary. Writes the report page and returns the closed mission.
   */
  async finish(
    missionId: string,
    reason: { by: string; summary: string; kind: CloseKind },
  ): Promise<MissionView | undefined> {
    const { rows } = await this.deps.pool.query<MissionRow>(
      'SELECT * FROM missions WHERE id = $1',
      [missionId],
    );
    const m = rows[0];
    if (!m || m.status !== 'running') return m ? this.view(m) : undefined;
    const { evidence, tasks } = await this.evidence(m.chat_id);
    const results = m.criteria.map((c, i) => checkCriterion(c, `K${i + 1}`, evidence));
    const verdict = verdictOf(results);
    const status: MissionStatus =
      reason.kind === 'timeout'
        ? 'timeout'
        : reason.kind === 'budget'
          ? 'out_of_budget'
          : reason.kind === 'stopped'
            ? 'stopped'
            : reason.kind === 'stalled'
              ? 'failed'
              : verdict === 'verified' || verdict === 'no_criteria'
                ? 'finished'
                : 'failed';
    const unbacked = unbackedNumbers(reason.summary, evidence, m.goal);
    const names = new Map<string, string>();
    const costs = [];
    for (const c of (await this.deps.usage?.byBot(m.chat_id)) ?? []) {
      let name = 'Reality';
      if (c.botId) {
        name = names.get(c.botId) ?? (await this.deps.bots.get(c.botId))?.name ?? 'a bot';
        names.set(c.botId, name);
      }
      costs.push({ name, cost: c.cost, calls: c.calls });
    }
    const { rows: journal } = await this.deps.pool.query<{ text: string; created_at: Date }>(
      'SELECT text, created_at FROM mission_journal WHERE mission_id = $1 ORDER BY id',
      [m.id],
    );
    const report = reportMarkdown(m, {
      spent: await this.spent(m.chat_id),
      unit: this.unit(),
      costs,
      decisions: await this.openDecisions(m.chat_id),
      journal,
      verdict,
      status,
      results,
      evidence,
      tasks,
      unbacked,
      reason,
    });
    const page = await this.deps.pages.create(m.owner_id, {
      title: `Mission report: ${m.goal.replace(/\s+/g, ' ').slice(0, 100)}`,
      content: report,
      author: 'Reality (computed)',
      change: `Mission ${status}`,
    });
    await this.deps.pool.query(
      `UPDATE missions SET status = $2, verdict = $3, summary = $4, report_page_id = $5, finished_at = now()
        WHERE id = $1 AND status = 'running'`,
      [missionId, status, verdict, reason.summary.slice(0, 8000), page.id],
    );
    await this.journal(
      missionId,
      `Closed (${reason.kind}) by ${reason.by}: ${status}, verdict ${verdict}.` +
        (reason.kind === 'done' && status === 'failed'
          ? ' The bot reported success, but the criteria are not met; recorded as failed.'
          : ''),
    );
    return this.forChat(m.chat_id);
  }

  async stop(
    missionId: string,
    ownerId: string | null,
    by: string,
  ): Promise<MissionView | undefined> {
    const m = await this.get(missionId, ownerId);
    if (!m) return undefined;
    return this.finish(missionId, { by, summary: 'Stopped by the user.', kind: 'stopped' });
  }

  /** Missions past their time budget, to close with an interim report. */
  async overdue(): Promise<string[]> {
    const { rows } = await this.deps.pool.query<{ id: string }>(
      "SELECT id FROM missions WHERE status = 'running' AND ends_at <= $1",
      [this.now()],
    );
    return rows.map((r) => r.id);
  }

  private async view(r: MissionRow): Promise<MissionView> {
    const { evidence } = await this.evidence(r.chat_id);
    const criteria = r.criteria.map((c, i) => checkCriterion(c, `K${i + 1}`, evidence));
    const { rows: journal } = await this.deps.pool.query<{ text: string; created_at: Date }>(
      'SELECT text, created_at FROM mission_journal WHERE mission_id = $1 ORDER BY id',
      [r.id],
    );
    return {
      id: r.id,
      chatId: r.chat_id,
      goal: r.goal,
      status: r.status,
      verdict: r.verdict,
      summary: r.summary,
      reportPageId: r.report_page_id,
      hours: Number(r.hours),
      maxTasks: r.max_tasks,
      autoApprove: r.auto_approve,
      startedAt: r.started_at.toISOString(),
      endsAt: r.ends_at.toISOString(),
      finishedAt: r.finished_at?.toISOString() ?? null,
      tasksUsed: await this.tasksUsed(r.chat_id),
      costBudget: r.cost_budget === null ? null : Number(r.cost_budget),
      spent: await this.spent(r.chat_id),
      costUnit: this.unit(),
      allowInstalls: r.allow_installs,
      allowDomains: r.allow_domains,
      rounds: r.rounds,
      maxRounds: r.max_rounds,
      openDecisions: r.status === 'running' ? await this.openDecisions(r.chat_id) : [],
      criteria,
      liveVerdict: verdictOf(criteria),
      journal: journal.map((j) => ({ text: j.text, at: j.created_at.toISOString() })),
    };
  }
}

export interface TaskLine {
  id: string;
  request: string;
  status: string;
  passed: number;
  checks: number;
  trusted: boolean;
}

function describe(c: Criterion): string {
  const parts: string[] = [];
  if (c.min !== undefined) parts.push(`≥ ${c.min}`);
  if (c.max !== undefined) parts.push(`≤ ${c.max}`);
  if (c.target !== undefined)
    parts.push(
      `= ${c.target}${c.tolerance !== undefined ? ` ± ${c.tolerance}` : c.tolerancePercent !== undefined ? ` ± ${c.tolerancePercent}%` : ''}`,
    );
  if (c.equals !== undefined) parts.push(`= "${c.equals}"`);
  if (c.contains !== undefined) parts.push(`contains "${c.contains}"`);
  return parts.join(' and ');
}

/** A cost in its unit, short. */
export function money(v: number, unit: string): string {
  const n = v === 0 ? '0' : v >= 100 ? v.toFixed(0) : v >= 1 ? v.toFixed(2) : v.toPrecision(2);
  return `${n} ${unit}`;
}

const VERDICT_TEXT: Record<Verdict, string> = {
  verified: 'Verified: every criterion is met by independently checked evidence.',
  partial: 'Partly verified: some criteria are met, others have no evidence yet.',
  not_verified: 'Not verified: no criterion has checked evidence.',
  refuted: 'Refuted: at least one criterion is missed by checked evidence.',
  no_criteria: 'No criteria were set, so nothing could be verified.',
};

function reportMarkdown(
  m: MissionRow,
  r: {
    verdict: Verdict;
    status: MissionStatus;
    results: CriterionResult[];
    evidence: Evidence[];
    tasks: TaskLine[];
    unbacked: string[];
    reason: { by: string; summary: string; kind: string };
    spent: number;
    unit: string;
    costs: { name: string; cost: number; calls: number }[];
    decisions: string[];
    journal: { text: string; created_at: Date }[];
  },
): string {
  const cell = (v: unknown) =>
    String(v ?? '—')
      .replace(/\|/g, '/')
      .replace(/\s+/g, ' ');
  const lines = [
    `# Mission report`,
    '',
    `**Goal:** ${cell(m.goal)}`,
    '',
    `**Status:** ${r.status} · **Verdict:** ${r.verdict}`,
    '',
    `> ${VERDICT_TEXT[r.verdict]}${r.reason.kind === 'done' && r.status === 'failed' ? ' The team reported the mission as done; the system recorded it as failed because the criteria are not met.' : ''}`,
    '',
    `_Budget: ${Number(m.hours)} h, up to ${m.max_tasks} tasks; ${r.tasks.length} used. ` +
      `Model use: ${money(r.spent, r.unit)}${m.cost_budget !== null ? ` of ${money(Number(m.cost_budget), r.unit)}` : ''}. ` +
      `Rounds: ${m.rounds} of ${m.max_rounds}. Computed by Reality from checked results, not written by a model._`,
    '',
    '## Waiting for you',
  ];
  if (r.decisions.length === 0) lines.push('- nothing');
  for (const d of r.decisions) lines.push(`- ${cell(d)}`);
  lines.push('', '## Criteria');
  if (r.results.length === 0) lines.push('- none set');
  for (const c of r.results) {
    lines.push(
      `- **${c.status}** — ${cell(c.field)} ${cell(c.expected)}: actual ${cell(c.actual)}${c.evidenceId ? ` (evidence ${c.evidenceId})` : ''}`,
    );
  }
  lines.push('', '## Evidence (from independently checked tasks only)');
  if (r.evidence.length === 0) lines.push('- none');
  for (const e of r.evidence) {
    lines.push(
      `- ${e.id} (${cell(e.stepId)}): ${Object.entries(e.values)
        .slice(0, 8)
        .map(([k, v]) => `${k} = ${cell(v)}`)
        .join(', ')}`,
    );
  }
  lines.push('', '## Tasks');
  if (r.tasks.length === 0) lines.push('- none');
  for (const t of r.tasks) {
    lines.push(
      `- ${t.trusted ? 'checked' : 'not counted'}: ${cell(t.request)} — ${t.status}, ${t.passed} of ${t.checks} checks passed (task ${t.id})`,
    );
  }
  lines.push('', `## Summary by ${cell(r.reason.by)}`, '', cell(r.reason.summary) || '—');
  if (r.unbacked.length > 0) {
    lines.push('', `**Numbers in the summary without evidence:** ${r.unbacked.join(', ')}`);
  }
  lines.push('', '## Model use');
  if (r.costs.length === 0) lines.push('- none recorded');
  for (const c of r.costs) {
    lines.push(`- ${cell(c.name)}: ${money(c.cost, r.unit)} in ${c.calls} calls`);
  }
  lines.push('', '## Timeline');
  for (const j of r.journal) {
    lines.push(`- ${j.created_at.toISOString().slice(11, 16)} UTC: ${cell(j.text)}`);
  }
  return lines.join('\n');
}
