import { describe, it, expect } from 'vitest';

describe('Vitest setup smoke test', () => {
  it('should resolve @/ path alias', async () => {
    const { cn } = await import('@/lib/utils');
    expect(typeof cn).toBe('function');
  });

  it('should run basic assertions', () => {
    expect(1 + 1).toBe(2);
    expect('cho_').toMatch(/^cho_/);
  });
});
