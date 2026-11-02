import { z } from 'zod';
import { SdkAgentModel, type AgentMessage, type ToolSpec } from '../chat/model.ts';
import { TOOLS } from '../chat/tools.ts';
import { LEAD_TOOLS, SKILL_TOOLS, SUBMIT_TOOL } from '../team/tools.ts';
import { StructuredModel, type ModelConfig } from './structured.ts';

/**
 * A quick check that the configured model works with Reality, before anything depends on
 * it: does it answer, call tools and use their results, give structured output for the
 * planner, and accept every tool Reality hands its bots. Each step says what to do when it
 * fails. The key is never printed.
 */

export interface PreflightStep {
  name: string;
  ok: boolean;
  ms: number;
  detail: string;
  /** What to do about a failure. */
  hint?: string;
}

/** Turns an error into a plain next step. */
export function hintFor(message: string, config: ModelConfig): string {
  const m = message.toLowerCase();
  if (/401|403|auth|unauthori[sz]ed|invalid.*key|forbidden/.test(m)) {
    return 'The key was refused: check META_MODEL_API_KEY in .env (no quotes, no spaces) and that it is active.';
  }
  if (/404|not.?found|model/.test(m) && /model|404/.test(m)) {
    return `The model name may be wrong: META_MODEL is "${config.model}". Use the exact name from Meta's docs.`;
  }
  if (/429|rate|quota|overloaded/.test(m)) {
    return 'Rate limit or quota: wait a minute and run the check again, or check the plan limits.';
  }
  if (/unreachable|connect|enotfound|econnrefused|timeout|fetch failed/.test(m)) {
    return `Cannot reach ${config.baseURL ?? 'the API'}: check the internet connection and META_BASE_URL.`;
  }
  if (/400|invalid|schema|tool/.test(m)) {
    return 'The request was rejected; the detail above names the field. Send it to your developer to adapt Reality.';
  }
  return 'Unexpected error; the detail above says more.';
}

async function timed(
  name: string,
  config: ModelConfig,
  run: () => Promise<string>,
): Promise<PreflightStep> {
  const started = Date.now();
  try {
    const detail = await run();
    return { name, ok: true, ms: Date.now() - started, detail };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      name,
      ok: false,
      ms: Date.now() - started,
      detail: message.slice(0, 400),
      hint: hintFor(message, config),
    };
  }
}

const ADD: ToolSpec = {
  name: 'add_numbers',
  description: 'Adds two integers and returns the sum.',
  input_schema: {
    type: 'object',
    properties: { a: { type: 'integer' }, b: { type: 'integer' } },
    required: ['a', 'b'],
    additionalProperties: false,
  },
};

const Extract = z.object({ city: z.string(), population: z.number() });

export async function runPreflight(config: ModelConfig): Promise<PreflightStep[]> {
  const agent = new SdkAgentModel(config);
  const steps: PreflightStep[] = [];

  steps.push(
    await timed('Answers', config, async () => {
      const res = await agent.turn({
        system: 'You are a connection test. Reply in one word.',
        messages: [{ role: 'user', content: 'Reply with the single word OK.' }],
        tools: [],
      });
      const text = res.content
        .filter((b) => b.type === 'text')
        .map((b) => (b.type === 'text' ? b.text : ''))
        .join('')
        .trim();
      if (!text) throw new Error('The model answered with no text.');
      return `"${text.slice(0, 60)}" from ${res.model}`;
    }),
  );
  // Without an answer, the rest cannot pass; stop with the one clear reason.
  if (!steps[0]?.ok) return steps;

  steps.push(
    await timed('Calls a tool and uses its result', config, async () => {
      const messages: AgentMessage[] = [
        {
          role: 'user',
          content: 'Use the add_numbers tool to add 17 and 25. Then tell me the sum.',
        },
      ];
      const first = await agent.turn({
        system: 'You use tools when asked.',
        messages,
        tools: [ADD],
      });
      const call = first.content.find((b) => b.type === 'tool_use');
      if (!call || call.type !== 'tool_use') throw new Error('The model did not call the tool.');
      if (call.name !== 'add_numbers') throw new Error(`It called an unknown tool "${call.name}".`);
      const a = Number(call.input.a);
      const b = Number(call.input.b);
      if (a + b !== 42) throw new Error(`Wrong arguments: ${JSON.stringify(call.input)}.`);
      messages.push({ role: 'assistant', content: first.content });
      messages.push({
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: call.id, content: '42' }],
      });
      const second = await agent.turn({
        system: 'You use tools when asked.',
        messages,
        tools: [ADD],
      });
      const text = second.content.map((b) => (b.type === 'text' ? b.text : '')).join('');
      if (!/42/.test(text)) throw new Error(`It did not use the result: "${text.slice(0, 120)}".`);
      return 'add_numbers(17, 25), then reported 42';
    }),
  );

  steps.push(
    await timed('Structured output (planner)', config, async () => {
      const model = new StructuredModel(config);
      const out = await model.call({
        system: 'Extract the facts.',
        user: 'Paris has about 2,100,000 inhabitants. Give the city and its population as a number.',
        schema: Extract,
        toolName: 'extract',
        toolDescription: 'The city and its population.',
        maxTokens: 400,
      });
      const parsed = Extract.safeParse(out.value);
      if (!parsed.success) throw new Error(`Not the requested shape: ${JSON.stringify(out.value)}`);
      return `${parsed.data.city}, ${parsed.data.population.toLocaleString('en-US')}`;
    }),
  );

  const all = [...TOOLS, ...LEAD_TOOLS, SUBMIT_TOOL, ...SKILL_TOOLS];
  steps.push(
    await timed(`Accepts all ${all.length} Reality tools`, config, async () => {
      const res = await agent.turn({
        system: 'You are Reality, a lead bot. Answer briefly.',
        messages: [
          { role: 'user', content: 'Say hello in one short sentence. Do not use any tool.' },
        ],
        tools: all,
      });
      const text = res.content
        .map((b) => (b.type === 'text' ? b.text : ''))
        .join('')
        .trim();
      const used = res.content.filter((b) => b.type === 'tool_use').length;
      return used
        ? `accepted; it called ${used} tool(s) anyway`
        : `accepted: "${text.slice(0, 60)}"`;
    }),
  );
  return steps;
}
