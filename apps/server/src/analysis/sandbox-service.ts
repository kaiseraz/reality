import { readFile } from 'node:fs/promises';
import type { EventLog } from '../events/event-log.ts';
import type { DockerRunner, Limits, Mount, RunInput, RunResult } from '../sandbox/docker-runner.ts';
import type { RunKind, RunRecord, RunStore } from './run-store.ts';

export interface ExecuteRequest {
  taskId: string | null;
  stepId?: string;
  kind: RunKind;
  label: string;
  code: string;
  inputs?: RunInput[];
  readOnlyMounts?: Mount[];
  writableMounts?: Mount[];
  network?: 'none' | 'egress';
  /** Another sandbox image than the default (Node servers). Same lockdown. */
  image?: string;
  limits?: Partial<Limits>;
}

export interface Execution {
  result: RunResult;
  record: RunRecord;
  /** Parsed /output/summary.json, if the program wrote a valid one. */
  summary: unknown;
}

/**
 * Executes code in the sandbox and makes every execution auditable: the exact code,
 * inputs, limits, status and output are recorded before anyone acts on the result.
 */
export class SandboxService {
  constructor(
    readonly runner: DockerRunner,
    private readonly runs: RunStore,
    private readonly events: EventLog,
  ) {}

  async execute(req: ExecuteRequest): Promise<Execution> {
    if (req.taskId) {
      await this.events.append(req.taskId, 'run.started', actorFor(req.kind), {
        label: req.label,
        stepId: req.stepId,
      });
    }
    const result = await this.runner.run({
      code: req.code,
      inputs: req.inputs ?? [],
      readOnlyMounts: req.readOnlyMounts ?? [],
      writableMounts: req.writableMounts ?? [],
      ...(req.network ? { network: req.network } : {}),
      ...(req.image ? { image: req.image } : {}),
      ...(req.limits ? { limits: req.limits } : {}),
    });

    let summary: unknown = undefined;
    const summaryFile = result.outputs.find((o) => o.name === 'summary.json');
    if (summaryFile && summaryFile.sizeBytes < 1_000_000) {
      try {
        summary = JSON.parse(await readFile(summaryFile.path, 'utf8'));
      } catch {
        summary = undefined; // malformed output is ignored, never trusted
      }
    }

    const record = await this.runs.insert({
      id: result.runId,
      taskId: req.taskId,
      stepId: req.stepId ?? null,
      kind: req.kind,
      label: req.label,
      code: req.code,
      image: result.image,
      status: result.status,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.stderr,
      durationMs: result.durationMs,
      inputs: (req.inputs ?? []).map((i) => i.name),
      outputs: result.outputs.map((o) => ({ name: o.name, sizeBytes: o.sizeBytes })),
      summary,
    });
    if (req.taskId) {
      await this.events.append(req.taskId, 'run.completed', actorFor(req.kind), {
        runId: record.id,
        label: req.label,
        status: record.status,
        durationMs: record.durationMs,
      });
    }
    return { result, record, summary };
  }
}

function actorFor(kind: RunKind) {
  if (kind === 'check') return 'verification-agent' as const;
  if (kind.startsWith('capability')) return 'capability-agent' as const;
  return 'analysis-agent' as const;
}
