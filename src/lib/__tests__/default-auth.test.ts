import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { isDefaultAuthEnabled, getDefaultUserEmail, verifyDefaultPassword } from '../default-auth';

describe('default-auth', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('isDefaultAuthEnabled', () => {
    it('returns true when both DEFAULT_USER and DEFAULT_PASSWORD are set', () => {
      process.env.DEFAULT_USER = 'test@example.com';
      process.env.DEFAULT_PASSWORD = 'password123';

      expect(isDefaultAuthEnabled()).toBe(true);
    });

    it('returns false when DEFAULT_USER is missing', () => {
      delete process.env.DEFAULT_USER;
      process.env.DEFAULT_PASSWORD = 'password123';

      expect(isDefaultAuthEnabled()).toBe(false);
    });

    it('returns false when DEFAULT_PASSWORD is missing', () => {
      process.env.DEFAULT_USER = 'test@example.com';
      delete process.env.DEFAULT_PASSWORD;

      expect(isDefaultAuthEnabled()).toBe(false);
    });

    it('returns false when both are missing', () => {
      delete process.env.DEFAULT_USER;
      delete process.env.DEFAULT_PASSWORD;

      expect(isDefaultAuthEnabled()).toBe(false);
    });

    it('returns false when DEFAULT_USER is empty string', () => {
      process.env.DEFAULT_USER = '';
      process.env.DEFAULT_PASSWORD = 'password123';

      expect(isDefaultAuthEnabled()).toBe(false);
    });

    it('returns false when DEFAULT_PASSWORD is empty string', () => {
      process.env.DEFAULT_USER = 'test@example.com';
      process.env.DEFAULT_PASSWORD = '';

      expect(isDefaultAuthEnabled()).toBe(false);
    });
  });

  describe('getDefaultUserEmail', () => {
    it('returns trimmed lowercase email when DEFAULT_USER is set', () => {
      process.env.DEFAULT_USER = '  Test@Example.COM  ';

      expect(getDefaultUserEmail()).toBe('test@example.com');
    });

    it('returns null when DEFAULT_USER is not set', () => {
      delete process.env.DEFAULT_USER;

      expect(getDefaultUserEmail()).toBeNull();
    });

    it('returns null when DEFAULT_USER is empty string', () => {
      process.env.DEFAULT_USER = '';

      expect(getDefaultUserEmail()).toBeNull();
    });

    it('returns null when DEFAULT_USER is only whitespace', () => {
      process.env.DEFAULT_USER = '   ';

      expect(getDefaultUserEmail()).toBeNull();
    });

    it('handles email without whitespace correctly', () => {
      process.env.DEFAULT_USER = 'user@test.com';

      expect(getDefaultUserEmail()).toBe('user@test.com');
    });
  });

  describe('verifyDefaultPassword', () => {
    it('returns true when password matches', async () => {
      process.env.DEFAULT_PASSWORD = 'correct-password';

      const result = await verifyDefaultPassword('correct-password');

      expect(result).toBe(true);
    });

    it('returns false when password does not match', async () => {
      process.env.DEFAULT_PASSWORD = 'correct-password';

      const result = await verifyDefaultPassword('wrong-password');

      expect(result).toBe(false);
    });

    it('returns false when DEFAULT_PASSWORD is not set', async () => {
      delete process.env.DEFAULT_PASSWORD;

      const result = await verifyDefaultPassword('any-password');

      expect(result).toBe(false);
    });

    it('returns false when DEFAULT_PASSWORD is empty string', async () => {
      process.env.DEFAULT_PASSWORD = '';

      const result = await verifyDefaultPassword('some-password');

      expect(result).toBe(false);
    });

    it('handles exact match case-sensitively', async () => {
      process.env.DEFAULT_PASSWORD = 'Password123';

      expect(await verifyDefaultPassword('Password123')).toBe(true);
      expect(await verifyDefaultPassword('password123')).toBe(false);
      expect(await verifyDefaultPassword('PASSWORD123')).toBe(false);
    });
  });
});
