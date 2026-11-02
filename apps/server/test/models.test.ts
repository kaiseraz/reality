import { describe, expect, it } from 'vitest';
import type Anthropic from '@anthropic-ai/sdk';
import { TaskSpec } from '@reality/schemas';
import { loadConfig, modelConfig, resolvePlannerKind } from '../src/config.ts';
import { createClient, ModelCallError, StructuredModel } from '../src/llm/structured.ts';
import { ModelAnalyst } from '../src/analysis/model-analyst.ts';
import { ModelPlanner } from '../src/planner/model-planner.ts';
import { ModelProjectPlanner } from '../src/projects/project-planner.ts';

/** A stand-in for the Anthropic SDK client that records requests and replays one response. */
function fakeClient(response: Record<string, unknown>) {
  const calls: { api: string; params: Record<string, unknown> }[] = [];
  const reply = (api: string) => async (params: Record<string, unknown>) => {
    calls.push({ api, params });
    return { model: params.model, usage: { input_tokens: 10, output_tokens: 20 }, ...response };
  };
  const client = {
    messages: { create: reply('messages.create') },
    beta: { messages: { parse: reply('beta.messages.parse') } },
  } as unknown as Anthropic;
  return { client, calls };
}

const META = { provider: 'meta' as const, model: 'muse-spark-1.3', apiKey: 'meta-test-key' };
const CLAUDE = {
  provider: 'anthropic' as const,
  model: 'claude-opus-5-5',
  apiKey: 'claude-test-key',
};

describe('choosing the model', () => {
  const env = { AUTH: 'off' };
  it('prefers Meta when a Meta key is set (the Meta hackathon requires Meta models)', () => {
    const both = loadConfig({ ...env, META_MODEL_API_KEY: 'm', ANTHROPIC_API_KEY: 'a' });
    expect(resolvePlannerKind(both)).toBe('meta');
    expect(modelConfig(both)).toMatchObject({ provider: 'meta', model: 'muse-spark-1.3' });
  });

  it('falls back to Claude, then to the rule-based planner', () => {
    expect(modelConfig(loadConfig({ ...env, ANTHROPIC_API_KEY: 'a' }))).toMatchObject({
      provider: 'anthropic',
      model: 'claude-opus-5-5',
    });
    const none = loadConfig(env);
    expect(resolvePlannerKind(none)).toBe('rules');
    expect(modelConfig(none)).toBeUndefined();
  });

  it('can be forced and renamed', () => {
    const c = loadConfig({
      ...env,
      PLANNER: 'anthropic',
      META_MODEL_API_KEY: 'm',
      ANTHROPIC_API_KEY: 'a',
      META_MODEL: 'muse-spark-2',
    });
    expect(modelConfig(c)?.provider).toBe('anthropic');
    const m = loadConfig({ ...env, META_MODEL_API_KEY: 'm', META_MODEL: 'muse-spark-2' });
    expect(modelConfig(m)?.model).toBe('muse-spark-2');
  });
});

