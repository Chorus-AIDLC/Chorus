import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { User } from 'oidc-client-ts';

// Mock the oidc module
vi.mock('../oidc', () => ({
  createUserManager: vi.fn(),
  getStoredOidcConfig: vi.fn(),
  storeOidcConfig: vi.fn(),
  clearOidcConfig: vi.fn(),
}));

import {
  getUserManager,
  initUserManager,
  clearUserManager,
  getOidcUser,
  getAccessToken,
  isAuthenticated,
  syncTokenToCookie,
  authFetch,
  createAuthFetcher,
  login,
  logout,
} from '../auth-client';
import { createUserManager, getStoredOidcConfig, storeOidcConfig, clearOidcConfig } from '../oidc';
import type { OidcConfig } from '../oidc';

const mockConfig: OidcConfig = {
  issuer: 'https://auth.example.com',
  clientId: 'test-client-id',
  companyUuid: 'company-123',
  companyName: 'Test Company',
};

// Helper to create mock UserManager
function createMockUserManager(overrides = {}) {
  return {
    getUser: vi.fn(),
    signinSilent: vi.fn(),
    signinRedirect: vi.fn(),
    signoutRedirect: vi.fn(),
    removeUser: vi.fn(),
    ...overrides,
  };
}

// Helper to create mock User
function createMockUser(overrides = {}): User {
  return {
    access_token: 'access-token-xyz',
    refresh_token: 'refresh-token-abc',
    expires_at: Math.floor(Date.now() / 1000) + 3600, // 1 hour from now
    expired: false,
    profile: {
      sub: 'user-123',
      email: 'user@example.com',
      name: 'Test User',
    },
    ...overrides,
  } as any;
}

describe('getUserManager', () => {
  beforeEach(() => {
    clearUserManager();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns null when window is undefined', () => {
    const result = getUserManager();
    expect(result).toBeNull();
  });

  it('returns null when no stored config exists', () => {
    vi.stubGlobal('window', { localStorage: {} });
    vi.mocked(getStoredOidcConfig).mockReturnValue(null);

    const result = getUserManager();

    expect(result).toBeNull();
  });

  it('creates UserManager from stored config', () => {
    vi.stubGlobal('window', { localStorage: {} });
    const mockManager = createMockUserManager();
    vi.mocked(getStoredOidcConfig).mockReturnValue(mockConfig);
    vi.mocked(createUserManager).mockReturnValue(mockManager as any);

    const result = getUserManager();

    expect(createUserManager).toHaveBeenCalledWith(mockConfig);
    expect(result).toBe(mockManager);
  });

  it('returns cached instance on subsequent calls', () => {
    vi.stubGlobal('window', { localStorage: {} });
    const mockManager = createMockUserManager();
    vi.mocked(getStoredOidcConfig).mockReturnValue(mockConfig);
    vi.mocked(createUserManager).mockReturnValue(mockManager as any);

    const first = getUserManager();
    const second = getUserManager();

    expect(createUserManager).toHaveBeenCalledTimes(1);
    expect(first).toBe(second);
  });
});

