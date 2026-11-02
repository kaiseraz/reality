/**
 * Probe of the Meta Model API with real calls (costs a few cents). Run once after adding
 * META_MODEL_API_KEY to .env:
 *   npx tsx --env-file=../../.env eval/meta-probe.ts          (shows what it would do)
 *   npx tsx --env-file=../../.env eval/meta-probe.ts --yes    (runs it)
 * It checks the path Reality relies on: one forced tool call returning a structured result,
 * then a real task plan from the planner, validated like any plan.
 */
import { TaskSpec } from '@reality/schemas';
import { z } from 'zod';
import { loadConfig } from '../src/config.ts';
import { StructuredModel } from '../src/llm/structured.ts';
import { ModelPlanner } from '../src/planner/model-planner.ts';
import { validatePlan } from '../src/planner/semantics.ts';

const config = loadConfig();
if (!config.META_MODEL_API_KEY) {
  console.error('META_MODEL_API_KEY is not set in .env.');
  process.exit(1);
}
const model = new StructuredModel({
  provider: 'meta',
  model: config.META_MODEL,
  apiKey: config.META_MODEL_API_KEY,
  ...(config.META_BASE_URL ? { baseURL: config.META_BASE_URL } : {}),
});
if (!process.argv.includes('--yes')) {
  console.log(
    `Would call ${model.name} at ${config.META_BASE_URL ?? 'https://api.meta.ai'} twice (a few cents). Add --yes to run.`,
  );
  process.exit(0);
}

const check = (ok: boolean, what: string, detail?: unknown) =>
  console.log(
    `${ok ? 'OK  ' : 'FAIL'} ${what}${detail === undefined ? '' : `: ${JSON.stringify(detail).slice(0, 300)}`}`,
  );

try {
  const r = await model.call({
    system: 'You answer with the requested structure only.',
    user: 'What is 17 + 25? Also name the operation.',
    schema: z.object({ result: z.number(), operation: z.string() }),
    toolName: 'submit_answer',
    toolDescription: 'Submit the answer.',
    maxTokens: 500,
  });
  check(
    z.object({ result: z.literal(42), operation: z.string() }).safeParse(r.value).success,
    'structured output through a forced tool call',
    r.value,
  );
} catch (err) {
  check(false, 'structured output through a forced tool call', String(err));
}

const dataset = {
  filename: 'sales.csv',
  rowCount: 60,
  columns: [
    { name: 'week', type: 'date' as const, distinct: 30 },
    { name: 'region', type: 'string' as const, distinct: 2 },
    { name: 'revenue', type: 'number' as const, distinct: 60 },
  ],
};
try {
  const planner = new ModelPlanner(model);
  const out = await planner.propose({
    request: 'Which regions drive revenue?',
    datasets: [dataset],
    availableCapabilities: [],
  });
  const spec = TaskSpec.safeParse(out.draft);
  check(
    spec.success,
    'a task plan in the platform schema',
    spec.success ? undefined : spec.error.issues,
  );
  if (spec.success) {
    const problems = validatePlan(spec.data, {
      datasets: [dataset],
      availableCapabilities: [],
    });
    check(problems.length === 0, 'the plan passes semantic validation', problems);
  }
} catch (err) {
  check(false, 'a task plan in the platform schema', String(err));
}
