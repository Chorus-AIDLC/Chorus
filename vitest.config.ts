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
    reporters: process.env.GITHUB_ACTIONS === 'true' ? ['default', 'github-actions'] : ['default'],
    globals: true,
    environment: 'node',
    include: ['src/**/__tests__/**/*.test.ts'],
    exclude: ['node_modules', '.next', 'packages'],
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'lcov', 'json', 'json-summary'],
      include: ['src/services/**/*.ts', 'src/lib/**/*.ts'],
      exclude: [
        'src/**/__tests__/**',
        'src/**/__mocks__/**',
        'src/**/__test-utils__/**',
        'src/lib/prisma.ts',
        'src/lib/redis.ts',
      ],
      thresholds: {
        lines: 95,
        statements: 95,
        branches: 85,
        functions: 93,
      },
    },
  },
});