describe('initUserManager', () => {
  beforeEach(() => {
    clearUserManager();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('stores config and creates UserManager', () => {
    const mockManager = createMockUserManager();
    vi.mocked(createUserManager).mockReturnValue(mockManager as any);

    const result = initUserManager(mockConfig);

    expect(storeOidcConfig).toHaveBeenCalledWith(mockConfig);
    expect(createUserManager).toHaveBeenCalledWith(mockConfig);
    expect(result).toBe(mockManager);
  });
});

describe('clearUserManager', () => {
  beforeEach(() => {
    clearUserManager();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('resets the singleton', () => {
    vi.stubGlobal('window', { localStorage: {} });
    const mockManager1 = createMockUserManager();
    const mockManager2 = createMockUserManager();

    // First call creates instance
    vi.mocked(getStoredOidcConfig).mockReturnValue(mockConfig);
    vi.mocked(createUserManager).mockReturnValueOnce(mockManager1 as any);
    const first = getUserManager();
    expect(first).toBe(mockManager1);

    // Second call without clear returns cached instance
    const second = getUserManager();
    expect(second).toBe(mockManager1);
    expect(createUserManager).toHaveBeenCalledTimes(1);

    // Reset the singleton
    clearUserManager();

    // Third call after reset should create new instance
    vi.mocked(createUserManager).mockReturnValueOnce(mockManager2 as any);
    const third = getUserManager();
    expect(third).toBe(mockManager2);
    expect(createUserManager).toHaveBeenCalledTimes(2);
  });
});

describe('getOidcUser', () => {
  beforeEach(() => {
    clearUserManager();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns null when no manager exists', async () => {
    const result = await getOidcUser();
    expect(result).toBeNull();
  });

  it('delegates to manager.getUser()', async () => {
    vi.stubGlobal('window', { localStorage: {} });
    const mockUser = createMockUser();
    const mockManager = createMockUserManager({
      getUser: vi.fn().mockResolvedValue(mockUser),
    });
    vi.mocked(getStoredOidcConfig).mockReturnValue(mockConfig);
    vi.mocked(createUserManager).mockReturnValue(mockManager as any);

    const result = await getOidcUser();

    expect(mockManager.getUser).toHaveBeenCalled();
    expect(result).toBe(mockUser);
  });

  it('returns null on error', async () => {
    vi.stubGlobal('window', { localStorage: {} });
    const mockManager = createMockUserManager({
      getUser: vi.fn().mockRejectedValue(new Error('Get user failed')),
    });
    vi.mocked(getStoredOidcConfig).mockReturnValue(mockConfig);
    vi.mocked(createUserManager).mockReturnValue(mockManager as any);

    const result = await getOidcUser();

    expect(result).toBeNull();
  });
});

describe('getAccessToken', () => {
  beforeEach(() => {
    clearUserManager();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns null when user does not exist', async () => {
    vi.stubGlobal('window', { localStorage: {} });
    const mockManager = createMockUserManager({
      getUser: vi.fn().mockResolvedValue(null),
    });
    vi.mocked(getStoredOidcConfig).mockReturnValue(mockConfig);
    vi.mocked(createUserManager).mockReturnValue(mockManager as any);

    const result = await getAccessToken();

    expect(result).toBeNull();
  });

  it('returns token from non-expired user', async () => {
    vi.stubGlobal('window', { localStorage: {} });
    const mockUser = createMockUser();
    const mockManager = createMockUserManager({
      getUser: vi.fn().mockResolvedValue(mockUser),
    });
    vi.mocked(getStoredOidcConfig).mockReturnValue(mockConfig);
    vi.mocked(createUserManager).mockReturnValue(mockManager as any);

    const result = await getAccessToken();

    expect(result).toBe('access-token-xyz');
    expect(mockManager.signinSilent).not.toHaveBeenCalled();
  });

  it('attempts signinSilent for expired user', async () => {
    vi.stubGlobal('window', { localStorage: {} });
    const expiredUser = createMockUser({ expired: true });
    const renewedUser = createMockUser({ access_token: 'renewed-token' });
    const mockManager = createMockUserManager({
      getUser: vi.fn().mockResolvedValue(expiredUser),
      signinSilent: vi.fn().mockResolvedValue(renewedUser),
    });
    vi.mocked(getStoredOidcConfig).mockReturnValue(mockConfig);
    vi.mocked(createUserManager).mockReturnValue(mockManager as any);

    const result = await getAccessToken();

    expect(mockManager.signinSilent).toHaveBeenCalled();
    expect(result).toBe('renewed-token');
  });

  it('returns null when signinSilent fails', async () => {
    vi.stubGlobal('window', { localStorage: {} });
    const expiredUser = createMockUser({ expired: true });
    const mockManager = createMockUserManager({
      getUser: vi.fn().mockResolvedValue(expiredUser),
      signinSilent: vi.fn().mockRejectedValue(new Error('Silent renew failed')),
    });
    vi.mocked(getStoredOidcConfig).mockReturnValue(mockConfig);
    vi.mocked(createUserManager).mockReturnValue(mockManager as any);

    const result = await getAccessToken();

    expect(result).toBeNull();
  });

  it('returns null when expired user but no manager', async () => {
    // This edge case shouldn't happen in practice, but test defensive code
    const result = await getAccessToken();
    expect(result).toBeNull();
  });
});

describe('isAuthenticated', () => {
  beforeEach(() => {
    clearUserManager();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns true when user exists and not expired', async () => {
    vi.stubGlobal('window', { localStorage: {} });
    const mockUser = createMockUser();
    const mockManager = createMockUserManager({
      getUser: vi.fn().mockResolvedValue(mockUser),
    });
    vi.mocked(getStoredOidcConfig).mockReturnValue(mockConfig);
    vi.mocked(createUserManager).mockReturnValue(mockManager as any);

    const result = await isAuthenticated();

    expect(result).toBe(true);
  });

  it('returns false when user does not exist', async () => {
    vi.stubGlobal('window', { localStorage: {} });
    const mockManager = createMockUserManager({
      getUser: vi.fn().mockResolvedValue(null),
    });
    vi.mocked(getStoredOidcConfig).mockReturnValue(mockConfig);
    vi.mocked(createUserManager).mockReturnValue(mockManager as any);

    const result = await isAuthenticated();

    expect(result).toBe(false);
  });

  it('returns false when user is expired', async () => {
    vi.stubGlobal('window', { localStorage: {} });
    const expiredUser = createMockUser({ expired: true });
    const mockManager = createMockUserManager({
      getUser: vi.fn().mockResolvedValue(expiredUser),
    });
    vi.mocked(getStoredOidcConfig).mockReturnValue(mockConfig);
    vi.mocked(createUserManager).mockReturnValue(mockManager as any);

    const result = await isAuthenticated();

    expect(result).toBe(false);
  });
});

describe('syncTokenToCookie', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn());
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('calls /api/auth/sync-token and returns true on success', async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: true } as any);

    const result = await syncTokenToCookie('access-token', 'refresh-token');

    expect(fetch).toHaveBeenCalledWith('/api/auth/sync-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ accessToken: 'access-token', refreshToken: 'refresh-token' }),
    });
    expect(result).toBe(true);
  });

  it('returns false on non-ok response', async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: false } as any);

    const result = await syncTokenToCookie('access-token');

    expect(result).toBe(false);
  });

  it('returns false on error', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('Network error'));

    const result = await syncTokenToCookie('access-token');

    expect(result).toBe(false);
    expect(console.error).toHaveBeenCalledWith('Failed to sync token to cookie');
  });
});

