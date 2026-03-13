import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock prisma before importing api-key (which imports prisma at module level)
vi.mock('@/lib/prisma', () => ({
  prisma: {
    apiKey: {
      findUnique: vi.fn(),
      update: vi.fn(),
    },
  },
}));
vi.mock('@/generated/prisma/client', () => ({ PrismaClient: vi.fn() }));

import { generateApiKey, hashApiKey, extractApiKey, secureCompare, validateApiKey } from '../api-key';
import { prisma } from '@/lib/prisma';

describe('generateApiKey', () => {
  it('returns an object with key, hash, and prefix', () => {
    const result = generateApiKey();
    expect(result).toHaveProperty('key');
    expect(result).toHaveProperty('hash');
    expect(result).toHaveProperty('prefix');
  });

  it('key starts with cho_ prefix', () => {
    const { key } = generateApiKey();
    expect(key).toMatch(/^cho_/);
  });

  it('hash is a 64-character hex string (SHA-256)', () => {
    const { hash } = generateApiKey();
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('prefix has cho_ prefix with truncated key', () => {
    const { prefix } = generateApiKey();
    expect(prefix).toMatch(/^cho_[A-Za-z0-9_-]{4}\.{3}[A-Za-z0-9_-]{4}$/);
  });

  it('generates unique keys each time', () => {
    const a = generateApiKey();
    const b = generateApiKey();
    expect(a.key).not.toBe(b.key);
    expect(a.hash).not.toBe(b.hash);
  });
});

describe('hashApiKey', () => {
  it('returns a 64-character hex string', () => {
    const hash = hashApiKey('cho_testkey');
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('is deterministic (same input produces same hash)', () => {
    const input = 'cho_deterministic_test';
    expect(hashApiKey(input)).toBe(hashApiKey(input));
  });

  it('different inputs produce different hashes', () => {
    expect(hashApiKey('cho_aaa')).not.toBe(hashApiKey('cho_bbb'));
  });
});

describe('extractApiKey', () => {
  it('returns null for null header', () => {
    expect(extractApiKey(null)).toBeNull();
  });

  it('extracts key from Bearer header', () => {
    expect(extractApiKey('Bearer cho_mykey123')).toBe('cho_mykey123');
  });

  it('returns key directly when it starts with cho_ prefix', () => {
    expect(extractApiKey('cho_directkey')).toBe('cho_directkey');
  });

  it('returns null for unrecognized header format', () => {
    expect(extractApiKey('Basic dXNlcjpwYXNz')).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(extractApiKey('')).toBeNull();
  });

  it('returns Bearer token even if it is not a cho_ key', () => {
    // The function strips "Bearer " but does not validate the token format
    expect(extractApiKey('Bearer some_other_token')).toBe('some_other_token');
  });
});

describe('secureCompare', () => {
  it('returns true for equal strings', () => {
    expect(secureCompare('hello', 'hello')).toBe(true);
  });

  it('returns false for different strings of same length', () => {
    expect(secureCompare('hello', 'world')).toBe(false);
  });

  it('returns false for strings of different length', () => {
    expect(secureCompare('short', 'much longer string')).toBe(false);
  });

  it('returns true for empty strings', () => {
    expect(secureCompare('', '')).toBe(true);
  });

  it('returns false for one empty and one non-empty string', () => {
    expect(secureCompare('', 'nonempty')).toBe(false);
  });
});

describe('validateApiKey', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns invalid for key without cho_ prefix', async () => {
    const result = await validateApiKey('invalid_prefix_key');

    expect(result).toEqual({
      valid: false,
      error: 'Invalid API key format',
    });
    expect(prisma.apiKey.findUnique).not.toHaveBeenCalled();
  });

  it('returns invalid when key is not found in database', async () => {
    vi.mocked(prisma.apiKey.findUnique).mockResolvedValue(null);

    const result = await validateApiKey('cho_notfoundkey');

    expect(result).toEqual({
      valid: false,
      error: 'API key not found',
    });
    expect(prisma.apiKey.findUnique).toHaveBeenCalled();
  });

  it('returns invalid when key has been revoked', async () => {
    const revokedKey = {
      uuid: 'key-uuid',
      keyHash: 'hash',
      revokedAt: new Date('2026-01-15'),
      expiresAt: null,
      agent: {
        uuid: 'agent-uuid',
        companyUuid: 'company-uuid',
        name: 'Test Agent',
        roles: ['developer'],
        ownerUuid: null,
      },
    };

    vi.mocked(prisma.apiKey.findUnique).mockResolvedValue(revokedKey as any);

    const result = await validateApiKey('cho_testkey');

    expect(result).toEqual({
      valid: false,
      error: 'API key has been revoked',
    });
  });

  it('returns invalid when key has expired', async () => {
    const expiredKey = {
      uuid: 'key-uuid',
      keyHash: 'hash',
      revokedAt: null,
      expiresAt: new Date('2026-01-01'), // Past date
      agent: {
        uuid: 'agent-uuid',
        companyUuid: 'company-uuid',
        name: 'Test Agent',
        roles: ['developer'],
        ownerUuid: null,
      },
    };

    vi.mocked(prisma.apiKey.findUnique).mockResolvedValue(expiredKey as any);

    const result = await validateApiKey('cho_testkey');

    expect(result).toEqual({
      valid: false,
      error: 'API key has expired',
    });
  });

  it('returns valid result for a valid key', async () => {
    const validKey = {
      uuid: 'key-uuid',
      keyHash: 'hash',
      revokedAt: null,
      expiresAt: new Date('2027-01-01'), // Future date
      agent: {
        uuid: 'agent-uuid',
        companyUuid: 'company-uuid',
        name: 'Test Agent',
        roles: ['developer', 'pm'],
        ownerUuid: 'owner-uuid',
      },
    };

    vi.mocked(prisma.apiKey.findUnique).mockResolvedValue(validKey as any);
    vi.mocked(prisma.apiKey.update).mockResolvedValue(validKey as any);

    const result = await validateApiKey('cho_testkey');

    expect(result).toEqual({
      valid: true,
      agent: {
        uuid: 'agent-uuid',
        companyUuid: 'company-uuid',
        name: 'Test Agent',
        roles: ['developer', 'pm'],
        ownerUuid: 'owner-uuid',
      },
      apiKey: {
        uuid: 'key-uuid',
      },
    });
  });

  it('returns valid result for key without expiration', async () => {
    const validKey = {
      uuid: 'key-uuid',
      keyHash: 'hash',
      revokedAt: null,
      expiresAt: null, // Never expires
      agent: {
        uuid: 'agent-uuid',
        companyUuid: 'company-uuid',
        name: 'Test Agent',
        roles: ['developer'],
        ownerUuid: null,
      },
    };

    vi.mocked(prisma.apiKey.findUnique).mockResolvedValue(validKey as any);
    vi.mocked(prisma.apiKey.update).mockResolvedValue(validKey as any);

    const result = await validateApiKey('cho_testkey');

    expect(result.valid).toBe(true);
    expect(result.agent?.ownerUuid).toBeNull();
  });

  it('updates lastUsed timestamp on valid key', async () => {
    const validKey = {
      uuid: 'key-uuid',
      keyHash: 'hash',
      revokedAt: null,
      expiresAt: null,
      agent: {
        uuid: 'agent-uuid',
        companyUuid: 'company-uuid',
        name: 'Test Agent',
        roles: ['developer'],
        ownerUuid: null,
      },
    };

    vi.mocked(prisma.apiKey.findUnique).mockResolvedValue(validKey as any);
    vi.mocked(prisma.apiKey.update).mockResolvedValue(validKey as any);

    await validateApiKey('cho_testkey');

    expect(prisma.apiKey.update).toHaveBeenCalledWith({
      where: { uuid: 'key-uuid' },
      data: { lastUsed: expect.any(Date) },
    });
  });

  it('handles database errors gracefully', async () => {
    vi.mocked(prisma.apiKey.findUnique).mockRejectedValue(new Error('Database connection failed'));

    const result = await validateApiKey('cho_testkey');

    expect(result).toEqual({
      valid: false,
      error: 'Internal validation error',
    });
  });

  it('does not fail validation if lastUsed update fails', async () => {
    const validKey = {
      uuid: 'key-uuid',
      keyHash: 'hash',
      revokedAt: null,
      expiresAt: null,
      agent: {
        uuid: 'agent-uuid',
        companyUuid: 'company-uuid',
        name: 'Test Agent',
        roles: ['developer'],
        ownerUuid: null,
      },
    };

    vi.mocked(prisma.apiKey.findUnique).mockResolvedValue(validKey as any);
    vi.mocked(prisma.apiKey.update).mockRejectedValue(new Error('Update failed'));

    const result = await validateApiKey('cho_testkey');

    // Should still return valid even if update fails
    expect(result.valid).toBe(true);
  });

  it('correctly hashes the key before database lookup', async () => {
    const testKey = 'cho_testkey123';
    const expectedHash = hashApiKey(testKey);

    vi.mocked(prisma.apiKey.findUnique).mockResolvedValue(null);

    await validateApiKey(testKey);

    expect(prisma.apiKey.findUnique).toHaveBeenCalledWith({
      where: { keyHash: expectedHash },
      include: { agent: true },
    });
  });
});
