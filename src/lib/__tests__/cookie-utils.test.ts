import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getCookieOptions } from '../cookie-utils';

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
