import { defineConfig } from 'vitest/config';

// One test run across all workspaces; each workspace owns its own config.
export default defineConfig({
  test: {
    projects: ['packages/*', 'apps/*'],
  },
});
