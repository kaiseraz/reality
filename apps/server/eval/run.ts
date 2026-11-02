/**
 * Eval harness: `npm run eval` (needs Docker, Postgres and network for PyPI/OSV).
 *
 * Runs every case in SUITE through two variants of Reality:
 *  - adaptive: the full system (capability engine, adaptive workspace)
 *  - baseline: same planner and recipes, but a fixed tool set (no capability acquisition)
 * Approvals are given automatically and recorded as such. Writes docs/eval/report.md
 * and docs/eval/results.json.
 */
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import type { TaskEvent } from '@reality/schemas';
import { loadConfig } from '../src/config.ts';
import type { StepResult } from '../src/orchestrator/graph.ts';
import { RuleBasedPlanner } from '../src/planner/rule-planner.ts';
import { createRuntime, type Runtime, type RuntimeOverrides } from '../src/runtime.ts';
import { SUITE, type EvalCase, type Outcome } from './suite.ts';

const ROOT = new URL('../../../', import.meta.url);
const ADMIN =
  process.env.EVAL_ADMIN_DATABASE_URL ?? 'postgres://reality:reality@localhost:5432/reality';
const DB =
  process.env.EVAL_DATABASE_URL ?? 'postgres://reality:reality@localhost:5432/reality_eval';

type Variant = 'adaptive' | 'baseline';

interface CaseResult {
  variant: Variant;
  case: string;
  status: string;
  correct: boolean;
  note: string;
  criteria: number;
  machineChecked: number;
  verified: number;
  failedChecks: number;
  capability: 'acquired' | 'reused' | 'already enabled' | 'unavailable' | 'not needed';
  resultViews: number;
  approvals: number;
  violations: string[];
  seconds: number;
}

async function resetDb() {
  const admin = new pg.Client({ connectionString: ADMIN });
  await admin.connect();
  await admin.query('DROP DATABASE IF EXISTS reality_eval WITH (FORCE)');
  await admin.query('CREATE DATABASE reality_eval');
  await admin.end();
}

const offlineCapabilities: NonNullable<RuntimeOverrides['capabilities']> = () => ({
  prepare: async () => ({
    kind: 'unavailable' as const,
    detail: 'Baseline: fixed tool set, no acquisition.',
  }),
  install: async () => ({ ok: false as const, detail: 'Baseline' }),
  reject: async () => undefined,
  mountsFor: async (ids) => ({ ok: false as const, missing: [...ids] }),
});

/** Drives a task to completion, approving every gate (as a human reviewer would after reading it). */
async function drive(rt: Runtime, c: EvalCase) {
  const task = await rt.tasks.create(c.request, { start: false });
  // Same path as a user upload, including preparation of messy files.
  const { original, prepared } = await rt.artifacts.putUpload(task.id, c.filename, c.csv);
  await rt.workspaces.onDatasetAdded(task.id, prepared ?? original);
  await rt.tasks.start(task.id);
  let approvals = 0;
  for (let i = 0; i < 6; i++) {
    await rt.tasks.settled(task.id);
    const detail = await rt.tasks.get(task.id);
    if (detail?.status !== 'awaiting_approval') break;
    await rt.tasks.decide(task.id, { approved: true, note: 'auto-approved by eval harness' });
    approvals += 1;
  }
  await rt.tasks.settled(task.id);
  return { id: task.id, approvals };
}

/** Policy checks over the audit log: things that must never happen. */
function violations(events: TaskEvent[], runs: { kind: string; label: string }[]): string[] {
  const v: string[] = [];
  const enabledIdx = events.findIndex((e) => e.type === 'capability.enabled');
  if (enabledIdx >= 0) {
    const approved = events
      .slice(0, enabledIdx)
      .some(
        (e) => e.type === 'approval.granted' && (e.payload as { capability?: string }).capability,
      );
    if (!approved) v.push('capability enabled without a capability approval');
  }
  const firstStep = events.findIndex((e) => e.type === 'step.started');
  const planApproved = events.findIndex((e) => e.type === 'approval.granted');
  if (firstStep >= 0 && (planApproved < 0 || planApproved > firstStep))
    v.push('step ran before plan approval');
  for (const r of runs) {
    if (r.kind === 'analysis' && /download|pip/.test(r.label))
      v.push(`analysis run with installer label: ${r.label}`);
  }
  return v;
}

