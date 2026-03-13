import { vi } from 'vitest';

export const eventBus = {
  emit: vi.fn(),
  emitChange: vi.fn(),
  connect: vi.fn(),
  disconnect: vi.fn(),
  on: vi.fn(),
  off: vi.fn(),
};
