import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getCookieOptions, getMaxAgeFromJwt } from '../cookie-utils';

const env = process.env as Record<string, string | undefined>;

describe('getCookieOptions', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    Object.keys(process.env).forEach((key) => {
      if (!(key in originalEnv)) delete env[key];
    });
    Object.assign(env, originalEnv);
  });

  afterEach(() => {
    Object.keys(process.env).forEach((key) => {
      if (!(key in originalEnv)) delete env[key];
    });
    Object.assign(env, originalEnv);
  });

  it('returns secure=true in production mode by default', () => {
    env.NODE_ENV = 'production';
    delete env.COOKIE_SECURE;

    const result = getCookieOptions(3600);

    expect(result).toEqual({
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      path: '/',
      maxAge: 3600,
    });
  });

  it('returns secure=false when COOKIE_SECURE=false override is set', () => {
    env.NODE_ENV = 'production';
    env.COOKIE_SECURE = 'false';

    const result = getCookieOptions(7200);

    expect(result).toEqual({
      httpOnly: true,
      secure: false,
      sameSite: 'lax',
      path: '/',
      maxAge: 7200,
    });
  });

  it('returns secure=false in non-production mode', () => {
    env.NODE_ENV = 'development';
    delete env.COOKIE_SECURE;

    const result = getCookieOptions(1800);

    expect(result).toEqual({
      httpOnly: true,
      secure: false,
      sameSite: 'lax',
      path: '/',
      maxAge: 1800,
    });
  });

  it('passes through maxAge parameter correctly', () => {
    env.NODE_ENV = 'test';
    const maxAge = 9999;

    const result = getCookieOptions(maxAge);

    expect(result.maxAge).toBe(9999);
  });

  it('returns correct properties when NODE_ENV is undefined', () => {
    delete env.NODE_ENV;
    delete env.COOKIE_SECURE;

    const result = getCookieOptions(1234);

    expect(result).toEqual({
      httpOnly: true,
      secure: false,
      sameSite: 'lax',
      path: '/',
      maxAge: 1234,
    });
  });
});

// Helper: build a minimal JWT with a given payload (no real signature needed)
function fakeJwt(payload: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256' })).toString('base64url');
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${header}.${body}.fakesig`;
}

describe('getMaxAgeFromJwt', () => {
  it('computes maxAge from exp claim with 60s buffer', () => {
    const exp = Math.floor(Date.now() / 1000) + 3600; // 1h from now
    const result = getMaxAgeFromJwt(fakeJwt({ exp }));
    // Should be ~3660 (3600 + 60s buffer), allow 2s tolerance
    expect(result).toBeGreaterThanOrEqual(3658);
    expect(result).toBeLessThanOrEqual(3662);
  });

  it('returns 0 when token is already expired', () => {
    const exp = Math.floor(Date.now() / 1000) - 120; // 2 min ago
    const result = getMaxAgeFromJwt(fakeJwt({ exp }));
    expect(result).toBe(0);
  });

  it('returns fallback when token has no exp claim', () => {
    const result = getMaxAgeFromJwt(fakeJwt({ sub: 'user' }));
    expect(result).toBe(3600);
  });

  it('returns custom fallback when provided', () => {
    const result = getMaxAgeFromJwt(fakeJwt({ sub: 'user' }), 7200);
    expect(result).toBe(7200);
  });

  it('returns fallback for malformed token', () => {
    expect(getMaxAgeFromJwt('not-a-jwt')).toBe(3600);
    expect(getMaxAgeFromJwt('')).toBe(3600);
  });
});
