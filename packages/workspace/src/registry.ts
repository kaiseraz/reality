import { z } from 'zod';
import type { TaskStatePath } from '@reality/schemas';

/** Which data a component input accepts. */
export type InputSpec =
  | { kind: 'artifact'; mediaTypes: readonly string[]; required: boolean }
  | { kind: 'task'; path: TaskStatePath; required: boolean };

export interface ActionSpec {
  description: string;
  payload: z.ZodType;
  /**
   * Where the action takes effect. `task` actions are routed to the orchestrator and
   * checked against task state; there are no client-only "decorative" actions.
   */
  target: 'task';
}

/** A reference from props to a column of a bound artifact, checked against real columns. */
export interface FieldRef {
  input: string;
  field: string;
}

export interface ComponentDefinition {
  type: string;
  version: string;
  description: string;
  props: z.ZodType<Record<string, unknown>>;
  inputs: Record<string, InputSpec>;
  actions: Record<string, ActionSpec>;
  /** Where a template places it when no layout says otherwise. */
  defaultRegion: 'main' | 'side' | 'bottom';
  fieldRefs?: (props: Record<string, unknown>) => FieldRef[];
}

const title = z.string().min(1).max(120);
const CSV = ['text/csv'] as const;

const ChartEncoding = z.object({
  field: z.string().min(1),
  type: z.enum(['temporal', 'quantitative', 'nominal', 'ordinal']),
  aggregate: z.enum(['sum', 'mean', 'median', 'min', 'max', 'count']).optional(),
  timeUnit: z.enum(['year', 'yearmonth', 'yearweek', 'yearmonthdate']).optional(),
  /** Bar ordering, e.g. "-y" for descending by value. */
  sort: z.enum(['x', '-x', 'y', '-y']).optional(),
});

/**
 * Approved, tested components. Adding a type here is a reviewed code change; the AI
 * can only compose and configure what is listed, never introduce new UI code.
 */
export const COMPONENTS: readonly ComponentDefinition[] = [
  {
    type: 'PlanView',
    version: '1.0.0',
    description: 'The task plan: goal, workflow steps with their results, acceptance criteria.',
    props: z.object({ title: title.default('Plan') }).strict(),
    inputs: { plan: { kind: 'task', path: 'spec', required: true } },
    actions: {},
    defaultRegion: 'side',
  },
  {
    type: 'AgentActivity',
    version: '1.0.0',
    description: 'Live log of agent, tool and user events for the task.',
    props: z
      .object({
        title: title.default('Activity'),
        maxItems: z.number().int().min(10).max(1000).default(200),
      })
      .strict(),
    inputs: { events: { kind: 'task', path: 'events', required: true } },
    actions: {},
    defaultRegion: 'bottom',
  },
  {
    type: 'ApprovalQueue',
    version: '1.0.0',
    description: 'Pending human approvals for the task, with approve and deny controls.',
    props: z.object({ title: title.default('Approvals') }).strict(),
    inputs: { approval: { kind: 'task', path: 'approval', required: true } },
    actions: {
      approve: {
        description: 'Approve the pending request.',
        payload: z.object({ note: z.string().max(2000).optional() }).strict(),
        target: 'task',
      },
      deny: {
        description: 'Deny the pending request.',
        payload: z.object({ note: z.string().max(2000).optional() }).strict(),
        target: 'task',
      },
    },
    defaultRegion: 'side',
  },
  {
    type: 'RunLog',
    version: '1.0.0',
    description: 'Every sandbox run for the task: the exact code, status, duration and output.',
    props: z.object({ title: title.default('Runs') }).strict(),
    inputs: { runs: { kind: 'task', path: 'runs', required: true } },
    actions: {},
    defaultRegion: 'bottom',
  },
  {
    type: 'EvidencePanel',
    version: '1.0.0',
    description:
      'Verification results: each acceptance criterion with its verdict, the independent check and its evidence.',
    props: z.object({ title: title.default('Evidence') }).strict(),
    inputs: { verification: { kind: 'task', path: 'verification', required: true } },
    actions: {},
    defaultRegion: 'side',
  },
  {
    type: 'CapabilityCard',
    version: '1.0.0',
    description:
      'Capabilities this task acquired or reused: lifecycle state, provenance, inspection findings and requirement tests.',
    props: z.object({ title: title.default('Capabilities') }).strict(),
    inputs: { capabilities: { kind: 'task', path: 'capabilities', required: true } },
    actions: {},
    defaultRegion: 'main',
  },
  {
    type: 'DataTable',
    version: '1.0.0',
    description: 'Paged, sortable view of a tabular dataset.',
    props: z
      .object({
        title: title.default('Data'),
        pageSize: z.number().int().min(10).max(500).default(50),
      })
      .strict(),
    inputs: { rows: { kind: 'artifact', mediaTypes: CSV, required: true } },
    actions: {},
    defaultRegion: 'main',
  },
  {
    type: 'Chart',
    version: '1.0.0',
    description: 'A chart of a tabular dataset (line, bar or point) rendered with Vega-Lite.',
    props: z
      .object({
        title,
        mark: z.enum(['line', 'bar', 'point']),
        x: ChartEncoding,
        y: ChartEncoding,
        color: z.object({ field: z.string().min(1) }).optional(),
        /** One small chart per value of this field, each with its own y scale. */
        row: z.object({ field: z.string().min(1) }).optional(),
        maxRows: z.number().int().min(100).max(50_000).default(5000),
      })
      .strict(),
    inputs: { rows: { kind: 'artifact', mediaTypes: CSV, required: true } },
    actions: {},
    defaultRegion: 'main',
    fieldRefs: (props) => {
      const p = props as {
        x: { field: string };
        y: { field: string };
        color?: { field: string };
        row?: { field: string };
      };
      return [p.x, p.y, p.color, p.row]
        .filter((e): e is { field: string } => e !== undefined)
        .map((e) => ({ input: 'rows', field: e.field }));
    },
  },
];

export class Registry {
  private readonly byType = new Map<string, ComponentDefinition>();

  constructor(definitions: readonly ComponentDefinition[] = COMPONENTS) {
    for (const d of definitions) {
      if (this.byType.has(d.type)) throw new Error(`Duplicate component type ${d.type}`);
      this.byType.set(d.type, d);
    }
  }

  get(type: string): ComponentDefinition | undefined {
    return this.byType.get(type);
  }

  types(): string[] {
    return [...this.byType.keys()];
  }
}

export const registry = new Registry();
