import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

// Mock jose before importing user-session
const mockSign = vi.fn().mockResolvedValue('mock-jwt-token');
const mockSetProtectedHeader = vi.fn().mockReturnThis();
const mockSetIssuedAt = vi.fn().mockReturnThis();
const mockSetExpirationTime = vi.fn().mockReturnThis();

vi.mock('jose', () => {
  class MockSignJWT {
    constructor(public payload: any) {}
    setProtectedHeader = mockSetProtectedHeader;
    setIssuedAt = mockSetIssuedAt;
    setExpirationTime = mockSetExpirationTime;
    sign = mockSign;
  }
  return {
    SignJWT: MockSignJWT,
    jwtVerify: vi.fn(),
  };
});

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
  createUserAccessToken,
  createUserRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
  extractBearerToken,
  getUserSessionFromRequest,
  getFullSessionFromRequest,
  setUserSessionCookies,
  clearUserSessionCookies,
  getRefreshTokenFromRequest,
  ACCESS_TOKEN_EXPIRY,
  ACCESS_TOKEN_MAX_AGE,
  USER_SESSION_COOKIE,
  USER_REFRESH_COOKIE,
  UserSessionPayload,
} from '../user-session';
import { SignJWT, jwtVerify } from 'jose';
import { getCookieOptions } from '@/lib/cookie-utils';

describe('createUserAccessToken', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.NEXTAUTH_SECRET = 'test-secret';
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('returns JWT string with tokenType access', async () => {
    const payload: UserSessionPayload = {
      type: 'user',
      userUuid: 'user-123',
      companyUuid: 'company-456',
      email: 'user@example.com',
      name: 'Test User',
      oidcSub: 'oidc-sub-123',
    };

    const token = await createUserAccessToken(payload);

    expect(token).toBe('mock-jwt-token');
    expect(mockSign).toHaveBeenCalled();
  });

  it('includes optional OIDC tokens when provided', async () => {
    const payload: UserSessionPayload = {
      type: 'user',
      userUuid: 'user-123',
      companyUuid: 'company-456',
      email: 'user@example.com',
      oidcSub: 'oidc-sub-123',
      oidcAccessToken: 'oidc-access',
      oidcRefreshToken: 'oidc-refresh',
      oidcExpiresAt: 1234567890,
    };

    const token = await createUserAccessToken(payload);

    expect(token).toBe('mock-jwt-token');
    expect(mockSign).toHaveBeenCalled();
  });

  it('throws when NEXTAUTH_SECRET is missing', async () => {
    delete process.env.NEXTAUTH_SECRET;
    const payload: UserSessionPayload = {
      type: 'user',
      userUuid: 'user-123',
      companyUuid: 'company-456',
      email: 'user@example.com',
      oidcSub: 'oidc-sub-123',
    };

    await expect(createUserAccessToken(payload)).rejects.toThrow('NEXTAUTH_SECRET is not set');
  });
});

describe('createUserRefreshToken', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.NEXTAUTH_SECRET = 'test-secret';
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('returns JWT string with tokenType refresh', async () => {
    const payload: UserSessionPayload = {
      type: 'user',
      userUuid: 'user-123',
      companyUuid: 'company-456',
      email: 'user@example.com',
      oidcSub: 'oidc-sub-123',
    };

    const token = await createUserRefreshToken(payload);

    expect(token).toBe('mock-jwt-token');
    expect(mockSign).toHaveBeenCalled();
  });

  it('only includes userUuid and companyUuid in refresh token', async () => {
    const payload: UserSessionPayload = {
      type: 'user',
      userUuid: 'user-123',
      companyUuid: 'company-456',
      email: 'user@example.com',
      name: 'Test User',
      oidcSub: 'oidc-sub-123',
      oidcAccessToken: 'oidc-access',
      oidcRefreshToken: 'oidc-refresh',
    };

    const token = await createUserRefreshToken(payload);

    expect(token).toBe('mock-jwt-token');
    expect(mockSign).toHaveBeenCalled();
  });

  it('throws when NEXTAUTH_SECRET is missing', async () => {
    delete process.env.NEXTAUTH_SECRET;
    const payload: UserSessionPayload = {
      type: 'user',
      userUuid: 'user-123',
      companyUuid: 'company-456',
      email: 'user@example.com',
      oidcSub: 'oidc-sub-123',
    };

    await expect(createUserRefreshToken(payload)).rejects.toThrow('NEXTAUTH_SECRET is not set');
  });
});

