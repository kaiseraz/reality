import { readFile } from 'node:fs/promises';
import Papa from 'papaparse';
import type { ArtifactStore } from '../artifacts/artifact-store.ts';
import type { CheckResult, StepResult } from '../orchestrator/graph.ts';
import type { TaskService } from '../tasks/task-service.ts';

const SKIP = new Set(['profile', 'verify', 'acquire']);

/** Markdown text in a cell: no line breaks, no table or heading syntax from the data. */
const inline = (s: unknown) =>
  String(s ?? '')
    .replace(/\s+/g, ' ')
    .replace(/^#+\s*/, '')
    .trim();

async function rowsOf(artifacts: ArtifactStore, id: string | undefined) {
  if (!id) return [];
  const meta = await artifacts.get(id);
  if (!meta) return [];
  const text = await readFile(artifacts.filePath(meta), 'utf8');
  return Papa.parse<Record<string, string>>(text, { header: true, skipEmptyLines: true }).data;
}

/**
 * A finished task as a page section: what was asked, what was found, what it rests on and
 * what was verified. Written only from stored results, never by a model, so a page built
 * from routine runs is as trustworthy as the tasks behind it.
 */
export async function taskReport(
  deps: { tasks: TaskService; artifacts: ArtifactStore },
  taskId: string,
  opts: { by?: string } = {},
): Promise<string | undefined> {
  const task = await deps.tasks.get(taskId);
  if (!task) return undefined;
  const spec = task.state?.spec;
  const results = (task.state?.stepResults ?? []) as StepResult[];
  const checks = (task.state?.verification ?? []) as CheckResult[];
  const date = new Date(task.updatedAt).toISOString().slice(0, 16).replace('T', ' ');
  const out: string[] = [
    `## ${inline(task.request)}`,
    `_${date} UTC · ${opts.by ?? 'Reality'} · status ${task.status} · task ${task.id}_`,
  ];

  const research = new Map(
    (spec?.workflow ?? [])
      .filter((s) => s.agent === 'research-agent')
      .map((s) => [s.id, s.recipe?.name ?? '']),
  );
  const done = results.filter((r) => r.status === 'done');

  for (const r of done.filter((d) => research.get(d.stepId) === 'synthesize')) {
    const summary = (r.summary ?? {}) as { answer?: string };
    if (summary.answer) out.push('', inline(summary.answer));
    for (const c of await rowsOf(deps.artifacts, r.artifacts?.[0])) {
      out.push(
        `- ${inline(c.claim)} [${inline(c.ref)}]${c.quote_found === 'yes' ? '' : ' (quote not found in source)'}`,
        `  > ${inline(c.quote)}`,
      );
    }
  }

  const findings = done
    .filter((r) => !SKIP.has(r.stepId) && !research.has(r.stepId))
    .flatMap((r) => r.detail.split('\n').slice(0, 2))
    .map(inline)
    .filter((l) => l && !l.startsWith('Acceptance criteria are checked'));
  if (findings.length > 0) out.push('', '### Findings', ...findings.map((f) => `- ${f}`));

  const sources: string[] = [];
  for (const r of done.filter((d) => research.get(d.stepId) === 'literature')) {
    for (const s of await rowsOf(deps.artifacts, r.artifacts?.[0])) {
      sources.push(
        `- [${inline(s.ref)}] ${inline(s.title)} (${inline(s.year) || 'n.d.'})` +
          `${s.authors ? `, ${inline(s.authors)}` : ''}${s.doi ? `. DOI ${inline(s.doi)}` : ''}`,
      );
    }
  }
  for (const r of done.filter((d) => research.get(d.stepId) === 'knowledge')) {
    for (const s of await rowsOf(deps.artifacts, r.artifacts?.[0])) {
      sources.push(`- [${inline(s.ref)}] ${inline(s.source)}, line ${inline(s.line)}`);
    }
  }
  if (sources.length > 0) out.push('', '### Sources', ...sources);

  if (checks.length > 0) {
    const passed = checks.filter((c) => c.status === 'passed').length;
    out.push('', `### Verification: ${passed} of ${checks.length} passed`);
    for (const c of checks) {
      const ac = spec?.acceptanceCriteria.find((a) => a.id === c.criterionId);
      out.push(`- ${c.status}: ${inline(ac?.description ?? c.criterionId)} — ${inline(c.detail)}`);
    }
  }
  const failed = results.filter((r) => r.status === 'failed');
  if (failed.length > 0) {
    out.push(
      '',
      '### Did not work',
      ...failed.map((r) => `- ${r.stepId}: ${inline(r.detail).slice(0, 300)}`),
    );
  }
  if (task.status !== 'completed' && task.state?.error) {
    out.push('', `_Stopped: ${inline(task.state.error)}_`);
  }
  return out.join('\n');
}