describe('Meta Model API client', () => {
  it('talks to api.meta.ai with the Meta key as bearer token and never the Anthropic key', () => {
    const before = process.env.ANTHROPIC_API_KEY;
    process.env.ANTHROPIC_API_KEY = 'must-not-leak';
    try {
      const c = createClient(META);
      expect(c.baseURL).toBe('https://api.meta.ai');
      expect(c.authToken).toBe('meta-test-key');
      expect(c.apiKey).toBeNull();
    } finally {
      if (before === undefined) delete process.env.ANTHROPIC_API_KEY;
      else process.env.ANTHROPIC_API_KEY = before;
    }
  });

  it('asks for structured output through one forced tool call, without Claude-only options', async () => {
    const { client, calls } = fakeClient({
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 't', name: 'submit_program', input: { code: 'print(1)' } }],
    });
    const analyst = new ModelAnalyst(new StructuredModel(META, client));
    const code = await analyst.writeCode({
      goal: 'g',
      step: {
        id: 's',
        description: 'count rows',
        agent: 'analysis-agent',
        dependsOn: [],
        status: 'pending',
      },
      dataset: {
        filename: 'd.csv',
        rowCount: 3,
        columns: [{ name: 'a', type: 'number', distinct: 3 }],
      },
    } as never);
    expect(code).toBe('print(1)');
    const p = calls[0]?.params ?? {};
    expect(calls[0]?.api).toBe('messages.create');
    expect(p.tool_choice).toEqual({ type: 'tool', name: 'submit_program' });
    const tool = (p.tools as { input_schema: { type: string; $schema?: string } }[])[0];
    expect(tool?.input_schema.type).toBe('object');
    expect(tool?.input_schema.$schema).toBeUndefined();
    for (const claudeOnly of ['thinking', 'betas', 'output_config', 'fallbacks']) {
      expect(p[claudeOnly]).toBeUndefined();
    }
  });

  it('accepts a JSON answer in text when the endpoint ignores the forced tool', async () => {
    const { client } = fakeClient({
      stop_reason: 'end_turn',
      content: [{ type: 'text', text: 'Here you go: {"code": "print(2)"}' }],
    });
    const r = await new StructuredModel(META, client).call({
      system: 's',
      user: 'u',
      schema: (await import('zod')).z.object({ code: (await import('zod')).z.string() }),
      toolName: 'submit_program',
      toolDescription: 'd',
    });
    expect(r.value).toEqual({ code: 'print(2)' });
  });

  it('retries with "any" when the endpoint rejects a named tool_choice (the live Meta API)', async () => {
    const z = (await import('zod')).z;
    const seen: string[] = [];
    const client = {
      messages: {
        create: async (params: Record<string, unknown>) => {
          const choice = params.tool_choice as { type: string };
          seen.push(choice.type);
          if (choice.type === 'tool') {
            throw Object.assign(new Error('named `tool_choice` is not supported'), {
              status: 400,
            });
          }
          return {
            model: 'muse-spark-1.3',
            stop_reason: 'tool_use',
            usage: { input_tokens: 10, output_tokens: 20 },
            content: [
              { type: 'tool_use', id: 't', name: 'submit_program', input: { code: 'print(3)' } },
            ],
          };
        },
      },
      beta: {
        messages: {
          parse: async () => {
            throw new Error('not used for Meta');
          },
        },
      },
    } as unknown as Anthropic;
    const r = await new StructuredModel(META, client).call({
      system: 's',
      user: 'u',
      schema: z.object({ code: z.string() }),
      toolName: 'submit_program',
      toolDescription: 'd',
    });
    expect(r.value).toEqual({ code: 'print(3)' });
    expect(seen).toEqual(['tool', 'any']);
  });

  it('reports refusals and truncation honestly', async () => {
    const z = (await import('zod')).z;
    const ask = (stop: string) =>
      new StructuredModel(META, fakeClient({ stop_reason: stop, content: [] }).client).call({
        system: 's',
        user: 'u',
        schema: z.object({}),
        toolName: 't',
        toolDescription: 'd',
      });
    await expect(ask('refusal')).rejects.toMatchObject({ retryable: false });
    await expect(ask('max_tokens')).rejects.toMatchObject({ retryable: true });
    await expect(ask('max_tokens')).rejects.toBeInstanceOf(ModelCallError);
  });
});

describe('planning with Muse Spark', () => {
  it('produces a task specification the platform validates like any other', async () => {
    const draft = {
      goal: 'Which regions drive revenue?',
      constraints: [],
      requiredOutputs: ['totals per region'],
      risks: [],
      acceptanceCriteria: [
        {
          id: 'groups',
          description: 'Totals add up',
          checkType: 'recompute',
          check: 'breakdown_sums',
          checkParams: '{"step":"breakdown","group":"region","value":"revenue"}',
        },
      ],
      workflow: [
        {
          id: 'breakdown',
          description: 'Total revenue per region',
          agent: 'analysis-agent',
          dependsOn: [],
          recipe: 'breakdown',
          recipeParams: '{"group":"region","value":"revenue"}',
          capability: '',
          tool: '',
          toolArgs: '',
        },
      ],
      missingCapabilities: [],
      candidateWorkspaces: ['data-analysis'],
    };
    const { client, calls } = fakeClient({
      stop_reason: 'tool_use',
      content: [{ type: 'tool_use', id: 't', name: 'submit_task_specification', input: draft }],
    });
    const planner = new ModelPlanner(new StructuredModel(META, client));
    expect(planner.name).toBe('muse-spark-1.3');
    const out = await planner.propose({ request: 'Which regions drive revenue?', datasets: [] });
    const spec = TaskSpec.parse(out.draft);
    expect(spec.workflow[0]?.recipe).toEqual({
      name: 'breakdown',
      params: { group: 'region', value: 'revenue' },
    });
    expect(out.usage).toEqual({ inputTokens: 10, outputTokens: 20 });
    expect(calls[0]?.api).toBe('messages.create');
  });

  it('keeps the native structured-output path for Claude', async () => {
    const { client, calls } = fakeClient({
      stop_reason: 'end_turn',
      parsed_output: { tasks: [{ title: 'A', request: 'Q?', dependsOn: [], useResultOf: null }] },
      content: [],
    });
    const tasks = await new ModelProjectPlanner(new StructuredModel(CLAUDE, client)).propose('Q?', {
      files: [],
      maxTasks: 5,
    });
    expect(tasks).toEqual([{ title: 'A', request: 'Q?', dependsOn: [] }]);
    expect(calls[0]?.api).toBe('beta.messages.parse');
    expect(calls[0]?.params.betas).toEqual(['server-side-fallback-2026-07-01']);
  });
});