describe('verifyAccessToken', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.NEXTAUTH_SECRET = 'test-secret';
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('returns UserSessionPayload for valid access token', async () => {
    vi.mocked(jwtVerify).mockResolvedValue({
      payload: {
        type: 'user',
        tokenType: 'access',
        userUuid: 'user-123',
        companyUuid: 'company-456',
        email: 'user@example.com',
        name: 'Test User',
        oidcSub: 'oidc-sub-123',
      },
    } as any);

    const result = await verifyAccessToken('valid-token');

    expect(result).toEqual({
      type: 'user',
      userUuid: 'user-123',
      companyUuid: 'company-456',
      email: 'user@example.com',
      name: 'Test User',
      oidcSub: 'oidc-sub-123',
      oidcAccessToken: undefined,
      oidcRefreshToken: undefined,
      oidcExpiresAt: undefined,
    });
  });

  it('includes OIDC tokens when present in payload', async () => {
    vi.mocked(jwtVerify).mockResolvedValue({
      payload: {
        type: 'user',
        tokenType: 'access',
        userUuid: 'user-123',
        companyUuid: 'company-456',
        email: 'user@example.com',
        oidcSub: 'oidc-sub-123',
        oidcAccessToken: 'oidc-access',
        oidcRefreshToken: 'oidc-refresh',
        oidcExpiresAt: 1234567890,
      },
    } as any);

    const result = await verifyAccessToken('valid-token');

    expect(result?.oidcAccessToken).toBe('oidc-access');
    expect(result?.oidcRefreshToken).toBe('oidc-refresh');
    expect(result?.oidcExpiresAt).toBe(1234567890);
  });

  it('returns null when tokenType is not access', async () => {
    vi.mocked(jwtVerify).mockResolvedValue({
      payload: {
        type: 'user',
        tokenType: 'refresh',
        userUuid: 'user-123',
        companyUuid: 'company-456',
      },
    } as any);

    const result = await verifyAccessToken('refresh-token');

    expect(result).toBeNull();
  });

  it('returns null when type is not user', async () => {
    vi.mocked(jwtVerify).mockResolvedValue({
      payload: {
        type: 'agent',
        tokenType: 'access',
      },
    } as any);

    const result = await verifyAccessToken('agent-token');

    expect(result).toBeNull();
  });

  it('returns null when jwtVerify throws', async () => {
    vi.mocked(jwtVerify).mockRejectedValue(new Error('Invalid token'));

    const result = await verifyAccessToken('invalid-token');

    expect(result).toBeNull();
  });
});

describe('verifyRefreshToken', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.NEXTAUTH_SECRET = 'test-secret';
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('returns minimal payload for valid refresh token', async () => {
    vi.mocked(jwtVerify).mockResolvedValue({
      payload: {
        tokenType: 'refresh',
        userUuid: 'user-123',
        companyUuid: 'company-456',
      },
    } as any);

    const result = await verifyRefreshToken('valid-refresh-token');

    expect(result).toEqual({
      userUuid: 'user-123',
      companyUuid: 'company-456',
    });
  });

  it('returns null when tokenType is not refresh', async () => {
    vi.mocked(jwtVerify).mockResolvedValue({
      payload: {
        tokenType: 'access',
        userUuid: 'user-123',
        companyUuid: 'company-456',
      },
    } as any);

    const result = await verifyRefreshToken('access-token');

    expect(result).toBeNull();
  });

  it('returns null when jwtVerify throws', async () => {
    vi.mocked(jwtVerify).mockRejectedValue(new Error('Invalid token'));

    const result = await verifyRefreshToken('invalid-token');

    expect(result).toBeNull();
  });
});

