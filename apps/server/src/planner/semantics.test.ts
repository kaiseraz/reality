import { describe, expect, it } from 'vitest';
import { TaskSpec } from '@reality/schemas';
import { toSpecInput } from './model-planner.ts';
import type { DatasetInfo } from './planner.ts';
import { RuleBasedPlanner } from './rule-planner.ts';
import { planningContext, validatePlan } from './semantics.ts';

const sales: DatasetInfo = {
  filename: 'sales_weekly.csv',
  rowCount: 312,
  columns: [
    { name: 'week', type: 'date', distinct: 156 },
    { name: 'region', type: 'string', distinct: 2 },
    { name: 'revenue', type: 'number', distinct: 312 },
    { name: 'orders', type: 'number', distinct: 40 },
  ],
};
const ctx = { datasets: [sales], availableCapabilities: [] as string[] };

const base = {
  goal: 'g',
  requiredOutputs: ['x'],
  acceptanceCriteria: [{ id: 'a', description: 'x', checkType: 'human' }],
};
const spec = (workflow: unknown[], acceptanceCriteria: unknown[] = base.acceptanceCriteria) =>
  TaskSpec.parse({ ...base, workflow, acceptanceCriteria });

describe('validatePlan', () => {
  it('accepts the rule-based plan for the sample data', async () => {
    const out = await new RuleBasedPlanner().propose({
      request: 'Is there a seasonal pattern in weekly revenue, and which regions drive it?',
      datasets: [sales],
    });
    expect(validatePlan(TaskSpec.parse(out.draft), ctx)).toEqual([]);
  });

  it('rejects unknown recipes, bad params and unknown columns', () => {
    const errors = validatePlan(
      spec([
        {
          id: 'a',
          description: 'x',
          agent: 'analysis-agent',
          recipe: { name: 'magic', params: {} },
        },
        {
          id: 'b',
          description: 'x',
          agent: 'analysis-agent',
          recipe: { name: 'breakdown', params: { group: 'region' } },
        },
        {
          id: 'c',
          description: 'x',
          agent: 'analysis-agent',
          recipe: { name: 'breakdown', params: { group: 'country', value: 'revenue' } },
        },
      ]),
      ctx,
    ).join('\n');
    expect(errors).toMatch(/unknown recipe "magic"/);
    expect(errors).toMatch(/invalid params for breakdown/);
    expect(errors).toMatch(/column "country"/);
  });

  it('requires an acquiring step (or an enabled capability) before recipes that need one', () => {
    const decompose = { name: 'decompose', params: { date: 'week', value: 'revenue', period: 52 } };
    const without = spec([
      { id: 'd', description: 'x', agent: 'analysis-agent', recipe: decompose },
    ]);
    expect(validatePlan(without, ctx).join()).toMatch(/needs capability "statsmodels"/);

    const withStep = spec([
      {
        id: 'acq',
        description: 'x',
        agent: 'capability-agent',
        capability: 'time-series decomposition',
      },
      { id: 'd', description: 'x', agent: 'analysis-agent', dependsOn: ['acq'], recipe: decompose },
    ]);
    expect(validatePlan(withStep, ctx)).toEqual([]);
    expect(validatePlan(without, { ...ctx, availableCapabilities: ['statsmodels'] })).toEqual([]);
  });

  it('accepts a capability need the catalog does not know (it is searched for), not a vague one', () => {
    const known = spec([
      { id: 'x', description: 'x', agent: 'capability-agent', capability: 'fluid dynamics solver' },
    ]);
    expect(validatePlan(known, ctx)).toEqual([]);
    const vague = spec([
      { id: 'x', description: 'x', agent: 'capability-agent', capability: 'tool' },
    ]);
    expect(validatePlan(vague, ctx).join()).toMatch(/too short to search for/);
  });

  it('rejects checks that refer to unknown steps or checks', () => {
    const s = spec(
      [{ id: 'agg', description: 'x', agent: 'analysis-agent' }],
      [
        {
          id: 'a',
          description: 'x',
          checkType: 'recompute',
          check: { name: 'totals_match', params: { step: 'nope', date: 'week', value: 'revenue' } },
        },
        { id: 'b', description: 'x', checkType: 'recompute', check: { name: 'vibes', params: {} } },
      ],
    );
    const errors = validatePlan(s, ctx).join('\n');
    expect(errors).toMatch(/unknown step "nope"/);
    expect(errors).toMatch(/unknown check "vibes"/);
  });
});

