import { defineProject } from 'vitest/config';

export default defineProject({
  test: { name: 'schemas', environment: 'node' },
});