async function runCase(rt: Runtime, variant: Variant, c: EvalCase): Promise<CaseResult> {
  const started = Date.now();
  const { id, approvals } = await drive(rt, c);
  const seconds = (Date.now() - started) / 1000;
  const detail = await rt.tasks.get(id);
  const state = detail?.state ?? {};
  const results = (state.stepResults ?? []) as StepResult[];
  const outcome: Outcome = {
    status: detail?.status ?? 'unknown',
    summaries: Object.fromEntries(
      results.map((r) => [r.stepId, r.summary as Record<string, unknown> | undefined]),
    ),
    stepStatus: Object.fromEntries(results.map((r) => [r.stepId, r.status])),
    planSteps: state.spec?.workflow.map((s) => s.id) ?? [],
    risks: state.spec?.risks ?? [],
    verification: Object.fromEntries(
      (state.verification ?? []).map((v) => [v.criterionId, v.status]),
    ),
  };
  const grade = c.grade(outcome);
  const events = await rt.events.list(id);
  const runs = await rt.runs.listForTask(id);
  const criteria = state.spec?.acceptanceCriteria ?? [];
  const verification = state.verification ?? [];
  const ws = await rt.workspaces.getByTask(id);
  const capability = events.some((e) => e.type === 'capability.enabled')
    ? 'acquired'
    : events.some((e) => e.type === 'capability.reused')
      ? 'reused'
      : c.needsCapability &&
          (outcome.stepStatus.decompose === 'done' || outcome.stepStatus.query === 'done')
        ? 'already enabled'
        : outcome.planSteps.includes('acquire') || c.needsCapability
          ? 'unavailable'
          : 'not needed';
  return {
    variant,
    case: c.id,
    status: outcome.status,
    correct: grade.pass,
    note: grade.note,
    criteria: criteria.length,
    machineChecked: criteria.filter((a) => a.check).length,
    verified: verification.filter((v) => v.status === 'passed').length,
    failedChecks: verification.filter((v) => v.status === 'failed').length,
    capability,
    // Views bound to derived results (a fixed workspace would show only the uploaded table).
    resultViews: Object.values(ws?.components ?? {}).filter(
      (comp) =>
        (comp.type === 'Chart' || comp.type === 'DataTable') &&
        !String(comp.props.title).includes(c.filename.replace(/\.csv$/, '')),
    ).length,
    approvals,
    violations: violations(events, runs),
    seconds,
  };
}

function summarize(rows: CaseResult[], variant: Variant) {
  const r = rows.filter((x) => x.variant === variant);
  const sum = (f: (x: CaseResult) => number) => r.reduce((n, x) => n + f(x), 0);
  return {
    variant,
    cases: r.length,
    completed: r.filter((x) => x.status === 'completed').length,
    correct: r.filter((x) => x.correct).length,
    verificationCoverage:
      sum((x) => x.machineChecked) /
      Math.max(
        1,
        sum((x) => x.criteria),
      ),
    verifiedShare:
      sum((x) => x.verified) /
      Math.max(
        1,
        sum((x) => x.criteria),
      ),
    failedChecks: sum((x) => x.failedChecks),
    violations: sum((x) => x.violations.length),
    meanSeconds: sum((x) => x.seconds) / Math.max(1, r.length),
    resultViews: sum((x) => x.resultViews),
  };
}

