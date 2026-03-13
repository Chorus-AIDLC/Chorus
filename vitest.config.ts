import { defineConfig } from 'vitest/config';
import path from 'path';

export default defineConfig({
  resolve: {
    alias: [
      // Must come before the general '@' alias to avoid @/ matching first
      { find: '@/generated/prisma/client', replacement: path.resolve(__dirname, './src/__mocks__/prisma-client.ts') },
      { find: '@', replacement: path.resolve(__dirname, './src') },
    ],
  },
  test: {
    globals: true,
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.ts'],
    exclude: ['node_modules', '.next', 'packages'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov'],
      include: ['src/services/**/*.ts', 'src/lib/**/*.ts'],
      exclude: [
        'src/**/__tests__/**',
        'src/**/__mocks__/**',
        'src/**/__test-utils__/**',
        'src/lib/prisma.ts',
        'src/lib/redis.ts',
      ],
      // Thresholds disabled — coverage report is for reference only.
      // Re-enable when coverage reaches 80% across all included files.
    },
  },
});
