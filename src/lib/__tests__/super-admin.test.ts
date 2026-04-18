import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

// Mock jose before importing super-admin
vi.mock('jose', () => {
  const mockSign = vi.fn().mockResolvedValue('mock-jwt-token');
  class MockSignJWT {
    constructor(public payload: any) {}
    setProtectedHeader = vi.fn().mockReturnThis();
    setIssuedAt = vi.fn().mockReturnThis();
    setExpirationTime = vi.fn().mockReturnThis();
    sign = mockSign;
  }
  return {
    SignJWT: MockSignJWT,
    jwtVerify: vi.fn(),
  };
});

// Mock bcrypt
vi.mock('bcryptjs', () => ({
  default: {
    compare: vi.fn(),
  },
}));

// Mock cookie-utils
vi.mock('@/lib/cookie-utils', () => ({
  getCookieOptions: vi.fn((maxAge: number) => ({
    httpOnly: true,
    secure: false,
    sameSite: 'lax' as const,
    path: '/',
    maxAge,
  })),
}));

import {
  isSuperAdminEmail,
  verifySuperAdminPassword,
  createAdminToken,
  verifyAdminToken,
  getSuperAdminFromRequest,
  setAdminCookie,
  clearAdminCookie,
  getAdminCookieName,
} from '../super-admin';
import { SignJWT, jwtVerify } from 'jose';
import bcrypt from 'bcryptjs';
import { getCookieOptions } from '@/lib/cookie-utils';

describe('isSuperAdminEmail', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('returns true for matching email', () => {
    process.env.SUPER_ADMIN_EMAIL = 'admin@example.com';
    expect(isSuperAdminEmail('admin@example.com')).toBe(true);
  });

  it('returns false for non-matching email', () => {
    process.env.SUPER_ADMIN_EMAIL = 'admin@example.com';
    expect(isSuperAdminEmail('user@example.com')).toBe(false);
  });

  it('is case-insensitive', () => {
    process.env.SUPER_ADMIN_EMAIL = 'Admin@Example.COM';
    expect(isSuperAdminEmail('admin@example.com')).toBe(true);
    expect(isSuperAdminEmail('ADMIN@EXAMPLE.COM')).toBe(true);
  });

  it('returns false when SUPER_ADMIN_EMAIL is not set', () => {
    delete process.env.SUPER_ADMIN_EMAIL;
    expect(isSuperAdminEmail('admin@example.com')).toBe(false);
  });
});

describe('verifySuperAdminPassword', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('returns true when password matches', async () => {
    process.env.SUPER_ADMIN_PASSWORD_HASH = 'mock-hash';
    vi.mocked(bcrypt.compare).mockResolvedValue(true as never);

    const result = await verifySuperAdminPassword('correct-password');

    expect(result).toBe(true);
    expect(bcrypt.compare).toHaveBeenCalledWith('correct-password', 'mock-hash');
  });

  it('returns false when password does not match', async () => {
    process.env.SUPER_ADMIN_PASSWORD_HASH = 'mock-hash';
    vi.mocked(bcrypt.compare).mockResolvedValue(false as never);

    const result = await verifySuperAdminPassword('wrong-password');

    expect(result).toBe(false);
    expect(bcrypt.compare).toHaveBeenCalledWith('wrong-password', 'mock-hash');
  });

  it('returns false when SUPER_ADMIN_PASSWORD_HASH is not set', async () => {
    delete process.env.SUPER_ADMIN_PASSWORD_HASH;

    const result = await verifySuperAdminPassword('any-password');

    expect(result).toBe(false);
    expect(bcrypt.compare).not.toHaveBeenCalled();
  });

  it('returns false when bcrypt throws error', async () => {
    process.env.SUPER_ADMIN_PASSWORD_HASH = 'mock-hash';
    vi.mocked(bcrypt.compare).mockRejectedValue(new Error('bcrypt error'));

    const result = await verifySuperAdminPassword('password');

    expect(result).toBe(false);
  });
});

describe('createAdminToken', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('returns JWT string when all env vars are set', async () => {
    process.env.SUPER_ADMIN_EMAIL = 'admin@example.com';
    process.env.NEXTAUTH_SECRET = 'test-secret';

    const token = await createAdminToken();

    expect(token).toBe('mock-jwt-token');
  });

  it('throws when SUPER_ADMIN_EMAIL is missing', async () => {
    delete process.env.SUPER_ADMIN_EMAIL;
    process.env.NEXTAUTH_SECRET = 'test-secret';

    await expect(createAdminToken()).rejects.toThrow('SUPER_ADMIN_EMAIL is not set');
  });

  it('throws when NEXTAUTH_SECRET is missing', async () => {
    process.env.SUPER_ADMIN_EMAIL = 'admin@example.com';
    delete process.env.NEXTAUTH_SECRET;

    await expect(createAdminToken()).rejects.toThrow('NEXTAUTH_SECRET is not set');
  });
});

