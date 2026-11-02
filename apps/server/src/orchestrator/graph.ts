import { Annotation, END, START, StateGraph, interrupt } from '@langchain/langgraph';
import type { BaseCheckpointSaver } from '@langchain/langgraph-checkpoint';
import { ApprovalDecision, TaskSpec, type PlanStep } from '@reality/schemas';
import type { EventLog } from '../events/event-log.ts';
import { PlannerError, type DatasetInfo, type Planner } from '../planner/planner.ts';

export interface Budget {
  maxModelCalls: number;
  modelCalls: number;
  maxSteps: number;
  steps: number;
  inputTokens: number;
  outputTokens: number;
}

export interface StepResult {
  stepId: string;
  status: 'done' | 'failed' | 'not_executed' | 'skipped';
  detail: string;
  /** Sandbox run that produced this result, if any. */
  runId?: string;
  /** Artifacts produced by this step. */
  artifacts?: string[];
  /** Structured summary written by the step (e.g. seasonal strength). */
  summary?: unknown;
}

export interface CheckResult {
  criterionId: string;
  status: 'passed' | 'failed' | 'unverified';
  detail: string;
  /** Sandbox run that performed the check, if any. */
  runId?: string;
  evidence?: unknown;
}

export type Outcome = 'completed' | 'rejected' | 'failed' | 'budget_exceeded';

export type StepExecutor = (step: PlanStep, ctx: { taskId: string }) => Promise<StepResult>;

/** Used when no executor is wired: steps are recorded as not executed. Nothing is faked. */
export const noExecutor: StepExecutor = async (step) => ({
  stepId: step.id,
  status: 'not_executed',
  detail: `No executor registered for ${step.agent}.`,
});

/** Serializable (checkpointed) description of a capability awaiting approval. */
export interface CapabilityProposal {
  capabilityId: string;
  need: string;
  [key: string]: unknown;
}

export interface CapabilityAgent {
  /** Reuse an enabled capability, or discover + inspect a candidate for approval. */
  prepare(
    need: string,
    taskId: string,
  ): Promise<
    | { kind: 'reuse'; capabilityId: string; detail: string }
    | { kind: 'proposal'; proposal: CapabilityProposal }
    | { kind: 'unavailable'; detail: string }
  >;
  /** Install into an isolated layer and run requirement tests. */
  install(
    proposal: CapabilityProposal,
    taskId: string,
  ): Promise<{ ok: true; capabilityId: string; detail: string } | { ok: false; detail: string }>;
  reject(proposal: CapabilityProposal, taskId: string, note?: string): Promise<void>;
}

export type Verifier = (ctx: {
  taskId: string;
  spec: TaskSpec;
  stepResults: StepResult[];
}) => Promise<CheckResult[]>;

export const DEFAULT_BUDGET: Budget = {
  maxModelCalls: 3,
  modelCalls: 0,
  maxSteps: 50,
  steps: 0,
  inputTokens: 0,
  outputTokens: 0,
};

const replace = <T>(defaultValue: () => T) =>
  Annotation<T>({ reducer: (_prev, next) => next, default: defaultValue });

export const OrchestratorState = Annotation.Root({
  taskId: Annotation<string>,
  request: Annotation<string>,
  spec: replace<TaskSpec | null>(() => null),
  approval: replace<ApprovalDecision | null>(() => null),
  stepIndex: replace<number>(() => 0),
  stepResults: Annotation<StepResult[]>({
    reducer: (prev, next) => prev.concat(next),
    default: () => [],
  }),
  pendingCapability: replace<{ stepId: string; proposal: CapabilityProposal } | null>(() => null),
  verification: replace<CheckResult[]>(() => []),
  budget: replace<Budget>(() => DEFAULT_BUDGET),
  outcome: replace<Outcome | null>(() => null),
  error: replace<string | null>(() => null),
});
export type OrchestratorStateType = typeof OrchestratorState.State;

export interface GraphDeps {
  planner: Planner;
  events: EventLog;
  checkpointer: BaseCheckpointSaver;
  executeStep?: StepExecutor;
  /** Planning context: attached datasets (schema only) and enabled capabilities. */
  context?: (
    taskId: string,
  ) => Promise<{ datasets: DatasetInfo[]; availableCapabilities: string[] }>;
  /** Semantic checks beyond the schema (recipes, checks, columns, capabilities). */
  validateSpec?: (
    spec: TaskSpec,
    ctx: { datasets: DatasetInfo[]; availableCapabilities: string[] },
  ) => string[];
  capabilities?: CapabilityAgent;
  verifier?: Verifier;
  /** Artificial per-step delay; used by crash/resume tests. */
  stepDelayMs?: number;
}

function formatIssues(error: { issues: { path: PropertyKey[]; message: string }[] }): string {
  return error.issues.map((i) => `- ${i.path.join('.') || '(root)'}: ${i.message}`).join('\n');
}

const currentStep = (s: OrchestratorStateType): PlanStep | undefined =>
  s.spec?.workflow[s.stepIndex];

