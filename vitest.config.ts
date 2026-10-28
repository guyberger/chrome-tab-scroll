import { defineConfig } from 'vitest/config';

// Deliberately does not load vite.config.ts: the CRXJS plugin wants to build a
// real extension, which has nothing to do with running unit tests.
export default defineConfig({
  test: {
    environment: 'happy-dom',
    include: ['tests/**/*.test.ts'],
    setupFiles: ['tests/setup.ts'],
    restoreMocks: true,
  },
});