describe('Claude planner plumbing', () => {
  it('describes the schema and the catalog, but never raw rows', () => {
    const text = planningContext(ctx);
    expect(text).toContain('week (date, 156 distinct)');
    expect(text).toContain('- decompose:');
    expect(text).toContain('- totals_match:');
    expect(text).toContain('time-series decomposition');
  });

  it('converts the flat structured-output draft into a valid TaskSpec', () => {
    const input = toSpecInput({
      goal: 'g',
      constraints: [],
      requiredOutputs: ['x'],
      risks: [],
      acceptanceCriteria: [
        {
          id: 't',
          description: 'x',
          checkType: 'recompute',
          check: 'totals_match',
          checkParams: '{"step":"agg","date":"week","value":"revenue"}',
        },
        { id: 'h', description: 'x', checkType: 'human', check: '', checkParams: '' },
      ],
      workflow: [
        {
          id: 'agg',
          description: 'x',
          agent: 'analysis-agent',
          dependsOn: [],
          recipe: 'aggregate_time',
          recipeParams: '{"date":"week","value":"revenue"}',
          capability: '',
          tool: '',
          toolArgs: '',
        },
        {
          id: 'v',
          description: 'x',
          agent: 'verification-agent',
          dependsOn: ['agg'],
          recipe: '',
          recipeParams: '',
          capability: '',
          tool: '',
          toolArgs: '',
        },
      ],
      missingCapabilities: [],
      candidateWorkspaces: ['data-analysis'],
    });
    const parsed = TaskSpec.parse(input);
    expect(parsed.workflow[0]?.recipe).toEqual({
      name: 'aggregate_time',
      params: { date: 'week', value: 'revenue' },
    });
    expect(parsed.acceptanceCriteria[1]?.check).toBeUndefined();
    expect(validatePlan(parsed, ctx)).toEqual([]);
  });

  it('turns malformed parameter JSON into a validation error, not a crash', () => {
    const input = toSpecInput({
      goal: 'g',
      constraints: [],
      requiredOutputs: ['x'],
      risks: [],
      acceptanceCriteria: [
        { id: 'h', description: 'x', checkType: 'human', check: '', checkParams: '' },
      ],
      workflow: [
        {
          id: 'agg',
          description: 'x',
          agent: 'analysis-agent',
          dependsOn: [],
          recipe: 'aggregate_time',
          recipeParams: '{oops',
          capability: '',
          tool: '',
          toolArgs: '',
        },
      ],
      missingCapabilities: [],
      candidateWorkspaces: [],
    });
    expect(TaskSpec.safeParse(input).success).toBe(false);
  });
});

