import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import Papa from 'papaparse';
import type { PlanStep } from '@reality/schemas';
import {
  ArtifactRejectedError,
  type ArtifactMeta,
  type ArtifactStore,
} from '../artifacts/artifact-store.ts';
import type { StepExecutor, StepResult } from '../orchestrator/graph.ts';
import { buildRecipeCode, getRecipe } from './recipes.ts';
import { checkReadOnlySql } from '../capabilities/mcp.ts';
import type { Mount, RunInput } from '../sandbox/docker-runner.ts';
import { runResearch, type ResearchDeps } from '../research/research-step.ts';
import { runLab } from '../lab/run.ts';
import type { FileStore } from '../artifacts/file-store.ts';
import type { RunStore } from './run-store.ts';
import type { SandboxService } from './sandbox-service.ts';

/** Resolves capability ids to read-only sandbox mounts (implemented by the capability engine). */
export interface CapabilityResolver {
  mountsFor(
    ids: readonly string[],
  ): Promise<{ ok: true; mounts: Mount[]; paths: string[] } | { ok: false; missing: string[] }>;
  recordUse?(ids: readonly string[]): Promise<void>;
  /** What an installed library is: its package, version, state and the modules to import. */
  info?(id: string): Promise<
    | {
        id: string;
        package: string;
        version: string | null;
        state: string;
        kind: string;
        modules: string[];
        tools: string[];
      }
    | undefined
  >;
  /** What an enabled MCP server offers (names; descriptions are untrusted text from the server). */
  listTools?(
    id: string,
    owner?: string | null,
  ): Promise<
    { ok: true; tools: { name: string; description: string }[] } | { ok: false; detail: string }
  >;
  /** Capability ids currently usable (enabled or trusted). */
  enabledIds?(): Promise<string[]>;
  /** Calls an approved tool of an enabled MCP capability (task data mounted read-only). */
  callTool?(
    capabilityId: string,
    tool: string,
    args: Record<string, unknown>,
    inputs: RunInput[],
    /** Who is asking: a server holding someone's secret works only for them. */
    owner?: string | null,
    /** Gets every file the tool produced. */
    save?: (file: { name: string; path: string }) => Promise<void>,
  ): Promise<
    | { ok: true; text: string; refused?: string[]; files?: string[] }
    | { ok: false; detail: string; refused?: string[] }
  >;
  /** Stores what a person typed into an approval card. Nothing returns a value. */
  setSecrets?(id: string, values: Record<string, string>, owner: string | null): Promise<string[]>;
  /** A person allowed a tool server one more domain. */
  allowDomain?(id: string, domain: string): Promise<string>;
}

export const noCapabilities: CapabilityResolver = {
  mountsFor: async (ids) =>
    ids.length === 0 ? { ok: true, mounts: [], paths: [] } : { ok: false, missing: [...ids] },
};

/** Writes Python for a step when no recipe applies (e.g. Claude). Optional. */
export interface Analyst {
  readonly name: string;
  writeCode(input: {
    goal: string;
    step: PlanStep;
    dataset: { filename: string; columns: ArtifactMeta['columns']; rowCount: number };
    previousError?: string;
  }): Promise<string>;
}

export interface ExecutorDeps {
  sandbox: SandboxService;
  artifacts: ArtifactStore;
  capabilities: CapabilityResolver;
  /** Called for every artifact a step produces (e.g. to add it to the workspace). */
  onArtifact: (taskId: string, meta: ArtifactMeta) => Promise<void>;
  analyst?: Analyst;
  goalOf?: (taskId: string) => Promise<string>;
  /** Records tool calls in the run log (sandbox runs record themselves). */
  runs?: RunStore;
  /** Binary step results such as CAD assemblies and meshes. */
  files?: FileStore;
  /** Literature, knowledge and cited answers (research-agent steps). */
  research?: Omit<ResearchDeps, 'artifacts' | 'runs' | 'onArtifact' | 'image'>;
}

const tail = (s: string, n = 1500) => (s.length > n ? `…${s.slice(-n)}` : s);

/** Latest dataset the user attached; derived outputs are never used as primary input. */
export async function primaryDataset(
  artifacts: ArtifactStore,
  taskId: string,
): Promise<ArtifactMeta | undefined> {
  const all = await artifacts.listForTask(taskId);
  // The latest input: an upload, or a result handed over from an earlier project task.
  const upload = all
    .filter((a) => a.provenance.kind === 'upload' || a.provenance.kind === 'handoff')
    .at(-1);
  if (!upload) return undefined;
  // The prepared copy of the latest upload, if cleaning was needed, is the working dataset.
  const prepared = all.find(
    (a) => a.provenance.kind === 'prepared' && a.provenance.from === upload.ref.id,
  );
  return prepared ?? upload;
}