describe('extractBearerToken', () => {
  it('extracts token from Bearer header', () => {
    expect(extractBearerToken('Bearer my-token-123')).toBe('my-token-123');
  });

  it('is case-insensitive for Bearer keyword', () => {
    expect(extractBearerToken('bearer my-token-123')).toBe('my-token-123');
    expect(extractBearerToken('BEARER my-token-123')).toBe('my-token-123');
  });

  it('returns null for null header', () => {
    expect(extractBearerToken(null)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(extractBearerToken('')).toBeNull();
  });

  it('returns null for non-Bearer auth schemes', () => {
    expect(extractBearerToken('Basic dXNlcjpwYXNz')).toBeNull();
  });

  it('returns null for malformed Bearer header', () => {
    expect(extractBearerToken('Bearer')).toBeNull();
    expect(extractBearerToken('Bearer ')).toBeNull();
  });
});

describe('getUserSessionFromRequest', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    process.env = { ...originalEnv };
    process.env.NEXTAUTH_SECRET = 'test-secret';
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  function makeRequest(opts: { cookie?: string; authHeader?: string } = {}) {
    return {
      cookies: {
        get: (name: string) => (opts.cookie && name === 'user_session' ? { value: opts.cookie } : undefined),
      },
      headers: {
        get: (name: string) => (name === 'authorization' ? (opts.authHeader ?? null) : null),
      },
    } as unknown as NextRequest;
  }

  it('returns UserAuthContext from Bearer token', async () => {
    vi.mocked(jwtVerify).mockResolvedValue({
      payload: {
        type: 'user',
        tokenType: 'access',
        userUuid: 'user-123',
        companyUuid: 'company-456',
        email: 'user@example.com',
        name: 'Test User',
        oidcSub: 'oidc-sub-123',
      },
    } as any);

    const request = makeRequest({ authHeader: 'Bearer valid-token' });
    const result = await getUserSessionFromRequest(request);

    expect(result).toEqual({
      type: 'user',
      companyUuid: 'company-456',
      actorUuid: 'user-123',
      email: 'user@example.com',
      name: 'Test User',
    });
  });

  it('falls back to cookie when no Bearer token', async () => {
    vi.mocked(jwtVerify).mockResolvedValue({
      payload: {
        type: 'user',
        tokenType: 'access',
        userUuid: 'user-123',
        companyUuid: 'company-456',
        email: 'user@example.com',
        oidcSub: 'oidc-sub-123',
      },
    } as any);

    const request = makeRequest({ cookie: 'cookie-token' });
    const result = await getUserSessionFromRequest(request);

    expect(result).toEqual({
      type: 'user',
      companyUuid: 'company-456',
      actorUuid: 'user-123',
      email: 'user@example.com',
      name: undefined,
    });
  });

  it('returns null when no auth present', async () => {
    const request = makeRequest();
    const result = await getUserSessionFromRequest(request);

    expect(result).toBeNull();
  });

  it('returns null when Bearer token is invalid', async () => {
    vi.mocked(jwtVerify).mockRejectedValue(new Error('Invalid token'));

    const request = makeRequest({ authHeader: 'Bearer invalid-token' });
    const result = await getUserSessionFromRequest(request);

    expect(result).toBeNull();
  });

  it('returns null when cookie token is invalid', async () => {
    vi.mocked(jwtVerify).mockRejectedValue(new Error('Invalid token'));

    const request = makeRequest({ cookie: 'invalid-cookie-token' });
    const result = await getUserSessionFromRequest(request);

    expect(result).toBeNull();
  });

  it('prefers Bearer token over cookie when both present', async () => {
    let callCount = 0;
    vi.mocked(jwtVerify).mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        return Promise.resolve({
          payload: {
            type: 'user',
            tokenType: 'access',
            userUuid: 'bearer-user',
            companyUuid: 'bearer-company',
            email: 'bearer@example.com',
            oidcSub: 'bearer-sub',
          },
        } as any);
      }
      return Promise.resolve({
        payload: {
          type: 'user',
          tokenType: 'access',
          userUuid: 'cookie-user',
          companyUuid: 'cookie-company',
          email: 'cookie@example.com',
          oidcSub: 'cookie-sub',
        },
      } as any);
    });

    const request = makeRequest({ authHeader: 'Bearer bearer-token', cookie: 'cookie-token' });
    const result = await getUserSessionFromRequest(request);

    expect(result?.actorUuid).toBe('bearer-user');
  });
});

