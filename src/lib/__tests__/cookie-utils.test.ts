import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getCookieOptions } from '../cookie-utils';

describe('getCookieOptions', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('returns secure=true in production mode by default', () => {
    process.env.NODE_ENV = 'production';
    delete process.env.COOKIE_SECURE;

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
    process.env.NODE_ENV = 'production';
    process.env.COOKIE_SECURE = 'false';

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
    process.env.NODE_ENV = 'development';
    delete process.env.COOKIE_SECURE;

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
    process.env.NODE_ENV = 'test';
    const maxAge = 9999;

    const result = getCookieOptions(maxAge);

    expect(result.maxAge).toBe(9999);
  });

  it('returns correct properties when NODE_ENV is undefined', () => {
    delete process.env.NODE_ENV;
    delete process.env.COOKIE_SECURE;

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
