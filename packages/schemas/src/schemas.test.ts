import { describe, expect, it } from 'vitest';
import { TaskSpec, WorkspacePatch, canTransition } from './index.ts';

const validTask = {
  goal: 'Find weekly revenue seasonality',
  requiredOutputs: ['seasonality finding'],
  acceptanceCriteria: [{ id: 'ac1', description: 'totals match', checkType: 'recompute' }],
  workflow: [
    { id: 's1', description: 'profile data', agent: 'analysis-agent' },
    { id: 's2', description: 'aggregate weekly', agent: 'analysis-agent', dependsOn: ['s1'] },
  ],
};

describe('TaskSpec', () => {
  it('accepts a valid spec and applies defaults', () => {
    const spec = TaskSpec.parse(validTask);
    expect(spec.constraints).toEqual([]);
    expect(spec.workflow[0]?.status).toBe('pending');
  });

  it('rejects dependencies on unknown steps', () => {
    const bad = {
      ...validTask,
      workflow: [{ id: 's1', description: 'x', agent: 'analysis-agent', dependsOn: ['nope'] }],
    };
    expect(TaskSpec.safeParse(bad).success).toBe(false);
  });

  it('rejects unknown agents and check types', () => {
    expect(
      TaskSpec.safeParse({
        ...validTask,
        workflow: [{ id: 's1', description: 'x', agent: 'root-shell' }],
      }).success,
    ).toBe(false);
    expect(
      TaskSpec.safeParse({
        ...validTask,
        acceptanceCriteria: [{ id: 'a', description: 'x', checkType: 'vibes' }],
      }).success,
    ).toBe(false);
  });
});

describe('WorkspacePatch', () => {
  it('rejects unknown patch operations', () => {
    const result = WorkspacePatch.safeParse({
      workspaceId: 'w1',
      baseVersion: 0,
      proposedBy: 'workspace-agent',
      ops: [{ op: 'evalScript', code: 'alert(1)' }],
    });
    expect(result.success).toBe(false);
  });
});

describe('capability lifecycle', () => {
  it('cannot skip from discovered to trusted', () => {
    expect(canTransition('discovered', 'trusted')).toBe(false);
    expect(canTransition('discovered', 'inspected')).toBe(true);
  });

  it('rejected is terminal', () => {
    expect(canTransition('rejected', 'discovered')).toBe(false);
  });
});