describe('getFullSessionFromRequest', () => {
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
        get: (name: string) => (cookie && name === 'user_session' ? { value: cookie } : undefined),
      },
    } as unknown as NextRequest;
  }

  it('returns full UserSessionPayload when cookie is present', async () => {
    vi.mocked(jwtVerify).mockResolvedValue({
      payload: {
        type: 'user',
        tokenType: 'access',
        userUuid: 'user-123',
        companyUuid: 'company-456',
        email: 'user@example.com',
        name: 'Test User',
        oidcSub: 'oidc-sub-123',
        oidcAccessToken: 'oidc-access',
        oidcRefreshToken: 'oidc-refresh',
        oidcExpiresAt: 1234567890,
      },
    } as any);

    const request = makeRequest('valid-token');
    const result = await getFullSessionFromRequest(request);

    expect(result).toEqual({
      type: 'user',
      userUuid: 'user-123',
      companyUuid: 'company-456',
      email: 'user@example.com',
      name: 'Test User',
      oidcSub: 'oidc-sub-123',
      oidcAccessToken: 'oidc-access',
      oidcRefreshToken: 'oidc-refresh',
      oidcExpiresAt: 1234567890,
    });
  });

  it('returns null when cookie is not present', async () => {
    const request = makeRequest();
    const result = await getFullSessionFromRequest(request);

    expect(result).toBeNull();
  });

  it('returns null when token is invalid', async () => {
    vi.mocked(jwtVerify).mockRejectedValue(new Error('Invalid token'));

    const request = makeRequest('invalid-token');
    const result = await getFullSessionFromRequest(request);

    expect(result).toBeNull();
  });
});

describe('setUserSessionCookies', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sets both access and refresh cookies', () => {
    const mockSetCookie = vi.fn();
    const response = {
      cookies: {
        set: mockSetCookie,
      },
    } as unknown as NextResponse;

    setUserSessionCookies(response, 'access-token', 'refresh-token');

    expect(mockSetCookie).toHaveBeenCalledTimes(2);
    expect(mockSetCookie).toHaveBeenCalledWith('user_session', 'access-token', {
      httpOnly: true,
      secure: false,
      sameSite: 'lax',
      path: '/',
      maxAge: 60 * 60,
    });
    expect(mockSetCookie).toHaveBeenCalledWith('user_refresh', 'refresh-token', {
      httpOnly: true,
      secure: false,
      sameSite: 'lax',
      path: '/',
      maxAge: 7 * 24 * 60 * 60,
    });
  });

  it('calls getCookieOptions with correct maxAge values', () => {
    const mockSetCookie = vi.fn();
    const response = {
      cookies: {
        set: mockSetCookie,
      },
    } as unknown as NextResponse;

    setUserSessionCookies(response, 'access-token', 'refresh-token');

    expect(getCookieOptions).toHaveBeenCalledWith(60 * 60); // ACCESS_TOKEN_MAX_AGE
    expect(getCookieOptions).toHaveBeenCalledWith(7 * 24 * 60 * 60); // 7 days
  });
});

describe('clearUserSessionCookies', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('clears both access and refresh cookies', () => {
    const mockSetCookie = vi.fn();
    const response = {
      cookies: {
        set: mockSetCookie,
      },
    } as unknown as NextResponse;

    clearUserSessionCookies(response);

    expect(mockSetCookie).toHaveBeenCalledTimes(2);
    expect(mockSetCookie).toHaveBeenCalledWith('user_session', '', {
      httpOnly: true,
      secure: false,
      sameSite: 'lax',
      path: '/',
      maxAge: 0,
    });
    expect(mockSetCookie).toHaveBeenCalledWith('user_refresh', '', {
      httpOnly: true,
      secure: false,
      sameSite: 'lax',
      path: '/',
      maxAge: 0,
    });
  });
});

describe('getRefreshTokenFromRequest', () => {
  function makeRequest(cookie?: string) {
    return {
      cookies: {
        get: (name: string) => (cookie && name === 'user_refresh' ? { value: cookie } : undefined),
      },
    } as unknown as NextRequest;
  }

  it('returns refresh token from cookie', () => {
    const request = makeRequest('refresh-token');
    const result = getRefreshTokenFromRequest(request);

    expect(result).toBe('refresh-token');
  });

  it('returns null when cookie is not present', () => {
    const request = makeRequest();
    const result = getRefreshTokenFromRequest(request);

    expect(result).toBeNull();
  });
});

describe('constants', () => {
  it('exports correct constants', () => {
    expect(ACCESS_TOKEN_EXPIRY).toBe('1h');
    expect(ACCESS_TOKEN_MAX_AGE).toBe(60 * 60);
    expect(USER_SESSION_COOKIE).toBe('user_session');
    expect(USER_REFRESH_COOKIE).toBe('user_refresh');
  });
});
