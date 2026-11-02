import { defineProject } from 'vitest/config';

export default defineProject({
  test: {
    name: 'server',
    environment: 'node',
    include: ['src/**/*.test.ts', 'test/**/*.test.ts'],
    // Integration tests share one Postgres test database; run files sequentially.
    fileParallelism: false,
    // Generous timeout: the first Fastify import on a cold Windows/OneDrive file cache took >5s.
    testTimeout: 30_000,
    hookTimeout: 60_000,
    globalSetup: ['./test/watchdog.ts'],
  },
});
