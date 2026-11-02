import { readFile } from 'node:fs/promises';
import type { PlanStep } from '@reality/schemas';
import { ArtifactRejectedError } from '../artifacts/artifact-store.ts';
import type { ExecutorDeps } from '../analysis/executor.ts';
import type { StepResult } from '../orchestrator/graph.ts';
import { buildLabCode, getLabEngine } from './engines.ts';

/**
 * Lines a person can read: native libraries (e.g. the CAD kernel) print colour codes and
 * banner lines of asterisks to stdout; keep only lines with words or numbers.
 */
function readable(stdout: string): string[] {
  return (
    stdout
      // eslint-disable-next-line no-control-regex -- strips terminal colour codes
      .replace(/\u001b\[[0-9;]*m/g, '')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => /[A-Za-z0-9]/.test(l) && !/^\*{3,}/.test(l))
  );
}

const tail = (s: string, n = 1500) => (s.length > n ? `…${s.slice(-n)}` : s);

/**
 * A lab-agent step: runs a simulation engine in the sandbox (no network, no input data),
 * with any capability it needs mounted read-only, and stores its tables with provenance.
 * result.csv comes first, so the independent check reads the main result.
 */
export async function runLab(
  deps: ExecutorDeps,
  step: PlanStep,
  taskId: string,
): Promise<StepResult> {
  const engine = step.recipe ? getLabEngine(step.recipe.name) : undefined;
  if (!engine) {
    return {
      stepId: step.id,
      status: 'failed',
      detail: `Unknown lab engine "${step.recipe?.name ?? ''}".`,
    };
  }
  const resolved =
    engine.requires.length === 0
      ? { ok: true as const, mounts: [], paths: [] }
      : await deps.capabilities.mountsFor(engine.requires);
  if (!resolved.ok) {
    return {
      stepId: step.id,
      status: 'failed',
      detail: `Missing capability: ${resolved.missing.join(', ')} is not enabled.`,
    };
  }
  const built = buildLabCode(engine, step.recipe?.params, resolved.paths);
  if ('error' in built) return { stepId: step.id, status: 'failed', detail: built.error };

  const exec = await deps.sandbox.execute({
    taskId,
    stepId: step.id,
    kind: 'analysis',
    label: `lab:${engine.name}`,
    code: built.code,
    readOnlyMounts: resolved.mounts,
    limits: { timeoutMs: 180_000, memoryMb: 1024, ...engine.limits },
  });
  try {
    if (exec.result.status !== 'succeeded') {
      const why =
        exec.result.status === 'output_rejected'
          ? exec.result.outputErrors.join('; ')
          : tail(exec.result.stderr.trim() || `exit code ${exec.result.exitCode}`);
      return {
        stepId: step.id,
        status: 'failed',
        detail: `Simulation ${exec.result.status}: ${why}`,
        runId: exec.record.id,
      };
    }
    if (engine.requires.length > 0) await deps.capabilities.recordUse?.(engine.requires);
    // Binary results (CAD assemblies, meshes) go to the file store, tied to this step.
    if (deps.files) {
      for (const out of exec.result.outputs) {
        if (out.name.endsWith('.csv') || out.name === 'summary.json') continue;
        await deps.files.put(taskId, step.id, out.name, out.path);
      }
    }
    const outputs = exec.result.outputs
      .filter((o) => o.name.endsWith('.csv'))
      .sort((a, b) => (a.name === 'result.csv' ? -1 : b.name === 'result.csv' ? 1 : 0));
    const produced: string[] = [];
    for (const out of outputs) {
      try {
        const meta = await deps.artifacts.putCsv(
          taskId,
          `${engine.name}_${out.name}`,
          await readFile(out.path, 'utf8'),
          {
            kind: 'derived',
            runId: exec.record.id,
            stepId: step.id,
            recipe: engine.name,
            inputs: [],
          },
        );
        produced.push(meta.ref.id);
        await deps.onArtifact(taskId, meta);
      } catch (err) {
        if (!(err instanceof ArtifactRejectedError)) throw err;
      }
    }
    return {
      stepId: step.id,
      status: 'done',
      detail: readable(exec.result.stdout).slice(0, 8).join('\n') || 'Simulation completed.',
      runId: exec.record.id,
      artifacts: produced,
      ...(exec.summary !== undefined ? { summary: exec.summary } : {}),
    };
  } finally {
    await exec.result.cleanup();
  }
}
