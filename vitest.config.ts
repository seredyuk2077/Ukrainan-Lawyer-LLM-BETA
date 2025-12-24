import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    include: [
      'scripts/supreme-court/**/*.test.ts',
      'supabase/functions/**/*.test.ts'
    ],
    environment: 'node',
    coverage: {
      enabled: false
    }
  }
});