describe('SQL via an MCP tool', () => {
  const SQL = 'SELECT region, SUM(revenue) AS total FROM data GROUP BY region ORDER BY total DESC';

  it('extracts SQL from plain or fenced requests', async () => {
    const { extractSql } = await import('./rule-planner.ts');
    expect(extractSql(`Run this: ${SQL};`)).toBe(SQL);
    expect(extractSql('Please run\n```sql\nSELECT * FROM data\n```\nthanks')).toBe(
      'SELECT * FROM data',
    );
    expect(extractSql('Which regions drive revenue?')).toBeUndefined();
  });

  it('plans acquisition, the tool call and an independent check, and passes validation', async () => {
    const out = await new RuleBasedPlanner().propose({ request: `Run ${SQL}`, datasets: [sales] });
    const spec = TaskSpec.parse(out.draft);
    expect(spec.workflow.map((s) => s.id)).toEqual(['profile', 'acquire', 'query', 'verify']);
    expect(spec.workflow[2]?.tool).toEqual({
      capability: 'mcp-server-motherduck',
      name: 'execute_query',
      args: { sql: SQL },
    });
    expect(spec.acceptanceCriteria.map((a) => a.check?.name)).toEqual([
      'row_count',
      'sql_result_matches',
    ]);
    expect(validatePlan(spec, ctx)).toEqual([]);
  });

  it('skips acquisition when the capability is already enabled', async () => {
    const out = await new RuleBasedPlanner().propose({
      request: `Run ${SQL}`,
      datasets: [sales],
      availableCapabilities: ['mcp-server-motherduck'],
    });
    expect(TaskSpec.parse(out.draft).workflow.map((s) => s.id)).toEqual([
      'profile',
      'query',
      'verify',
    ]);
  });

  it('rejects write statements, unapproved tools and tools without the capability', () => {
    const tool = (name: string, sql: string) => ({
      capability: 'mcp-server-motherduck',
      name,
      args: { sql },
    });
    const errors = validatePlan(
      spec([
        {
          id: 'a',
          description: 'x',
          agent: 'analysis-agent',
          tool: tool('execute_query', 'DROP TABLE data'),
        },
        {
          id: 'b',
          description: 'x',
          agent: 'analysis-agent',
          tool: tool('switch_database_connection', SQL),
        },
        {
          id: 'c',
          description: 'x',
          agent: 'analysis-agent',
          tool: { capability: 'evil-server', name: 'x', args: {} },
        },
      ]),
      ctx,
    ).join('\n');
    expect(errors).toMatch(/Only SELECT/);
    expect(errors).toMatch(/not approved/);
    expect(errors).toMatch(/not a reviewed MCP capability/);
    expect(errors).toMatch(/needs capability "mcp-server-motherduck"/);
  });

  it('read-only guard: one SELECT/WITH statement, no side effects', async () => {
    const { checkReadOnlySql } = await import('../capabilities/mcp.ts');
    expect(checkReadOnlySql('SELECT 1 FROM data')).toBeNull();
    expect(checkReadOnlySql('WITH t AS (SELECT * FROM data) SELECT * FROM t;')).toBeNull();
    expect(checkReadOnlySql("SELECT 'drop table' AS label FROM data")).toBeNull(); // keyword in a string
    expect(checkReadOnlySql('SELECT 1; DROP TABLE data')).toMatch(/single statement/);
    expect(checkReadOnlySql("COPY data TO '/tmp/x.csv'")).toMatch(/Only SELECT/);
    expect(checkReadOnlySql('SELECT * FROM data -- harmless\n')).toBeNull();
    expect(checkReadOnlySql('WITH x AS (SELECT 1) INSERT INTO data SELECT * FROM x')).toMatch(
      /not allowed/,
    );
  });

  it('converts a Claude tool step into a TaskSpec tool', () => {
    const input = toSpecInput({
      goal: 'g',
      constraints: [],
      requiredOutputs: ['x'],
      risks: [],
      acceptanceCriteria: [
        { id: 'h', description: 'x', checkType: 'human', check: '', checkParams: '' },
      ],
      workflow: [
        {
          id: 'q',
          description: 'x',
          agent: 'analysis-agent',
          dependsOn: [],
          recipe: '',
          recipeParams: '',
          capability: '',
          tool: 'mcp-server-motherduck/execute_query',
          toolArgs: JSON.stringify({ sql: SQL }),
        },
      ],
      missingCapabilities: [],
      candidateWorkspaces: [],
    });
    expect(TaskSpec.parse(input).workflow[0]?.tool).toEqual({
      capability: 'mcp-server-motherduck',
      name: 'execute_query',
      args: { sql: SQL },
    });
  });
});