export function createExecutor(deps: ExecutorDeps): StepExecutor {
  return async (step, { taskId }): Promise<StepResult> => {
    switch (step.agent) {
      case 'analysis-agent':
        return runAnalysis(deps, step, taskId);
      case 'lab-agent':
        return runLab(deps, step, taskId);
      case 'research-agent':
        if (!deps.research) {
          return { stepId: step.id, status: 'not_executed', detail: 'Research is not configured.' };
        }
        return runResearch(
          {
            ...deps.research,
            artifacts: deps.artifacts,
            ...(deps.runs ? { runs: deps.runs } : {}),
            onArtifact: deps.onArtifact,
            image: 'server (no sandbox: read-only network search)',
          },
          step,
          taskId,
        );
      case 'verification-agent':
        return {
          stepId: step.id,
          status: 'done',
          detail: 'Acceptance criteria are checked in the verification phase.',
        };
      default:
        return {
          stepId: step.id,
          status: 'not_executed',
          detail: `No executor for ${step.agent} steps.`,
        };
    }
  };
}

async function runAnalysis(
  deps: ExecutorDeps,
  step: PlanStep,
  taskId: string,
): Promise<StepResult> {
  const dataset = await primaryDataset(deps.artifacts, taskId);
  if (!dataset) {
    return { stepId: step.id, status: 'failed', detail: 'No dataset attached to this task.' };
  }
  if (step.tool) return runTool(deps, step, step.tool, taskId, dataset);

  let code: string;
  let label: string;
  let mounts: Mount[] = [];
  let capabilityIds: string[] = [];

  const recipe = step.recipe ? getRecipe(step.recipe.name) : undefined;
  if (step.recipe && !recipe) {
    return { stepId: step.id, status: 'failed', detail: `Unknown recipe "${step.recipe.name}".` };
  }
  if (recipe) {
    capabilityIds = [...recipe.requires];
    const resolved =
      capabilityIds.length === 0
        ? { ok: true as const, mounts: [], paths: [] }
        : await deps.capabilities.mountsFor(capabilityIds);
    if (!resolved.ok) {
      return {
        stepId: step.id,
        status: 'failed',
        detail: `Missing capability: ${resolved.missing.join(', ')} is not enabled.`,
      };
    }
    mounts = resolved.mounts;
    const built = buildRecipeCode(recipe, step.recipe?.params, resolved.paths);
    if ('error' in built) return { stepId: step.id, status: 'failed', detail: built.error };
    code = built.code;
    label = `recipe:${recipe.name}`;
  } else if (deps.analyst) {
    code = ''; // written below, with one corrective retry
    label = `analyst:${deps.analyst.name}`;
  } else {
    return {
      stepId: step.id,
      status: 'not_executed',
      detail: 'No built-in recipe matches this step and no AI analyst is configured.',
    };
  }

  const execute = (source: string, attemptLabel: string) =>
    deps.sandbox.execute({
      taskId,
      stepId: step.id,
      kind: 'analysis',
      label: attemptLabel,
      code: source,
      inputs: [{ name: 'data.csv', hostPath: deps.artifacts.filePath(dataset) }],
      readOnlyMounts: mounts,
    });

  let exec: Awaited<ReturnType<typeof execute>>;
  if (recipe || !deps.analyst) {
    exec = await execute(code, label);
  } else {
    // AI-written code: one attempt, plus one retry that sees the error output.
    const analyst = deps.analyst;
    const goal = (await deps.goalOf?.(taskId)) ?? '';
    const info = {
      filename: dataset.filename,
      columns: dataset.columns,
      rowCount: dataset.rowCount,
    };
    let previousError: string | undefined;
    let attempt = 1;
    for (;;) {
      try {
        code = await analyst.writeCode({
          goal,
          step,
          dataset: info,
          ...(previousError ? { previousError } : {}),
        });
      } catch (err) {
        return {
          stepId: step.id,
          status: 'failed',
          detail: `Analyst failed: ${(err as Error).message}`,
        };
      }
      exec = await execute(code, attempt === 1 ? label : `${label} (retry)`);
      if (exec.result.status === 'succeeded' || attempt === 2) break;
      previousError = tail(
        exec.result.stderr.trim() || exec.result.outputErrors.join('; ') || exec.result.status,
      );
      await exec.result.cleanup();
      attempt += 1;
    }
  }

  try {
    if (exec.result.status !== 'succeeded') {
      const why =
        exec.result.status === 'output_rejected'
          ? exec.result.outputErrors.join('; ')
          : tail(exec.result.stderr.trim() || `exit code ${exec.result.exitCode}`);
      return {
        stepId: step.id,
        status: 'failed',
        detail: `Run ${exec.result.status}: ${why}`,
        runId: exec.record.id,
      };
    }
    if (capabilityIds.length > 0) await deps.capabilities.recordUse?.(capabilityIds);

    const produced: string[] = [];
    const skipped: string[] = [];
    for (const out of exec.result.outputs.filter((o) => o.name.endsWith('.csv'))) {
      const text = await readFile(out.path, 'utf8');
      let meta;
      try {
        meta = await deps.artifacts.putCsv(taskId, out.name, text, {
          kind: 'derived',
          runId: exec.record.id,
          stepId: step.id,
          ...(recipe ? { recipe: recipe.name } : {}),
          inputs: [dataset.ref.id],
        });
      } catch (err) {
        if (!(err instanceof ArtifactRejectedError)) throw err;
        skipped.push(`${out.name} (${err.message})`);
        continue;
      }
      produced.push(meta.ref.id);
      await deps.onArtifact(taskId, meta);
    }
    return {
      stepId: step.id,
      status: 'done',
      detail:
        (exec.result.stdout.trim().split('\n').slice(0, 12).join('\n') || 'Completed.') +
        (skipped.length > 0 ? `\nOutputs not stored: ${skipped.join(', ')}` : ''),
      runId: exec.record.id,
      artifacts: produced,
      ...(exec.summary !== undefined ? { summary: exec.summary } : {}),
    };
  } finally {
    await exec.result.cleanup();
  }
}

