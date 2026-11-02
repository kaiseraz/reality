import { z } from 'zod';
import { Actor, ArtifactRef, Id } from './common.ts';

/**
 * How an acceptance criterion is checked. Only `recompute`, `schema` and `test` are
 * machine-verifiable; `llm-judge` must always be displayed as a weaker signal.
 */
export const CheckType = z.enum(['recompute', 'schema', 'test', 'llm-judge', 'human']);
export type CheckType = z.infer<typeof CheckType>;

/** A named, parameterized built-in procedure (analysis recipe or verification check). */
export const RecipeRef = z.object({
  name: z.string().min(1),
  params: z.record(z.string(), z.unknown()).default({}),
});
export type RecipeRef = z.infer<typeof RecipeRef>;

export const AcceptanceCriterion = z.object({
  id: Id,
  description: z.string().min(1),
  checkType: CheckType,
  /** Machine check that verifies this criterion independently of the producing step. */
  check: RecipeRef.optional(),
});
export type AcceptanceCriterion = z.infer<typeof AcceptanceCriterion>;

export const PlanStepStatus = z.enum([
  'pending',
  'running',
  'blocked',
  'done',
  'failed',
  'skipped',
]);

export const PlanStep = z.object({
  id: Id,
  description: z.string().min(1),
  agent: Actor,
  dependsOn: z.array(Id).default([]),
  status: PlanStepStatus.default('pending'),
  /** Built-in recipe to execute; without one, an AI analyst must write the code. */
  recipe: RecipeRef.optional(),
  /** For capability-agent steps: the capability need this step resolves. */
  capability: z.string().optional(),
  /** Call an approved tool of an enabled MCP capability instead of running code. */
  tool: z
    .object({
      capability: z.string().min(1),
      name: z.string().min(1),
      args: z.record(z.string(), z.unknown()).default({}),
    })
    .optional(),
});
export type PlanStep = z.infer<typeof PlanStep>;

export const MissingCapability = z.object({
  need: z.string().min(1),
  status: z.enum(['open', 'searching', 'resolved', 'unresolvable']).default('open'),
  capabilityId: Id.optional(),
});

/** Output of task understanding (Layer 2). Revisable as the task evolves. */
export const TaskSpec = z
  .object({
    goal: z.string().min(1),
    constraints: z.array(z.string()).default([]),
    requiredOutputs: z.array(z.string()).min(1),
    resources: z.array(ArtifactRef).default([]),
    risks: z.array(z.string()).default([]),
    acceptanceCriteria: z.array(AcceptanceCriterion).min(1),
    workflow: z.array(PlanStep).min(1),
    missingCapabilities: z.array(MissingCapability).default([]),
    candidateWorkspaces: z.array(z.string()).default([]),
  })
  .superRefine((spec, ctx) => {
    const stepIds = new Set(spec.workflow.map((s) => s.id));
    if (stepIds.size !== spec.workflow.length) {
      ctx.addIssue({ code: 'custom', message: 'duplicate plan step id', path: ['workflow'] });
    }
    spec.workflow.forEach((step, i) => {
      for (const dep of step.dependsOn) {
        if (!stepIds.has(dep) || dep === step.id) {
          ctx.addIssue({
            code: 'custom',
            message: `step "${step.id}" depends on unknown or self step "${dep}"`,
            path: ['workflow', i, 'dependsOn'],
          });
        }
      }
    });
    const acIds = new Set(spec.acceptanceCriteria.map((a) => a.id));
    if (acIds.size !== spec.acceptanceCriteria.length) {
      ctx.addIssue({
        code: 'custom',
        message: 'duplicate acceptance criterion id',
        path: ['acceptanceCriteria'],
      });
    }
  });
export type TaskSpec = z.infer<typeof TaskSpec>;
