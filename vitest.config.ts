import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['{engine,world,brain,server,app}/**/*.test.ts'],
    /**
     * These tests run real simulations — twenty thousand dots, flow fields over
     * 640,000 cells — and the machine may also be holding a 4B model in memory
     * for the live tests. Vitest's 5 s default made them flaky for reasons that
     * had nothing to do with the code under test.
     */
    testTimeout: 60_000,
    hookTimeout: 60_000,
  },
});
