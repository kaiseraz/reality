import type { Column } from '@reality/workspace';
import { z } from 'zod';

/**
 * What the model is asked to produce. Deliberately flat and fully required so it maps
 * cleanly onto structured outputs; the stricter `TaskSpec` (defaults, cross-field
 * checks) is applied afterwards by the orchestrator. Model output is never trusted
 * just because it parsed.
 */
export const TaskSpecDraft = z.object({
  goal: z.string(),
  constraints: z.array(z.string()),
  requiredOutputs: z.array(z.string()),
  risks: z.array(z.string()),
  acceptanceCriteria: z.array(
    z.object({
      id: z.string(),
      description: z.string(),
      checkType: z.enum(['recompute', 'schema', 'test', 'llm-judge', 'human']),
    }),
  ),
  workflow: z.array(
    z.object({
      id: z.string(),
      description: z.string(),
      agent: z.enum([
        'analysis-agent',
        'capability-agent',
        'workspace-agent',
        'verification-agent',
      ]),
      dependsOn: z.array(z.string()),
    }),
  ),
  missingCapabilities: z.array(z.object({ need: z.string() })),
  candidateWorkspaces: z.array(z.string()),
});
export type TaskSpecDraft = z.infer<typeof TaskSpecDraft>;

export interface DatasetInfo {
  filename: string;
  rowCount: number;
  columns: Column[];
  /** What upload preparation changed (comment lines, no-data markers, derived date). */
  notes?: string[];
}

export interface PlannerInput {
  request: string;
  /** The task being planned (lets a planner look up a fixed plan, e.g. a lab simulation). */
  taskId?: string;
  /** Datasets attached to the task (schema only, never raw rows). */
  datasets?: DatasetInfo[];
  /** Capability ids already enabled in the registry. */
  availableCapabilities?: string[];
  /** Validation errors from the previous attempt, so the model can correct itself. */
  feedback?: string;
}

export interface PlannerOutput {
  /** Raw proposal; validated by the caller. */
  draft: unknown;
  model: string;
  usage: { inputTokens: number; outputTokens: number };
}

export interface Planner {
  readonly name: string;
  propose(input: PlannerInput): Promise<PlannerOutput>;
}

export class PlannerError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'PlannerError';
  }
}
