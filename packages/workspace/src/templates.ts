import type {
  ArtifactRef,
  ComponentInstance,
  WorkspacePatchOp,
  WorkspaceSpec,
} from '@reality/schemas';

export type ColumnType = 'number' | 'date' | 'string';
export interface Column {
  name: string;
  type: ColumnType;
  /** Distinct non-empty values (helps tell categories from identifiers). */
  distinct?: number;
  /** Numbers: every value is an integer. */
  integer?: boolean;
  min?: number;
  max?: number;
  /** Dates: earliest and latest value (YYYY-MM-DD…). */
  minDate?: string;
  maxDate?: string;
}

import { chooseValueColumn } from './columns.ts';

const fromTemplate = { proposedBy: 'template', verified: false } as const;

function component(
  type: string,
  props: Record<string, unknown>,
  bindings: ComponentInstance['bindings'],
  actions: string[] = [],
): ComponentInstance {
  return { type, typeVersion: '1.0.0', props, bindings, actions, provenance: fromTemplate };
}

/**
 * Deterministic starting workspace for a task. In M2 templates are the only composer;
 * the Workspace Agent (M6) will propose patches against the same engine.
 */
export function initialWorkspace(id: string, taskId: string): WorkspaceSpec {
  return {
    id,
    taskId,
    version: 0,
    workspaceType: 'data-analysis',
    layout: null,
    components: {
      plan: component('PlanView', { title: 'Plan' }, { plan: { kind: 'task', path: 'spec' } }),
      approvals: component(
        'ApprovalQueue',
        { title: 'Approvals' },
        { approval: { kind: 'task', path: 'approval' } },
        ['approve', 'deny'],
      ),
      activity: component(
        'AgentActivity',
        { title: 'Activity', maxItems: 200 },
        { events: { kind: 'task', path: 'events' } },
      ),
      runs: component('RunLog', { title: 'Runs' }, { runs: { kind: 'task', path: 'runs' } }),
      evidence: component(
        'EvidencePanel',
        { title: 'Evidence' },
        { verification: { kind: 'task', path: 'verification' } },
      ),
    },
  };
}

/** Template rule: once the capability agent is active, show what it acquires or reuses. */
export function opsForCapabilities(spec: WorkspaceSpec): WorkspacePatchOp[] {
  if (spec.components.capabilities) return [];
  return [
    {
      op: 'addComponent',
      instanceId: 'capabilities',
      component: component(
        'CapabilityCard',
        { title: 'Capabilities' },
        { capabilities: { kind: 'task', path: 'capabilities' } },
      ),
    },
  ];
}

/**
 * Picks a chart only when the data's shape makes one meaningful; otherwise none.
 * - long-format time series (date, one category, one number): one row per category
 * - time series (date + number): line of the per-date total
 * - one row per category (category + numbers, ≤ 50 rows): sorted bars
 */
export function chartFor(
  columns: readonly Column[],
  rowCount?: number,
): Record<string, unknown> | undefined {
  const dates = columns.filter((c) => c.type === 'date');
  const numbers = columns.filter((c) => c.type === 'number');
  const strings = columns.filter((c) => c.type === 'string');
  const date = dates[0];
  const named = (n: string) => columns.find((c) => c.name === n);

  // Forecast result: one line per kind (actual, backtest, forecast); never summed.
  const kind = named('kind');
  if (date && kind?.type === 'string' && named('lower') && named('upper')) {
    const series = numbers.find((c) => c.name !== 'lower' && c.name !== 'upper');
    if (series) {
      return {
        title: `${series.name} forecast`,
        mark: 'line',
        x: { field: date.name, type: 'temporal' },
        y: { field: series.name, type: 'quantitative' },
        color: { field: kind.name },
      };
    }
  }
  // Correlation result: one bar per variable, signed r.
  const variable = named('variable');
  if (variable?.type === 'string' && named('pearson_r')) {
    return {
      title: 'correlation (Pearson r) by variable',
      mark: 'bar',
      x: { field: variable.name, type: 'nominal', sort: '-y' },
      y: { field: 'pearson_r', type: 'quantitative' },
      // Components of the target and non-significant variables must not look like drivers.
      ...(named('role') ? { color: { field: 'role' } } : {}),
    };
  }

  // Not ids, codes or calendar parts (e.g. never plot a row number over time).
  const value = chooseValueColumn(columns, rowCount ?? 0);
  if (!value) return undefined;

  const only = strings.length === 1 ? strings[0] : undefined;
  if (date && only && numbers.length === 1) {
    const category = only;
    const facet = (category.distinct ?? 99) <= 6;
    return {
      title: `${value.name} by ${category.name}`,
      mark: 'line',
      x: { field: date.name, type: 'temporal' },
      y: { field: value.name, type: 'quantitative' },
      ...(facet ? { row: { field: category.name } } : { color: { field: category.name } }),
    };
  }
  if (date) {
    return {
      title: `${value.name} over ${date.name}`,
      mark: 'line',
      x: { field: date.name, type: 'temporal' },
      y: { field: value.name, type: 'quantitative', aggregate: 'sum' },
    };
  }
  const category = strings[0];
  if (
    strings.length === 1 &&
    category &&
    rowCount !== undefined &&
    rowCount <= 50 &&
    category.distinct === rowCount
  ) {
    return {
      title: `${value.name} by ${category.name}`,
      mark: 'bar',
      x: { field: category.name, type: 'nominal', sort: '-y' },
      y: { field: value.name, type: 'quantitative' },
    };
  }
  return undefined;
}

/**
 * Ops a template adds when a dataset is attached: always a table; a time-series chart
 * only when the data really has a date column and a numeric column to plot.
 */
export function opsForDataset(
  spec: WorkspaceSpec,
  artifact: ArtifactRef,
  filename: string,
  columns: readonly Column[],
  rowCount?: number,
): WorkspacePatchOp[] {
  const suffix = artifact.id.slice(0, 8);
  const ops: WorkspacePatchOp[] = [];
  const tableId = `table-${suffix}`;
  if (!spec.components[tableId]) {
    ops.push({
      op: 'addComponent',
      instanceId: tableId,
      component: component(
        'DataTable',
        { title: filename, pageSize: 50 },
        { rows: { kind: 'artifact', artifact } },
      ),
    });
  }

  const chart = chartFor(columns, rowCount);
  const chartId = `chart-${suffix}`;
  // Skip a chart identical in meaning to one already shown (e.g. per-date totals of data
  // that has one row per date).
  const duplicate = Object.values(spec.components).some(
    (c) => c.type === 'Chart' && chart && c.props.title === chart.title,
  );
  if (chart && !duplicate && !spec.components[chartId]) {
    ops.push({
      op: 'addComponent',
      instanceId: chartId,
      component: component(
        'Chart',
        { ...chart, maxRows: 5000 },
        { rows: { kind: 'artifact', artifact } },
      ),
    });
  }
  return ops;
}
