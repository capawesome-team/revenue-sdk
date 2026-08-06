import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/live/**/*.live.test.ts'],
    testTimeout: 30000,
  },
});
