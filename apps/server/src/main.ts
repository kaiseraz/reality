import { access, constants, mkdir } from 'node:fs/promises';
import { buildApp } from './app.ts';
import { loadConfig } from './config.ts';
import { createRuntime } from './runtime.ts';

const config = loadConfig();

// Fail at startup, with the path, instead of on the first upload with "internal".
for (const dir of [config.ARTIFACT_DIR, config.CAPABILITY_DIR, config.RUN_DIR]) {
  if (!dir) continue;
  try {
    await mkdir(dir, { recursive: true });
    await access(dir, constants.W_OK);
  } catch (err) {
    console.error(`Data directory ${dir} is not writable: ${(err as Error).message}`);
    process.exit(1);
  }
}
const runtime = await createRuntime(config);
const app = buildApp(config, runtime, { logger: true });

app.log.info({ planner: runtime.planner.name }, 'planner configured');
if (runtime.planner.name === 'fake-planner') {
  app.log.warn('Using the offline FAKE planner. Set ANTHROPIC_API_KEY in .env for real planning.');
}

try {
  await app.listen({ port: config.SERVER_PORT, host: config.SERVER_HOST });
  const resumed = await runtime.tasks.recover();
  if (resumed.length > 0) app.log.info({ resumed }, 'resumed interrupted tasks');
  // Projects keep moving in the background, also while nobody has the app open.
  runtime.projects.start();
  runtime.routines.start();
  runtime.chats.engine.start();
} catch (err) {
  app.log.error(err);
  process.exit(1);
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void app.close().then(() => runtime.close());
  });
}
