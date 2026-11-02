import { defineProject } from 'vitest/config';

export default defineProject({
  test: { name: 'workspace', environment: 'node' },
});
