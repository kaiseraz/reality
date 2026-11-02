import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComponentInstance, TaskEvent, WorkspaceSpec } from '@reality/schemas';
import { COMPONENTS, initialWorkspace, opsForDataset, registry } from '@reality/workspace';
import type { TaskDetail } from '../api.ts';
import { buildVegaLiteSpec } from './components/chart-spec.ts';
import {
  makeEmit,
  UndeclaredActionError,
  WorkspaceContext,
  type WorkspaceData,
} from './context.ts';
import { RENDERERS } from './renderers.ts';

vi.mock('vega-embed', () => ({
  default: vi.fn(async () => ({ finalize: () => undefined })),
}));

const artifact = { id: 'art-12345678', sha256: 'a'.repeat(64), mediaType: 'text/csv' };
const columns = [
  { name: 'week', type: 'date' },
  { name: 'revenue', type: 'number' },
];
const allRows = Array.from({ length: 120 }, (_, i) => ({
  week: `2025-01-${(i % 28) + 1}`,
  revenue: i,
}));

function workspaceWithData(): WorkspaceSpec {
  const spec = initialWorkspace('ws-1', 'task-1');
  for (const op of opsForDataset(spec, artifact, 'sales.csv', columns as never)) {
    if (op.op === 'addComponent') spec.components[op.instanceId] = op.component;
  }
  return spec;
}

const task: TaskDetail = {
  id: 'task-1',
  request: 'Find seasonality',
  status: 'awaiting_approval',
  createdAt: '2025-08-11T00:00:00.000Z',
  updatedAt: '2025-08-11T00:00:00.000Z',
  pendingApproval: { kind: 'plan-approval' },
  state: {
    spec: {
      goal: 'Find seasonality',
      constraints: [],
      requiredOutputs: ['x'],
      resources: [],
      risks: [],
      acceptanceCriteria: [{ id: 'ac1', description: 'Totals match', checkType: 'recompute' }],
      workflow: [
        {
          id: 's1',
          description: 'Profile data',
          agent: 'analysis-agent',
          dependsOn: [],
          status: 'pending',
        },
      ],
      missingCapabilities: [],
      candidateWorkspaces: [],
    },
  },
};
const events: TaskEvent[] = [
  {
    id: 1,
    taskId: 'task-1',
    type: 'task.created',
    actor: 'user',
    payload: {},
    createdAt: '2025-08-11T00:00:00.000Z',
  },
];

let sendAction: ReturnType<typeof vi.fn>;

function renderInstance(
  spec: WorkspaceSpec,
  id: string,
): { rerender: (i: ComponentInstance) => void } {
  const ctx = (s: WorkspaceSpec): WorkspaceData => ({
    spec: s,
    task,
    events,
    sendAction: sendAction as unknown as WorkspaceData['sendAction'],
  });
  const view = (instance: ComponentInstance): ReactNode => {
    const Renderer = RENDERERS[instance.type]!;
    return (
      <WorkspaceContext.Provider value={ctx(spec)}>
        <Renderer
          instanceId={id}
          instance={instance}
          emit={makeEmit(id, instance, ctx(spec).sendAction)}
        />
      </WorkspaceContext.Provider>
    );
  };
  const r = render(view(spec.components[id]!));
  return { rerender: (i) => r.rerender(view(i)) };
}

beforeEach(() => {
  sendAction = vi.fn(async () => undefined);
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'http://x');
      if (url.pathname.endsWith('/runs')) return Response.json([]);
      const offset = Number(url.searchParams.get('offset'));
      const limit = Number(url.searchParams.get('limit'));
      return Response.json({
        columns,
        total: allRows.length,
        offset,
        rows: allRows.slice(offset, offset + limit),
      });
    }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('renderer registry', () => {
  it('has exactly one renderer per registered component type', () => {
    expect(Object.keys(RENDERERS).sort()).toEqual(registry.types().sort());
  });
});

describe('no dead controls', () => {
  const spec = workspaceWithData();
  it.each(Object.keys(spec.components))(
    '%s: every button is a declared action or a local view control',
    async (id) => {
      renderInstance(spec, id);
      await waitFor(() => expect(document.body.textContent).not.toMatch(/Loading/));
      const def = COMPONENTS.find((c) => c.type === spec.components[id]!.type)!;
      for (const button of screen.queryAllByRole('button')) {
        const action = button.getAttribute('data-action');
        const local = button.getAttribute('data-local');
        expect(
          action ?? local,
          `button "${button.textContent}" has no declared purpose`,
        ).toBeTruthy();
        if (action) {
          expect(Object.keys(def.actions)).toContain(action);
          expect(spec.components[id]!.actions).toContain(action);
        }
      }
    },
  );
});

describe('actions', () => {
  it('ApprovalQueue sends approve through the router with the note', async () => {
    renderInstance(workspaceWithData(), 'approvals');
    fireEvent.change(screen.getByLabelText(/note/i), { target: { value: 'looks good' } });
    fireEvent.click(screen.getByRole('button', { name: 'Approve plan' }));
    await waitFor(() =>
      expect(sendAction).toHaveBeenCalledWith('approvals', 'approve', { note: 'looks good' }),
    );
  });

  it('emit refuses actions the instance does not declare', async () => {
    const spec = workspaceWithData();
    const emit = makeEmit('plan', spec.components.plan!, sendAction as never);
    await expect(emit('approve')).rejects.toBeInstanceOf(UndeclaredActionError);
    expect(sendAction).not.toHaveBeenCalled();
  });
});

describe('DataTable', () => {
  it('pages through real rows and keeps its page when a patch changes its props', async () => {
    const spec = workspaceWithData();
    const id = 'table-art-1234';
    const { rerender } = renderInstance(spec, id);
    expect(await screen.findByTestId('range')).toHaveProperty('textContent', '1–50 of 120');

    fireEvent.click(screen.getByRole('button', { name: 'Next' }));
    await waitFor(() => expect(screen.getByTestId('range').textContent).toBe('51–100 of 120'));

    // A patch renames the panel; the component must keep its paging state.
    rerender({
      ...spec.components[id]!,
      props: { ...spec.components[id]!.props, title: 'Renamed' },
    });
    await new Promise((r) => setTimeout(r, 20));
    expect(screen.getByTestId('range').textContent).toBe('51–100 of 120');
  });
});

describe('Chart', () => {
  it('builds a Vega-Lite spec from typed props only', () => {
    const vl = buildVegaLiteSpec(
      {
        title: 't',
        mark: 'line',
        x: { field: 'week', type: 'temporal' },
        y: { field: 'revenue', type: 'quantitative', aggregate: 'sum' },
      },
      [{ week: '2023-10-25', revenue: 1 }],
    ) as unknown as Record<string, unknown>;
    expect(vl.data).toEqual({ values: [{ week: '2023-10-25', revenue: 1 }] });
    expect(vl.encoding).toEqual({
      x: { field: 'week', type: 'temporal' },
      y: { field: 'revenue', type: 'quantitative', aggregate: 'sum', scale: { zero: false } },
    });
  });

  it('says so when it shows only part of the data', async () => {
    const spec = workspaceWithData();
    const chart = spec.components['chart-art-1234']!;
    renderInstance(
      {
        ...spec,
        components: {
          ...spec.components,
          c: { ...chart, props: { ...chart.props, maxRows: 100 } },
        },
      },
      'c',
    );
    expect(await screen.findByText(/Showing the first 100 of 120 rows/)).toBeDefined();
  });
});
