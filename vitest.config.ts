import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['{engine,world,brain,server,app}/**/*.test.ts'],
  },
});