describe('verifyAdminToken', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.NEXTAUTH_SECRET = 'test-secret';
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('returns SuperAdminAuthContext for valid super_admin token', async () => {
    vi.mocked(jwtVerify).mockResolvedValue({
      payload: {
        type: 'super_admin',
        email: 'admin@example.com',
      },
    } as any);

    const result = await verifyAdminToken('valid-token');

    expect(result).toEqual({
      type: 'super_admin',
      email: 'admin@example.com',
    });
  });

  it('returns null when payload type is not super_admin', async () => {
    vi.mocked(jwtVerify).mockResolvedValue({
      payload: {
        type: 'user',
        email: 'user@example.com',
      },
    } as any);

    const result = await verifyAdminToken('wrong-type-token');

    expect(result).toBeNull();
  });

  it('returns null when email is missing from payload', async () => {
    vi.mocked(jwtVerify).mockResolvedValue({
      payload: {
        type: 'super_admin',
      },
    } as any);

    const result = await verifyAdminToken('no-email-token');

    expect(result).toBeNull();
  });

  it('returns null when email is not a string', async () => {
    vi.mocked(jwtVerify).mockResolvedValue({
      payload: {
        type: 'super_admin',
        email: 12345,
      },
    } as any);

    const result = await verifyAdminToken('invalid-email-token');

    expect(result).toBeNull();
  });

  it('returns null when jwtVerify throws', async () => {
    vi.mocked(jwtVerify).mockRejectedValue(new Error('Invalid token'));

    const result = await verifyAdminToken('invalid-token');

    expect(result).toBeNull();
  });
});

describe('getSuperAdminFromRequest', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.NEXTAUTH_SECRET = 'test-secret';
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  function makeRequest(cookie?: string) {
    return {
      cookies: {
        get: (name: string) => (cookie && name === 'admin_session' ? { value: cookie } : undefined),
      },
    } as unknown as NextRequest;
  }

  it('returns SuperAdminAuthContext when valid cookie is present', async () => {
    vi.mocked(jwtVerify).mockResolvedValue({
      payload: {
        type: 'super_admin',
        email: 'admin@example.com',
      },
    } as any);

    const request = makeRequest('valid-token');
    const result = await getSuperAdminFromRequest(request);

    expect(result).toEqual({
      type: 'super_admin',
      email: 'admin@example.com',
    });
  });

  it('returns null when cookie is not present', async () => {
    const request = makeRequest();
    const result = await getSuperAdminFromRequest(request);

    expect(result).toBeNull();
  });

  it('returns null when token is invalid', async () => {
    vi.mocked(jwtVerify).mockRejectedValue(new Error('Invalid token'));

    const request = makeRequest('invalid-token');
    const result = await getSuperAdminFromRequest(request);

    expect(result).toBeNull();
  });
});

describe('setAdminCookie', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sets cookie with correct name and options', () => {
    const mockSetCookie = vi.fn();
    const response = {
      cookies: {
        set: mockSetCookie,
      },
    } as unknown as NextResponse;

    setAdminCookie(response, 'test-token');

    expect(mockSetCookie).toHaveBeenCalledWith('admin_session', 'test-token', {
      httpOnly: true,
      secure: false,
      sameSite: 'lax',
      path: '/',
      maxAge: 60 * 60 * 24,
    });
    expect(getCookieOptions).toHaveBeenCalledWith(60 * 60 * 24);
  });
});

describe('clearAdminCookie', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('clears cookie by setting maxAge to 0', () => {
    const mockSetCookie = vi.fn();
    const response = {
      cookies: {
        set: mockSetCookie,
      },
    } as unknown as NextResponse;

    clearAdminCookie(response);

    expect(mockSetCookie).toHaveBeenCalledWith('admin_session', '', {
      httpOnly: true,
      secure: false,
      sameSite: 'lax',
      path: '/',
      maxAge: 0,
    });
    expect(getCookieOptions).toHaveBeenCalledWith(0);
  });
});

describe('getAdminCookieName', () => {
  it('returns admin_session', () => {
    expect(getAdminCookieName()).toBe('admin_session');
  });
});