interface QueryResult {
  success?: boolean;
  columns?: string[];
  rows?: unknown[][];
  rowCount?: number;
  truncated?: boolean;
  warning?: string;
}

/**
 * A plan step that calls an approved MCP tool (e.g. execute_query of a SQL server).
 * The server runs sandboxed with the task's CSV mounted read-only; tabular results are
 * stored as an artifact with provenance and shown in the workspace.
 */
async function runTool(
  deps: ExecutorDeps,
  step: PlanStep,
  tool: NonNullable<PlanStep['tool']>,
  taskId: string,
  dataset: ArtifactMeta,
): Promise<StepResult> {
  if (!deps.capabilities.callTool) {
    return { stepId: step.id, status: 'failed', detail: 'No MCP tool support configured.' };
  }
  const sql = typeof tool.args.sql === 'string' ? tool.args.sql : undefined;
  if (tool.name === 'execute_query') {
    const problem = sql === undefined ? 'Missing "sql" argument.' : checkReadOnlySql(sql);
    if (problem) return { stepId: step.id, status: 'failed', detail: `Query refused: ${problem}` };
  }
  const started = Date.now();
  const call = await deps.capabilities.callTool(tool.capability, tool.name, tool.args, [
    { name: 'data.csv', hostPath: deps.artifacts.filePath(dataset) },
  ]);
  const runId = randomUUID();
  await deps.runs?.insert({
    id: runId,
    taskId,
    stepId: step.id,
    kind: 'analysis',
    label: `mcp:${tool.capability}/${tool.name}`,
    code: sql ?? JSON.stringify(tool.args, null, 2),
    image: deps.sandbox.runner.image,
    status: call.ok ? 'succeeded' : 'failed',
    exitCode: null,
    stdout: call.ok ? call.text.slice(0, 20_000) : '',
    stderr: call.ok ? '' : call.detail,
    durationMs: Date.now() - started,
    inputs: ['data.csv'],
    outputs: [],
    summary: null,
  });
  if (!call.ok) {
    return {
      stepId: step.id,
      status: 'failed',
      detail: `Tool call failed: ${tail(call.detail, 800)}`,
      runId,
    };
  }

  let result: QueryResult;
  try {
    result = JSON.parse(call.text) as QueryResult;
  } catch {
    return { stepId: step.id, status: 'done', detail: tail(call.text, 1500), runId };
  }
  if (!result.columns || !result.rows) {
    return { stepId: step.id, status: 'done', detail: tail(call.text, 1500), runId };
  }
  const csv = Papa.unparse({ fields: result.columns, data: result.rows });
  const summary = {
    rows: result.rows.length,
    columns: result.columns,
    truncated: result.truncated === true,
    ...(sql ? { sql } : {}),
  };
  const notes: string[] = [
    `Query returned ${result.rows.length} rows × ${result.columns.length} columns (${tool.capability}, sandboxed).`,
  ];
  if (result.truncated) notes.push(`Result truncated: ${result.warning ?? 'row limit reached'}.`);
  try {
    const meta = await deps.artifacts.putCsv(taskId, `${step.id}_result.csv`, csv, {
      kind: 'derived',
      runId,
      stepId: step.id,
      inputs: [dataset.ref.id],
    });
    await deps.onArtifact(taskId, meta);
    return {
      stepId: step.id,
      status: 'done',
      detail: notes.join('\n'),
      runId,
      artifacts: [meta.ref.id],
      summary,
    };
  } catch (err) {
    if (!(err instanceof ArtifactRejectedError)) throw err;
    notes.push(`Result not stored as a table: ${err.message}`);
    return { stepId: step.id, status: 'done', detail: notes.join('\n'), runId, summary };
  }
}
