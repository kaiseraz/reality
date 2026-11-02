import { describe, expect, it } from 'vitest';
import type { ArtifactRef, WorkspaceSpec } from '@reality/schemas';
import { applyPatch, initialWorkspace, opsForDataset, registry } from '@reality/workspace';
import { planPanels } from './reconcile.ts';

const artifact: ArtifactRef = { id: 'abcdef12-x', sha256: 'a'.repeat(64), mediaType: 'text/csv' };
const ctx = { registry, columnsOf: () => ['week', 'revenue'] };

/** Simulates the dock: applies a plan to a list of panel ids. */
function applyPlan(ids: string[], spec: WorkspaceSpec) {
  const plan = planPanels(ids, spec);
  return {
    plan,
    ids: [...ids.filter((id) => !plan.remove.includes(id)), ...plan.add.map((a) => a.id)],
  };
}

describe('planPanels', () => {
  it('lays out the template: side column (plan, approvals), activity to its right', () => {
    const { plan } = applyPlan([], initialWorkspace('w', 't'));
    expect(plan.add).toEqual([
      { id: 'plan', title: 'Plan' },
      {
        id: 'activity',
        title: 'Activity',
        position: { referencePanel: 'plan', direction: 'right' },
      },
      {
        id: 'runs',
        title: 'Runs',
        position: { referencePanel: 'activity', direction: 'within' },
      },
      {
        id: 'approvals',
        title: 'Approvals',
        position: { referencePanel: 'plan', direction: 'below' },
      },
      {
        id: 'evidence',
        title: 'Evidence',
        position: { referencePanel: 'approvals', direction: 'below' },
      },
    ]);
  });

  it('places dataset views in the main area above the activity log, as tabs', () => {
    let spec = initialWorkspace('w', 't');
    const first = applyPlan([], spec);
    const r = applyPatch(
      spec,
      {
        workspaceId: 'w',
        baseVersion: 0,
        proposedBy: 'system',
        ops: opsForDataset(spec, artifact, 'sales.csv', [
          { name: 'week', type: 'date' },
          { name: 'revenue', type: 'number' },
        ]),
      },
      ctx,
    );
    if (!r.ok) throw new Error(r.errors.join());
    spec = r.spec;
    const { plan } = applyPlan(first.ids, spec);
    expect(plan.remove).toEqual([]);
    expect(plan.add.map((a) => [a.id, a.position])).toEqual([
      ['table-abcdef12', { referencePanel: 'activity', direction: 'above' }],
      ['chart-abcdef12', { referencePanel: 'table-abcdef12', direction: 'within' }],
    ]);
  });

  it('never re-creates surviving panels across 10 sequential patches', () => {
    let spec = initialWorkspace('w', 't');
    let ids = applyPlan([], spec).ids;
    const titles = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J'];
    for (const title of titles) {
      const r = applyPatch(
        spec,
        {
          workspaceId: 'w',
          baseVersion: spec.version,
          proposedBy: 'user',
          ops: [{ op: 'updateProps', instanceId: 'plan', props: { title } }],
        },
        ctx,
      );
      if (!r.ok) throw new Error(r.errors.join());
      spec = r.spec;
      const step = applyPlan(ids, spec);
      expect(step.plan.remove).toEqual([]);
      expect(step.plan.add).toEqual([]);
      expect(step.plan.retitle.find((t) => t.id === 'plan')?.title).toBe(title);
      ids = step.ids;
    }
    expect(spec.version).toBe(10);
  });

  it('removes panels whose instance left the spec', () => {
    const spec = initialWorkspace('w', 't');
    const { plan } = applyPlan(
      ['plan', 'approvals', 'activity', 'runs', 'evidence', 'stale'],
      spec,
    );
    expect(plan.remove).toEqual(['stale']);
    expect(plan.add).toEqual([]);
  });
});