describe('authFetch', () => {
  beforeEach(() => {
    clearUserManager();
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('adds Bearer header with access token', async () => {
    vi.stubGlobal('window', { localStorage: {} });
    const mockUser = createMockUser();
    const mockManager = createMockUserManager({
      getUser: vi.fn().mockResolvedValue(mockUser),
    });
    vi.mocked(getStoredOidcConfig).mockReturnValue(mockConfig);
    vi.mocked(createUserManager).mockReturnValue(mockManager as any);

    vi.mocked(fetch).mockResolvedValue({ status: 200, ok: true } as any);

    await authFetch('/api/test');

    expect(fetch).toHaveBeenCalledWith(
      '/api/test',
      expect.objectContaining({
        headers: expect.any(Headers),
      })
    );
    const headers = vi.mocked(fetch).mock.calls[0][1]?.headers as Headers;
    expect(headers.get('Authorization')).toBe('Bearer access-token-xyz');
  });

  it('retries on 401 with silent renew', async () => {
    vi.stubGlobal('window', { localStorage: {} });
    const mockUser = createMockUser();
    const renewedUser = createMockUser({ access_token: 'renewed-token' });
    const mockManager = createMockUserManager({
      getUser: vi.fn().mockResolvedValue(mockUser),
      signinSilent: vi.fn().mockResolvedValue(renewedUser),
    });
    vi.mocked(getStoredOidcConfig).mockReturnValue(mockConfig);
    vi.mocked(createUserManager).mockReturnValue(mockManager as any);

    vi.mocked(fetch)
      .mockResolvedValueOnce({ status: 401, ok: false } as any)
      .mockResolvedValueOnce({ status: 200, ok: true } as any) // syncTokenToCookie call
      .mockResolvedValueOnce({ status: 200, ok: true } as any); // retry call

    await authFetch('/api/test');

    expect(fetch).toHaveBeenCalledTimes(3);
    expect(mockManager.signinSilent).toHaveBeenCalled();
    const retryCallHeaders = vi.mocked(fetch).mock.calls[2][1]?.headers as Headers;
    expect(retryCallHeaders.get('Authorization')).toBe('Bearer renewed-token');
  });

  it('returns original 401 when silent renew fails', async () => {
    vi.stubGlobal('window', { localStorage: {} });
    const mockUser = createMockUser();
    const mockManager = createMockUserManager({
      getUser: vi.fn().mockResolvedValue(mockUser),
      signinSilent: vi.fn().mockRejectedValue(new Error('Renew failed')),
    });
    vi.mocked(getStoredOidcConfig).mockReturnValue(mockConfig);
    vi.mocked(createUserManager).mockReturnValue(mockManager as any);

    const response401 = { status: 401, ok: false };
    vi.mocked(fetch).mockResolvedValue(response401 as any);

    const result = await authFetch('/api/test');

    expect(result).toBe(response401);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('does not retry on non-401 errors', async () => {
    vi.stubGlobal('window', { localStorage: {} });
    const mockUser = createMockUser();
    const mockManager = createMockUserManager({
      getUser: vi.fn().mockResolvedValue(mockUser),
    });
    vi.mocked(getStoredOidcConfig).mockReturnValue(mockConfig);
    vi.mocked(createUserManager).mockReturnValue(mockManager as any);

    vi.mocked(fetch).mockResolvedValue({ status: 403, ok: false } as any);

    await authFetch('/api/test');

    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe('createAuthFetcher', () => {
  beforeEach(() => {
    clearUserManager();
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns fetcher function that throws on non-ok', async () => {
    vi.stubGlobal('window', { localStorage: {} });
    const mockUser = createMockUser();
    const mockManager = createMockUserManager({
      getUser: vi.fn().mockResolvedValue(mockUser),
    });
    vi.mocked(getStoredOidcConfig).mockReturnValue(mockConfig);
    vi.mocked(createUserManager).mockReturnValue(mockManager as any);

    vi.mocked(fetch).mockResolvedValue({ status: 404, ok: false } as any);

    const fetcher = createAuthFetcher();

    await expect(fetcher('/api/test')).rejects.toThrow('Fetch failed');
  });

  it('returns JSON on successful fetch', async () => {
    vi.stubGlobal('window', { localStorage: {} });
    const mockUser = createMockUser();
    const mockManager = createMockUserManager({
      getUser: vi.fn().mockResolvedValue(mockUser),
    });
    vi.mocked(getStoredOidcConfig).mockReturnValue(mockConfig);
    vi.mocked(createUserManager).mockReturnValue(mockManager as any);

    const mockData = { success: true, data: 'test' };
    vi.mocked(fetch).mockResolvedValue({
      status: 200,
      ok: true,
      json: async () => mockData,
    } as any);

    const fetcher = createAuthFetcher();
    const result = await fetcher('/api/test');

    expect(result).toEqual(mockData);
  });
});

describe('login', () => {
  beforeEach(() => {
    clearUserManager();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('calls manager.signinRedirect', async () => {
    vi.stubGlobal('window', { localStorage: {} });
    const mockManager = createMockUserManager();
    vi.mocked(getStoredOidcConfig).mockReturnValue(mockConfig);
    vi.mocked(createUserManager).mockReturnValue(mockManager as any);

    await login();

    expect(mockManager.signinRedirect).toHaveBeenCalled();
  });

  it('does nothing when no manager exists', async () => {
    // Should not throw
    await login();
  });
});

describe('logout', () => {
  beforeEach(() => {
    clearUserManager();
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('calls /api/auth/logout', async () => {
    vi.mocked(fetch).mockResolvedValue({ ok: true } as any);

    await logout();

    expect(fetch).toHaveBeenCalledWith('/api/auth/logout', { method: 'POST' });
  });

  it('calls signoutRedirect when active user exists', async () => {
    vi.stubGlobal('window', { localStorage: {} });
    const mockUser = createMockUser();
    const mockManager = createMockUserManager({
      getUser: vi.fn().mockResolvedValue(mockUser),
    });
    vi.mocked(getStoredOidcConfig).mockReturnValue(mockConfig);
    vi.mocked(createUserManager).mockReturnValue(mockManager as any);
    vi.mocked(fetch).mockResolvedValue({ ok: true } as any);

    await logout();

    expect(mockManager.signoutRedirect).toHaveBeenCalled();
    expect(clearOidcConfig).not.toHaveBeenCalled(); // signoutRedirect navigates away
  });

  it('calls removeUser and clears state when no active user', async () => {
    vi.stubGlobal('window', { localStorage: {} });
    const mockManager = createMockUserManager({
      getUser: vi.fn().mockResolvedValue(null),
    });
    vi.mocked(getStoredOidcConfig).mockReturnValue(mockConfig);
    vi.mocked(createUserManager).mockReturnValue(mockManager as any);
    vi.mocked(fetch).mockResolvedValue({ ok: true } as any);

    await logout();

    expect(mockManager.removeUser).toHaveBeenCalled();
    expect(clearOidcConfig).toHaveBeenCalled();
  });

  it('cleans up locally when signoutRedirect fails', async () => {
    vi.stubGlobal('window', { localStorage: {} });
    const mockUser = createMockUser();
    const mockManager = createMockUserManager({
      getUser: vi.fn().mockResolvedValue(mockUser),
      signoutRedirect: vi.fn().mockRejectedValue(new Error('Redirect failed')),
    });
    vi.mocked(getStoredOidcConfig).mockReturnValue(mockConfig);
    vi.mocked(createUserManager).mockReturnValue(mockManager as any);
    vi.mocked(fetch).mockResolvedValue({ ok: true } as any);

    await logout();

    expect(mockManager.removeUser).toHaveBeenCalled();
    expect(clearOidcConfig).toHaveBeenCalled();
  });

  it('continues logout even if /api/auth/logout fails', async () => {
    vi.stubGlobal('window', { localStorage: {} });
    const mockManager = createMockUserManager({
      getUser: vi.fn().mockResolvedValue(null),
    });
    vi.mocked(getStoredOidcConfig).mockReturnValue(mockConfig);
    vi.mocked(createUserManager).mockReturnValue(mockManager as any);
    vi.mocked(fetch).mockRejectedValue(new Error('API error'));

    await logout();

    expect(mockManager.removeUser).toHaveBeenCalled();
    expect(clearOidcConfig).toHaveBeenCalled();
  });

  it('ignores removeUser errors', async () => {
    vi.stubGlobal('window', { localStorage: {} });
    const mockManager = createMockUserManager({
      getUser: vi.fn().mockResolvedValue(null),
      removeUser: vi.fn().mockRejectedValue(new Error('Remove failed')),
    });
    vi.mocked(getStoredOidcConfig).mockReturnValue(mockConfig);
    vi.mocked(createUserManager).mockReturnValue(mockManager as any);
    vi.mocked(fetch).mockResolvedValue({ ok: true } as any);

    // Should not throw
    await logout();

    expect(clearOidcConfig).toHaveBeenCalled();
  });
});