/** For nodes that are only routed to when these invariants hold. */
function invariant<T>(value: T | null | undefined, what: string): T {
  if (value === null || value === undefined)
    throw new Error(`Orchestrator invariant violated: ${what}`);
  return value;
}

export function buildGraph(deps: GraphDeps) {
  const executeStep = deps.executeStep ?? noExecutor;

  /** Where to go after any step-level node. */
  type StepTarget = 'execute' | 'cap_prepare' | 'verify' | typeof END;
  const next = (s: OrchestratorStateType): StepTarget => {
    if (s.outcome) return END;
    const step = currentStep(s);
    if (!step) return 'verify';
    if (step.agent === 'capability-agent' && deps.capabilities && !blockedBy(s, step)) {
      return 'cap_prepare';
    }
    return 'execute';
  };

  /** A step whose dependency did not finish successfully must not run on missing data. */
  const blockedBy = (s: OrchestratorStateType, step: PlanStep): StepResult | undefined =>
    step.dependsOn
      .map((dep) => s.stepResults.findLast((r) => r.stepId === dep))
      .find((r) => r !== undefined && r.status !== 'done');

  const finishStep = async (s: OrchestratorStateType, step: PlanStep, result: StepResult) => {
    await deps.events.append(s.taskId, 'step.completed', step.agent, result);
    return {
      stepIndex: s.stepIndex + 1,
      stepResults: [result],
      pendingCapability: null,
      budget: { ...s.budget, steps: s.budget.steps + 1 },
    };
  };

  const plan = async (state: OrchestratorStateType) => {
    const budget = { ...state.budget };
    const context = (await deps.context?.(state.taskId)) ?? {
      datasets: [],
      availableCapabilities: [],
    };
    let feedback: string | undefined;

    while (budget.modelCalls < budget.maxModelCalls) {
      budget.modelCalls += 1;
      let output;
      try {
        output = await deps.planner.propose({
          request: state.request,
          taskId: state.taskId,
          datasets: context.datasets,
          availableCapabilities: context.availableCapabilities,
          ...(feedback ? { feedback } : {}),
        });
      } catch (err) {
        if (err instanceof PlannerError && err.retryable) {
          feedback = undefined;
          await deps.events.append(state.taskId, 'plan.invalid', 'orchestrator', {
            attempt: budget.modelCalls,
            reason: err.message,
          });
          continue;
        }
        const message = err instanceof Error ? err.message : String(err);
        return { budget, outcome: 'failed' as const, error: message };
      }
      budget.inputTokens += output.usage.inputTokens;
      budget.outputTokens += output.usage.outputTokens;

      const parsed = TaskSpec.safeParse(output.draft);
      const semantic = parsed.success ? (deps.validateSpec?.(parsed.data, context) ?? []) : [];
      if (parsed.success && semantic.length > 0) {
        feedback = semantic.map((e) => `- ${e}`).join('\n');
        await deps.events.append(state.taskId, 'plan.invalid', 'orchestrator', {
          model: output.model,
          attempt: budget.modelCalls,
          issues: feedback,
        });
        continue;
      }
      if (parsed.success) {
        await deps.events.append(state.taskId, 'plan.created', 'orchestrator', {
          model: output.model,
          attempt: budget.modelCalls,
          spec: parsed.data,
        });
        return { budget, spec: parsed.data };
      }
      feedback = formatIssues(parsed.error);
      await deps.events.append(state.taskId, 'plan.invalid', 'orchestrator', {
        model: output.model,
        attempt: budget.modelCalls,
        issues: feedback,
      });
    }
    return {
      budget,
      outcome: 'budget_exceeded' as const,
      error: `No valid plan within ${budget.maxModelCalls} model calls.`,
    };
  };

  // interrupt() pauses here; on resume the node re-runs and interrupt() returns the
  // decision. Nothing before interrupt() may have side effects.
  const approve = async (state: OrchestratorStateType) => {
    const raw: unknown = interrupt({ kind: 'plan-approval', spec: state.spec });
    const decision = ApprovalDecision.parse(raw);
    await deps.events.append(
      state.taskId,
      decision.approved ? 'approval.granted' : 'approval.denied',
      decision.by === 'policy' ? 'policy' : 'user',
      decision,
    );
    return decision.approved
      ? { approval: decision }
      : { approval: decision, outcome: 'rejected' as const };
  };

  // One step per invocation, so every step boundary is a checkpoint.
  const execute = async (state: OrchestratorStateType) => {
    const step = currentStep(state);
    if (!step) return {};
    if (state.budget.steps >= state.budget.maxSteps) {
      return {
        outcome: 'budget_exceeded' as const,
        error: `Step budget of ${state.budget.maxSteps} exhausted.`,
      };
    }
    await deps.events.append(state.taskId, 'step.started', step.agent, { stepId: step.id });
    if (deps.stepDelayMs) await new Promise((r) => setTimeout(r, deps.stepDelayMs));
    const blocker = blockedBy(state, step);
    if (blocker) {
      return finishStep(state, step, {
        stepId: step.id,
        status: 'skipped',
        detail: `Skipped: depends on "${blocker.stepId}", which ${blocker.status.replace('_', ' ')}.`,
      });
    }
    let result: StepResult;
    try {
      result = await executeStep(step, { taskId: state.taskId });
    } catch (err) {
      result = {
        stepId: step.id,
        status: 'failed',
        detail: `Executor error: ${(err as Error).message}`,
      };
    }
    return finishStep(state, step, result);
  };

  const capPrepare = async (state: OrchestratorStateType) => {
    const step = invariant(currentStep(state), 'current step');
    await deps.events.append(state.taskId, 'step.started', step.agent, { stepId: step.id });
    const need = step.capability ?? step.description;
    let prepared;
    try {
      prepared = await invariant(deps.capabilities, 'capability agent').prepare(need, state.taskId);
    } catch (err) {
      return finishStep(state, step, {
        stepId: step.id,
        status: 'failed',
        detail: `Capability search failed: ${(err as Error).message}`,
      });
    }
    if (prepared.kind === 'reuse') {
      return finishStep(state, step, { stepId: step.id, status: 'done', detail: prepared.detail });
    }
    if (prepared.kind === 'unavailable') {
      return finishStep(state, step, {
        stepId: step.id,
        status: 'failed',
        detail: prepared.detail,
      });
    }
    return { pendingCapability: { stepId: step.id, proposal: prepared.proposal } };
  };

  // Installing third-party code always needs a human decision.
  const capApprove = async (state: OrchestratorStateType) => {
    const pending = invariant(state.pendingCapability, 'pending capability');
    const raw: unknown = interrupt({ kind: 'capability-approval', proposal: pending.proposal });
    const parsed = ApprovalDecision.parse(raw);
    // Defence in depth: the scheduler never sends this, and if it did, it would not count.
    const decision =
      parsed.by === 'policy'
        ? {
            approved: false,
            by: 'policy' as const,
            note: 'Only a person may approve installing a capability.',
          }
        : parsed;
    await deps.events.append(
      state.taskId,
      decision.approved ? 'approval.granted' : 'approval.denied',
      decision.by === 'policy' ? 'policy' : 'user',
      { ...decision, capability: pending.proposal.capabilityId },
    );
    if (decision.approved) return {};
    const step = invariant(currentStep(state), 'current step');
    await invariant(deps.capabilities, 'capability agent').reject(
      pending.proposal,
      state.taskId,
      decision.note,
    );
    return finishStep(state, step, {
      stepId: step.id,
      status: 'failed',
      detail: `Installation of ${pending.proposal.capabilityId} was denied${decision.note ? `: ${decision.note}` : '.'}`,
    });
  };

  const capInstall = async (state: OrchestratorStateType) => {
    const step = invariant(currentStep(state), 'current step');
    const pending = invariant(state.pendingCapability, 'pending capability');
    let outcome;
    try {
      outcome = await invariant(deps.capabilities, 'capability agent').install(
        pending.proposal,
        state.taskId,
      );
    } catch (err) {
      outcome = { ok: false as const, detail: `Installation error: ${(err as Error).message}` };
    }
    return finishStep(state, step, {
      stepId: step.id,
      status: outcome.ok ? 'done' : 'failed',
      detail: outcome.detail,
    });
  };

  const verify = async (state: OrchestratorStateType) => {
    let verification: CheckResult[];
    if (deps.verifier && state.spec) {
      verification = await deps.verifier({
        taskId: state.taskId,
        spec: state.spec,
        stepResults: state.stepResults,
      });
    } else {
      verification = (state.spec?.acceptanceCriteria ?? []).map((ac) => ({
        criterionId: ac.id,
        status: 'unverified',
        detail: `No ${ac.checkType} checker is configured.`,
      }));
    }
    await deps.events.append(state.taskId, 'verification.completed', 'verification-agent', {
      results: verification,
    });
    return { verification, outcome: 'completed' as const };
  };

  const stepTargets: StepTarget[] = ['execute', 'cap_prepare', 'verify', END];
  return new StateGraph(OrchestratorState)
    .addNode('plan', plan)
    .addNode('approve', approve)
    .addNode('execute', execute)
    .addNode('cap_prepare', capPrepare)
    .addNode('cap_approve', capApprove)
    .addNode('cap_install', capInstall)
    .addNode('verify', verify)
    .addEdge(START, 'plan')
    .addConditionalEdges('plan', (s) => (s.outcome ? END : 'approve'), ['approve', END])
    .addConditionalEdges('approve', next, stepTargets)
    .addConditionalEdges('execute', next, stepTargets)
    .addConditionalEdges(
      'cap_prepare',
      (s): StepTarget | 'cap_approve' => (s.pendingCapability ? 'cap_approve' : next(s)),
      ['cap_approve', ...stepTargets],
    )
    .addConditionalEdges(
      'cap_approve',
      (s): StepTarget | 'cap_install' => (s.pendingCapability ? 'cap_install' : next(s)),
      ['cap_install', ...stepTargets],
    )
    .addConditionalEdges('cap_install', next, stepTargets)
    .addEdge('verify', END)
    .compile({ checkpointer: deps.checkpointer });
}

export type OrchestratorGraph = ReturnType<typeof buildGraph>;
