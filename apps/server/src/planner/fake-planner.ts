import type { Planner, PlannerInput, PlannerOutput, TaskSpecDraft } from './planner.ts';

/** A deterministic, valid draft derived from the request text. */
export function defaultDraft(request: string): TaskSpecDraft {
  return {
    goal: request,
    constraints: [],
    requiredOutputs: ['analysis result'],
    risks: [],
    acceptanceCriteria: [
      { id: 'ac1', description: 'Result is produced by sandboxed execution', checkType: 'test' },
    ],
    workflow: [
      { id: 's1', description: 'Profile the input data', agent: 'analysis-agent', dependsOn: [] },
      { id: 's2', description: 'Run the analysis', agent: 'analysis-agent', dependsOn: ['s1'] },
      { id: 's3', description: 'Check results', agent: 'verification-agent', dependsOn: ['s2'] },
    ],
    missingCapabilities: [],
    candidateWorkspaces: ['data-analysis'],
  };
}

/**
 * Offline planner for tests and keyless development. It is labelled as fake in every
 * event it produces (model = "fake-planner"), so its output can't pass for real planning.
 * `script` lets tests feed specific outputs (e.g. invalid ones) in order.
 */
export class FakePlanner implements Planner {
  readonly name = 'fake-planner';
  calls: PlannerInput[] = [];

  constructor(private readonly script: unknown[] = []) {}

  async propose(input: PlannerInput): Promise<PlannerOutput> {
    const index = this.calls.length;
    this.calls.push(input);
    const draft = index < this.script.length ? this.script[index] : defaultDraft(input.request);
    return { draft, model: this.name, usage: { inputTokens: 0, outputTokens: 0 } };
  }
}
