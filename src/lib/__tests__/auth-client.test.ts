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
  resyncRefreshTokenFromStore,
  authFetch,
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

describe('resyncRefreshTokenFromStore', () => {
  beforeEach(() => {
    clearUserManager();
    vi.clearAllMocks();
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('posts the stored expired-AT + RT pair in recoverSession mode', async () => {
    vi.stubGlobal('window', { localStorage: {} });
    const mockManager = createMockUserManager({
      getUser: vi.fn().mockResolvedValue(createMockUser({ expired: true })),
    });
    vi.mocked(createUserManager).mockReturnValue(mockManager as any);
    vi.mocked(getStoredOidcConfig).mockReturnValue(mockConfig);
    vi.mocked(fetch).mockResolvedValue({ ok: true } as any);

    const result = await resyncRefreshTokenFromStore();

    expect(fetch).toHaveBeenCalledWith('/api/auth/sync-token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        accessToken: 'access-token-xyz',
        refreshToken: 'refresh-token-abc',
      }),
    });
    expect(result).toBe(true);
    clearUserManager();
  });

  it('is a no-op (false, no fetch) when the stored user has no refresh token', async () => {
    vi.stubGlobal('window', { localStorage: {} });
    const mockManager = createMockUserManager({
      getUser: vi.fn().mockResolvedValue(createMockUser({ refresh_token: undefined, expired: true })),
    });
    vi.mocked(createUserManager).mockReturnValue(mockManager as any);
    vi.mocked(getStoredOidcConfig).mockReturnValue(mockConfig);

    const result = await resyncRefreshTokenFromStore();

    expect(fetch).not.toHaveBeenCalled();
    expect(result).toBe(false);
    clearUserManager();
  });

  it('is a no-op (false, no fetch) when there is no stored user at all', async () => {
    vi.stubGlobal('window', { localStorage: {} });
    const mockManager = createMockUserManager({
      getUser: vi.fn().mockResolvedValue(null),
    });
    vi.mocked(createUserManager).mockReturnValue(mockManager as any);
    vi.mocked(getStoredOidcConfig).mockReturnValue(mockConfig);

    const result = await resyncRefreshTokenFromStore();

    expect(fetch).not.toHaveBeenCalled();
    expect(result).toBe(false);
    clearUserManager();
  });

  it('returns false when the server declines and on network error', async () => {
    vi.stubGlobal('window', { localStorage: {} });
    const mockManager = createMockUserManager({
      getUser: vi.fn().mockResolvedValue(createMockUser({ expired: true })),
    });
    vi.mocked(createUserManager).mockReturnValue(mockManager as any);
    vi.mocked(getStoredOidcConfig).mockReturnValue(mockConfig);

    vi.mocked(fetch).mockResolvedValue({ ok: false } as any);
    expect(await resyncRefreshTokenFromStore()).toBe(false);

    vi.mocked(fetch).mockRejectedValue(new Error('network'));
    expect(await resyncRefreshTokenFromStore()).toBe(false);
    clearUserManager();
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

  it('is cookie-based: sends same-origin credentials and NO Authorization header', async () => {
    vi.stubGlobal('window', { localStorage: {} });
    const mockManager = createMockUserManager({
      getUser: vi.fn().mockResolvedValue(createMockUser()),
    });
    vi.mocked(getStoredOidcConfig).mockReturnValue(mockConfig);
    vi.mocked(createUserManager).mockReturnValue(mockManager as any);
    vi.mocked(fetch).mockResolvedValue({ status: 200, ok: true } as any);

    await authFetch('/api/test');

    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, opts] = vi.mocked(fetch).mock.calls[0];
    expect(url).toBe('/api/test');
    expect((opts as RequestInit).credentials).toBe('same-origin');
    const headers = new Headers((opts as RequestInit).headers);
    expect(headers.get('Authorization')).toBeNull();
    // The localStorage token is never read for requests.
    expect(mockManager.getUser).not.toHaveBeenCalled();
  });

  it('surfaces a 401 without any retry or silent renew (verdict logic owns recovery)', async () => {
    vi.stubGlobal('window', { localStorage: {} });
    const mockManager = createMockUserManager({
      getUser: vi.fn().mockResolvedValue(createMockUser()),
      signinSilent: vi.fn(),
    });
    vi.mocked(getStoredOidcConfig).mockReturnValue(mockConfig);
    vi.mocked(createUserManager).mockReturnValue(mockManager as any);
    const response401 = { status: 401, ok: false };
    vi.mocked(fetch).mockResolvedValue(response401 as any);

    const result = await authFetch('/api/test');

    expect(result).toBe(response401);
    expect(mockManager.signinSilent).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('passes through request options', async () => {
    vi.mocked(fetch).mockResolvedValue({ status: 200, ok: true } as any);

    await authFetch('/api/test', { method: 'POST', body: '{}' });

    const [, opts] = vi.mocked(fetch).mock.calls[0];
    expect((opts as RequestInit).method).toBe('POST');
    expect((opts as RequestInit).body).toBe('{}');
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

  it('does not call signoutRedirect — stays on local session clear only', async () => {
    vi.stubGlobal('window', { localStorage: {} });
    const mockUser = createMockUser();
    const mockManager = createMockUserManager({
      getUser: vi.fn().mockResolvedValue(mockUser),
    });
    vi.mocked(getStoredOidcConfig).mockReturnValue(mockConfig);
    vi.mocked(createUserManager).mockReturnValue(mockManager as any);
    vi.mocked(fetch).mockResolvedValue({ ok: true } as any);

    await logout();

    expect(mockManager.signoutRedirect).not.toHaveBeenCalled();
    expect(mockManager.removeUser).toHaveBeenCalled();
    expect(clearOidcConfig).toHaveBeenCalled();
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