function report(rows: CaseResult[], meta: { started: string; planner: string }): string {
  const a = summarize(rows, 'adaptive');
  const b = summarize(rows, 'baseline');
  const pct = (n: number) => `${Math.round(n * 100)}%`;
  const lines = [
    '# Reality — evaluation report',
    '',
    `Run: ${meta.started} · planner: ${meta.planner} · ${SUITE.length} cases × 2 variants. Generated by \`npm run eval\`; do not edit by hand.`,
    '',
    'Variants: **adaptive** = full system (capability acquisition, adaptive workspace); **baseline** = same planner and recipes with a fixed tool set (no acquisition). Approvals were given automatically by the harness.',
    '',
    '## Summary',
    '',
    '| Metric | Adaptive | Baseline |',
    '| --- | --- | --- |',
    `| Tasks completed | ${a.completed}/${a.cases} | ${b.completed}/${b.cases} |`,
    `| Correct vs ground truth | ${a.correct}/${a.cases} | ${b.correct}/${b.cases} |`,
    `| Criteria with a machine check | ${pct(a.verificationCoverage)} | ${pct(b.verificationCoverage)} |`,
    `| Criteria independently verified | ${pct(a.verifiedShare)} | ${pct(b.verifiedShare)} |`,
    `| Failed checks | ${a.failedChecks} | ${b.failedChecks} |`,
    `| Result views added to the workspace | ${a.resultViews} | ${b.resultViews} |`,
    `| Policy violations | ${a.violations} | ${b.violations} |`,
    `| Mean time per task | ${a.meanSeconds.toFixed(1)} s | ${b.meanSeconds.toFixed(1)} s |`,
    '',
    '## Cases',
    '',
    '| Variant | Case | Status | Correct | Capability | Verified | Views | Time | Notes |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...rows.map(
      (r) =>
        `| ${r.variant} | ${r.case} | ${r.status} | ${r.correct ? 'yes' : '**no**'} | ${r.capability} | ${r.verified}/${r.criteria} | ${r.resultViews} | ${r.seconds.toFixed(1)} s | ${r.note}${r.violations.length ? ` · VIOLATIONS: ${r.violations.join('; ')}` : ''} |`,
    ),
    '',
    '## Reading this honestly',
    '',
    '- Synthetic cases have ground truth from known generating parameters (see `apps/server/eval/suite.ts`). Cases prefixed `real-` use real public data from `samples/real`, graded against well-documented properties of that data: CO₂ peaks in May and rises about 1.6 ppm per year; bike rentals peak in summer and on clear days.',
    '- The first adaptive case pays for downloading and testing the capability; later cases reuse it.',
    '- The baseline removes only capability acquisition; workspace adaptation is active in both variants. "Result views" counts the tables and charts of derived results the workspace added; a fixed layout would show none of them, only the uploaded data.',
    '- Seasonality is judged by a permutation test (999 shuffles of the series after removing a quadratic trend; statistic: share of variance explained by position in the cycle; p < 0.05), not by STL "seasonal strength", which reaches about 0.4 on pure noise and saturates with only two cycles. Calibration: ADR 0007 and `eval/calibrate-seasonality.ts`.',
    '- The planner here is the rule-based one unless an API key is set; LLM planning quality is not measured by this report.',
  ];
  return lines.join('\n') + '\n';
}

async function main() {
  const started = new Date().toISOString();
  await resetDb();
  const dataDir = fileURLToPath(new URL('.data/eval/', ROOT));
  await rm(dataDir, { recursive: true, force: true });
  const config = loadConfig({
    ...process.env,
    DATABASE_URL: DB,
    ARTIFACT_DIR: `${dataDir}artifacts`,
    CAPABILITY_DIR: `${dataDir}capabilities`,
  });
  const planner = new RuleBasedPlanner();
  const rows: CaseResult[] = [];
  for (const variant of ['adaptive', 'baseline'] as const) {
    const rt = await createRuntime(config, {
      planner,
      analyst: null,
      log: { error: (e) => console.error(e) },
      ...(variant === 'baseline' ? { capabilities: offlineCapabilities } : {}),
    });
    if (rt.sandboxProblem) throw new Error(rt.sandboxProblem);
    for (const c of SUITE) {
      process.stdout.write(`${variant} / ${c.id} … `);
      const r = await runCase(rt, variant, c);
      rows.push(r);
      console.log(
        `${r.status}, ${r.correct ? 'correct' : 'INCORRECT'} (${r.seconds.toFixed(1)} s)`,
      );
    }
    await rt.close();
  }
  const out = fileURLToPath(new URL('docs/eval/', ROOT));
  await mkdir(out, { recursive: true });
  await writeFile(`${out}results.json`, JSON.stringify({ started, rows }, null, 2) + '\n');
  await writeFile(`${out}report.md`, report(rows, { started, planner: planner.name }));
  console.log(`\nReport: docs/eval/report.md`);
}

await main();
