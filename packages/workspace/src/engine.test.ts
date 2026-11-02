import { describe, expect, it } from 'vitest';
import type { ArtifactRef, WorkspacePatchOp, WorkspaceSpec } from '@reality/schemas';
import { applyPatch, type EngineContext } from './engine.ts';
import { registry } from './registry.ts';
import { initialWorkspace, opsForDataset } from './templates.ts';

const artifact: ArtifactRef = { id: 'art-1', sha256: 'a'.repeat(64), mediaType: 'text/csv' };
const columns = { 'art-1': ['week', 'revenue', 'region'] } as Record<string, string[]>;
const ctx: EngineContext = { registry, columnsOf: (id) => columns[id] };

const base = () => initialWorkspace('ws-1', 'task-1');

function patch(spec: WorkspaceSpec, ops: unknown[]) {
  return applyPatch(
    spec,
    { workspaceId: spec.id, baseVersion: spec.version, proposedBy: 'workspace-agent', ops },
    ctx,
  );
}

function mustApply(
  spec: WorkspaceSpec,
  ops: unknown[],
): { spec: WorkspaceSpec; inverse: WorkspacePatchOp[] } {
  const r = patch(spec, ops);
  if (!r.ok) throw new Error(r.errors.join('\n'));
  return r;
}

const table = {
  type: 'DataTable',
  typeVersion: '1.0.0',
  props: { title: 'Sales' },
  bindings: { rows: { kind: 'artifact', artifact } },
  provenance: { proposedBy: 'workspace-agent' },
};

describe('initial workspace', () => {
  it('only contains valid, registered components', () => {
    const spec = base();
    for (const [id, c] of Object.entries(spec.components)) {
      const r = applyPatch(
        { ...spec, components: {} },
        {
          workspaceId: spec.id,
          baseVersion: 0,
          proposedBy: 'system',
          ops: [{ op: 'addComponent', instanceId: id, component: c }],
        },
        ctx,
      );
      expect(r.ok, JSON.stringify(r)).toBe(true);
    }
  });
});

describe('applyPatch', () => {
  it('adds a component, applies prop defaults and bumps the version', () => {
    const { spec } = mustApply(base(), [{ op: 'addComponent', instanceId: 't', component: table }]);
    expect(spec.version).toBe(1);
    expect(spec.components.t?.props).toEqual({ title: 'Sales', pageSize: 50 });
  });

  it.each([
    ['unknown component type', { ...table, type: 'EvalHtml' }, /unknown component type/],
    ['incompatible major version', { ...table, typeVersion: '2.0.0' }, /incompatible/],
    ['unknown prop', { ...table, props: { title: 'x', onClick: 'alert(1)' } }, /props/],
    ['invalid prop value', { ...table, props: { title: 'x', pageSize: 100000 } }, /pageSize/],
    ['undeclared action', { ...table, actions: ['deleteAll'] }, /no action "deleteAll"/],
    ['missing required input', { ...table, bindings: {} }, /required input "rows"/],
    [
      'wrong binding kind',
      { ...table, bindings: { rows: { kind: 'task', path: 'events' } } },
      /expects a artifact binding/,
    ],
    [
      'artifact that does not exist',
      {
        ...table,
        bindings: { rows: { kind: 'artifact', artifact: { ...artifact, id: 'ghost' } } },
      },
      /does not exist/,
    ],
  ])('rejects %s', (_name, component, message) => {
    const r = patch(base(), [{ op: 'addComponent', instanceId: 't', component }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join('\n')).toMatch(message);
  });

  it('rejects chart fields that are not columns of the bound dataset', () => {
    const chart = {
      type: 'Chart',
      typeVersion: '1.0.0',
      props: {
        title: 'x',
        mark: 'line',
        x: { field: 'week', type: 'temporal' },
        y: { field: 'profit', type: 'quantitative' },
      },
      bindings: { rows: { kind: 'artifact', artifact } },
      provenance: { proposedBy: 'workspace-agent' },
    };
    const r = patch(base(), [{ op: 'addComponent', instanceId: 'c', component: chart }]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.join()).toMatch(/"profit" not found/);
  });

  it('rejects stale patches (optimistic concurrency)', () => {
    const r = applyPatch(
      base(),
      {
        workspaceId: 'ws-1',
        baseVersion: 5,
        proposedBy: 'user',
        ops: [{ op: 'removeComponent', instanceId: 'plan' }],
      },
      ctx,
    );
    expect(r.ok).toBe(false);
  });

  it('is atomic: one bad op leaves the workspace untouched', () => {
    const spec = base();
    const r = patch(spec, [
      { op: 'removeComponent', instanceId: 'plan' },
      { op: 'removeComponent', instanceId: 'nope' },
    ]);
    expect(r.ok).toBe(false);
    expect(spec.components.plan).toBeDefined();
  });

  it('inverse ops restore the exact previous spec', () => {
    let spec = base();
    const original = JSON.parse(JSON.stringify(spec)) as WorkspaceSpec;
    const steps: WorkspacePatchOp[][] = [];
    const ops: unknown[][] = [
      [{ op: 'addComponent', instanceId: 't', component: table }],
      [{ op: 'updateProps', instanceId: 't', props: { pageSize: 100 } }],
      [
        {
          op: 'rebind',
          instanceId: 'activity',
          input: 'events',
          binding: { kind: 'task', path: 'events' },
        },
      ],
      [{ op: 'setLayout', layout: { grid: 'x' } }],
      [{ op: 'removeComponent', instanceId: 'plan' }],
    ];
    for (const o of ops) {
      const r = mustApply(spec, o);
      steps.push(r.inverse);
      spec = r.spec;
    }
    for (const inverse of steps.reverse()) spec = mustApply(spec, inverse).spec;

    expect(spec.components).toEqual(original.components);
    expect(spec.layout).toEqual(original.layout);
    expect(spec.version).toBe(10); // undo is a new version, history is append-only
  });
});

describe('dataset template', () => {
  it('adds a table always and a chart only when a date and a number column exist', () => {
    const withChart = opsForDataset(base(), artifact, 'sales.csv', [
      { name: 'week', type: 'date' },
      { name: 'revenue', type: 'number' },
    ]);
    expect(withChart.map((o) => o.op === 'addComponent' && o.component.type)).toEqual([
      'DataTable',
      'Chart',
    ]);
    expect(mustApply(base(), withChart).spec.version).toBe(1);

    const tableOnly = opsForDataset(base(), artifact, 'names.csv', [
      { name: 'region', type: 'string' },
    ]);
    expect(tableOnly).toHaveLength(1);
  });
});
