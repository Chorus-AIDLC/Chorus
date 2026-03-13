import { describe, it, expect, vi } from 'vitest';

// Mock prisma before importing api-key (which imports prisma at module level)
vi.mock('@/lib/prisma', () => ({ prisma: {} }));
vi.mock('@/generated/prisma/client', () => ({ PrismaClient: vi.fn() }));

import { generateApiKey, hashApiKey, extractApiKey, secureCompare } from '../api-key';

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
