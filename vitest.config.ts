import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['./src/utils/__tests__/setup.ts'],
  },
});
