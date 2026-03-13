import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock next/headers before importing the module under test
const mockCookies = vi.hoisted(() => vi.fn());
vi.mock('next/headers', () => ({
  cookies: mockCookies,
}));

// Mock the auth modules
const mockVerifyOidcAccessToken = vi.hoisted(() => vi.fn());
const mockVerifyAccessToken = vi.hoisted(() => vi.fn());

vi.mock('../oidc-auth', () => ({
  verifyOidcAccessToken: mockVerifyOidcAccessToken,
}));

vi.mock('../user-session', () => ({
  verifyAccessToken: mockVerifyAccessToken,
}));

// Now import the module under test
import { getServerAuthContext } from '../auth-server';
import type { UserAuthContext } from '@/types/auth';

describe('getServerAuthContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function mockCookieStore(cookies: Record<string, string>) {
    const cookieStore = {
      get: (name: string) => {
        const value = cookies[name];
        return value ? { name, value } : undefined;
      },
    };
    mockCookies.mockResolvedValue(cookieStore);
  }

  it('returns user context when OIDC token cookie is present', async () => {
    const mockUserContext: UserAuthContext = {
      type: 'user',
      companyUuid: 'company-uuid',
      actorUuid: 'user-uuid',
      email: 'user@test.com',
      name: 'Test User',
    };

    mockCookieStore({ oidc_access_token: 'valid-oidc-token' });
    mockVerifyOidcAccessToken.mockResolvedValue(mockUserContext);

    const result = await getServerAuthContext();

    expect(result).toEqual(mockUserContext);
    expect(mockVerifyOidcAccessToken).toHaveBeenCalledWith('valid-oidc-token');
    expect(mockVerifyAccessToken).not.toHaveBeenCalled();
  });

  it('returns user context from user_session cookie when no OIDC cookie', async () => {
    const mockPayload = {
      companyUuid: 'company-uuid',
      userUuid: 'user-uuid',
      email: 'user@test.com',
      name: 'Test User',
    };

    mockCookieStore({ user_session: 'valid-session-token' });
    mockVerifyAccessToken.mockResolvedValue(mockPayload);

    const result = await getServerAuthContext();

    expect(result).toEqual({
      type: 'user',
      companyUuid: 'company-uuid',
      actorUuid: 'user-uuid',
      email: 'user@test.com',
      name: 'Test User',
    });
    expect(mockVerifyAccessToken).toHaveBeenCalledWith('valid-session-token');
    expect(mockVerifyOidcAccessToken).not.toHaveBeenCalled();
  });

  it('returns null when no cookies are present', async () => {
    mockCookieStore({});

    const result = await getServerAuthContext();

    expect(result).toBeNull();
    expect(mockVerifyOidcAccessToken).not.toHaveBeenCalled();
    expect(mockVerifyAccessToken).not.toHaveBeenCalled();
  });

  it('returns null when user_session token is invalid', async () => {
    mockCookieStore({ user_session: 'invalid-token' });
    mockVerifyAccessToken.mockResolvedValue(null);

    const result = await getServerAuthContext();

    expect(result).toBeNull();
    expect(mockVerifyAccessToken).toHaveBeenCalledWith('invalid-token');
  });

  it('prefers OIDC token over user_session when both are present', async () => {
    const mockUserContext: UserAuthContext = {
      type: 'user',
      companyUuid: 'oidc-company',
      actorUuid: 'oidc-user',
      email: 'oidc@test.com',
    };

    mockCookieStore({
      oidc_access_token: 'oidc-token',
      user_session: 'session-token',
    });
    mockVerifyOidcAccessToken.mockResolvedValue(mockUserContext);

    const result = await getServerAuthContext();

    expect(result).toEqual(mockUserContext);
    expect(mockVerifyOidcAccessToken).toHaveBeenCalledWith('oidc-token');
    expect(mockVerifyAccessToken).not.toHaveBeenCalled();
  });

  it('returns null when OIDC token verification returns null', async () => {
    mockCookieStore({ oidc_access_token: 'invalid-oidc-token' });
    mockVerifyOidcAccessToken.mockResolvedValue(null);

    const result = await getServerAuthContext();

    expect(result).toBeNull();
    expect(mockVerifyOidcAccessToken).toHaveBeenCalledWith('invalid-oidc-token');
  });

  it('maps user session payload correctly without name field', async () => {
    const mockPayload = {
      companyUuid: 'company-uuid',
      userUuid: 'user-uuid',
      email: 'user@test.com',
      // name is optional
    };

    mockCookieStore({ user_session: 'valid-session-token' });
    mockVerifyAccessToken.mockResolvedValue(mockPayload);

    const result = await getServerAuthContext();

    expect(result).toEqual({
      type: 'user',
      companyUuid: 'company-uuid',
      actorUuid: 'user-uuid',
      email: 'user@test.com',
      name: undefined,
    });
  });
});
