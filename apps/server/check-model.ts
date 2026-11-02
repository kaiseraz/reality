import { loadConfig, modelConfig, resolvePlannerKind } from './src/config.ts';
import { runPreflight } from './src/llm/preflight.ts';

/**
 * npm run check:model: does the configured model (Meta Muse Spark, or Claude) work with
 * Reality? Reads .env; never prints the key. Exit code 0 when every step passes.
 */
const config = loadConfig(process.env);
const model = modelConfig(config);

if (!model) {
  console.log(
    [
      '',
      '  No model configured. Reality runs on its built-in rules.',
      '  Put your key into .env, for example:',
      '',
      '    META_MODEL_API_KEY=...        (Meta Muse Spark)',
      '    META_MODEL=muse-spark-1.3     (optional, the model name)',
      '',
      '  Then run this check again.',
      '',
    ].join('\n'),
  );
  process.exit(2);
}

console.log(
  `\n  Checking ${model.provider === 'meta' ? 'Meta' : 'Claude'} model "${model.model}"` +
    `${model.baseURL ? ` at ${model.baseURL}` : ''} (planner: ${resolvePlannerKind(config)}) …\n`,
);
const steps = await runPreflight(model);
for (const s of steps) {
  console.log(`  ${s.ok ? 'OK  ' : 'FAIL'}  ${s.name}  (${s.ms} ms)`);
  console.log(`        ${s.detail}`);
  if (s.hint) console.log(`        → ${s.hint}`);
}
const failed = steps.filter((s) => !s.ok).length;
console.log(
  failed
    ? `\n  ${failed} step(s) failed. Fix the first one and run the check again.\n`
    : '\n  All good: Reality can use this model. Start Reality and talk to the lead.\n',
);
process.exit(failed ? 1 : 0);
