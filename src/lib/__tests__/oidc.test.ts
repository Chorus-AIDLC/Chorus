import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { UserManager, WebStorageStateStore } from 'oidc-client-ts';

// Mock oidc-client-ts
vi.mock('oidc-client-ts', () => ({
  UserManager: vi.fn(),
  WebStorageStateStore: vi.fn(),
}));

import {
  createOidcSettings,
  createUserManager,
  storeOidcConfig,
  getStoredOidcConfig,
  clearOidcConfig,
  extractUserInfo,
  getOidcDiscoveryDocument,
  type OidcConfig,
} from '../oidc';

describe('createOidcSettings', () => {
  const mockConfig: OidcConfig = {
    issuer: 'https://auth.example.com',
    clientId: 'test-client-id',
    companyUuid: 'company-123',
    companyName: 'Test Company',
  };

  beforeEach(() => {
    vi.stubGlobal('window', {
      location: { origin: 'http://localhost:3000' },
      localStorage: {
        getItem: vi.fn(),
        setItem: vi.fn(),
        removeItem: vi.fn(),
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns correct UserManagerSettings with all required fields', () => {
    const settings = createOidcSettings(mockConfig);

    expect(settings.authority).toBe('https://auth.example.com');
    expect(settings.client_id).toBe('test-client-id');
    expect(settings.redirect_uri).toBe('http://localhost:3000/login/callback');
    expect(settings.post_logout_redirect_uri).toBe('http://localhost:3000/login');
    expect(settings.response_type).toBe('code');
    expect(settings.scope).toBe('openid profile email');
    expect(settings.automaticSilentRenew).toBe(true);
    expect(settings.silent_redirect_uri).toBe('http://localhost:3000/login/silent-refresh');
    expect(settings.accessTokenExpiringNotificationTimeInSeconds).toBe(60);
  });

  it('includes extra query params with company UUID', () => {
    const settings = createOidcSettings(mockConfig);

    expect(settings.extraQueryParams).toEqual({
      company: 'company-123',
    });
  });

  it('creates WebStorageStateStore when window is defined', () => {
    const mockStore = { mock: 'store' };
    vi.mocked(WebStorageStateStore).mockImplementation(class {
      constructor() {
        return mockStore as any;
      }
    } as any);

    const settings = createOidcSettings(mockConfig);

    expect(WebStorageStateStore).toHaveBeenCalledWith({
      store: window.localStorage,
    });
    expect(settings.userStore).toBe(mockStore);
  });

  it('uses NEXTAUTH_URL env when window is undefined', () => {
    vi.unstubAllGlobals();
    process.env.NEXTAUTH_URL = 'https://app.example.com';

    const settings = createOidcSettings(mockConfig);

    expect(settings.redirect_uri).toBe('https://app.example.com/login/callback');
    expect(settings.post_logout_redirect_uri).toBe('https://app.example.com/login');

    delete process.env.NEXTAUTH_URL;
  });

  it('defaults to localhost when window undefined and no NEXTAUTH_URL', () => {
    vi.unstubAllGlobals();

    const settings = createOidcSettings(mockConfig);

    expect(settings.redirect_uri).toBe('http://localhost:3000/login/callback');
  });

  it('sets userStore to undefined when window is undefined', () => {
    vi.unstubAllGlobals();

    const settings = createOidcSettings(mockConfig);

    expect(settings.userStore).toBeUndefined();
  });
});

describe('createUserManager', () => {
  const mockConfig: OidcConfig = {
    issuer: 'https://auth.example.com',
    clientId: 'test-client-id',
    companyUuid: 'company-123',
    companyName: 'Test Company',
  };

  beforeEach(() => {
    vi.stubGlobal('window', {
      location: { origin: 'http://localhost:3000' },
      localStorage: {
        getItem: vi.fn(),
        setItem: vi.fn(),
        removeItem: vi.fn(),
      },
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it('returns UserManager instance', () => {
    const mockManager = { mock: 'manager' };
    vi.mocked(UserManager).mockImplementation(class {
      constructor() {
        return mockManager as any;
      }
    } as any);

    const manager = createUserManager(mockConfig);

    expect(manager).toBe(mockManager);
  });

  it('passes correct settings to UserManager constructor', () => {
    vi.mocked(UserManager).mockImplementation(class {
      constructor() {
        return {} as any;
      }
    } as any);

    createUserManager(mockConfig);

    expect(UserManager).toHaveBeenCalledWith(
      expect.objectContaining({
        authority: 'https://auth.example.com',
        client_id: 'test-client-id',
        redirect_uri: 'http://localhost:3000/login/callback',
      })
    );
  });
});

describe('storeOidcConfig', () => {
  const mockConfig: OidcConfig = {
    issuer: 'https://auth.example.com',
    clientId: 'test-client-id',
    companyUuid: 'company-123',
    companyName: 'Test Company',
  };

  beforeEach(() => {
    const mockLocalStorage = {
      getItem: vi.fn(),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    };
    vi.stubGlobal('window', {
      localStorage: mockLocalStorage,
    });
    vi.stubGlobal('localStorage', mockLocalStorage);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('stores config in localStorage as JSON', () => {
    storeOidcConfig(mockConfig);

    expect(localStorage.setItem).toHaveBeenCalledWith(
      'oidc_config',
      JSON.stringify(mockConfig)
    );
  });

  it('does nothing when window is undefined', () => {
    vi.unstubAllGlobals();

    // Should not throw
    storeOidcConfig(mockConfig);
  });
});

describe('getStoredOidcConfig', () => {
  const mockConfig: OidcConfig = {
    issuer: 'https://auth.example.com',
    clientId: 'test-client-id',
    companyUuid: 'company-123',
    companyName: 'Test Company',
  };

  beforeEach(() => {
    const mockLocalStorage = {
      getItem: vi.fn(),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    };
    vi.stubGlobal('window', {
      localStorage: mockLocalStorage,
    });
    vi.stubGlobal('localStorage', mockLocalStorage);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns null when window is undefined', () => {
    vi.unstubAllGlobals();

    const result = getStoredOidcConfig();

    expect(result).toBeNull();
  });

  it('returns parsed config when valid JSON exists', () => {
    vi.mocked(localStorage.getItem).mockReturnValue(JSON.stringify(mockConfig));

    const result = getStoredOidcConfig();

    expect(result).toEqual(mockConfig);
    expect(localStorage.getItem).toHaveBeenCalledWith('oidc_config');
  });

  it('returns null when localStorage is empty', () => {
    vi.mocked(localStorage.getItem).mockReturnValue(null);

    const result = getStoredOidcConfig();

    expect(result).toBeNull();
  });

  it('returns null on invalid JSON', () => {
    vi.mocked(localStorage.getItem).mockReturnValue('{ invalid json }');

    const result = getStoredOidcConfig();

    expect(result).toBeNull();
  });
});

describe('clearOidcConfig', () => {
  beforeEach(() => {
    const mockLocalStorage = {
      getItem: vi.fn(),
      setItem: vi.fn(),
      removeItem: vi.fn(),
    };
    vi.stubGlobal('window', {
      localStorage: mockLocalStorage,
    });
    vi.stubGlobal('localStorage', mockLocalStorage);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('removes oidc_config from localStorage', () => {
    clearOidcConfig();

    expect(localStorage.removeItem).toHaveBeenCalledWith('oidc_config');
  });

  it('does nothing when window is undefined', () => {
    vi.unstubAllGlobals();

    // Should not throw
    clearOidcConfig();
  });
});

describe('extractUserInfo', () => {
  it('extracts all user properties correctly', () => {
    const mockUser = {
      profile: {
        sub: 'user-sub-123',
        email: 'user@example.com',
        name: 'Test User',
        picture: 'https://example.com/pic.jpg',
      },
      access_token: 'access-token-xyz',
      refresh_token: 'refresh-token-abc',
      expires_at: 1234567890,
      id_token: 'id-token-def',
    } as any;

    const result = extractUserInfo(mockUser);

    expect(result).toEqual({
      sub: 'user-sub-123',
      email: 'user@example.com',
      name: 'Test User',
      picture: 'https://example.com/pic.jpg',
      accessToken: 'access-token-xyz',
      refreshToken: 'refresh-token-abc',
      expiresAt: 1234567890,
      idToken: 'id-token-def',
    });
  });

  it('handles missing optional fields', () => {
    const mockUser = {
      profile: {
        sub: 'user-sub-456',
      },
      access_token: 'token',
    } as any;

    const result = extractUserInfo(mockUser);

    expect(result).toEqual({
      sub: 'user-sub-456',
      email: undefined,
      name: undefined,
      picture: undefined,
      accessToken: 'token',
      refreshToken: undefined,
      expiresAt: undefined,
      idToken: undefined,
    });
  });
});

describe('getOidcDiscoveryDocument', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('fetches well-known URL and returns JSON', async () => {
    const mockDocument = {
      issuer: 'https://auth.example.com',
      authorization_endpoint: 'https://auth.example.com/oauth2/authorize',
      token_endpoint: 'https://auth.example.com/oauth2/token',
    };

    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => mockDocument,
    } as any);

    const result = await getOidcDiscoveryDocument('https://auth.example.com');

    expect(fetch).toHaveBeenCalledWith(
      'https://auth.example.com/.well-known/openid-configuration'
    );
    expect(result).toEqual(mockDocument);
  });

  it('removes trailing slash from issuer before constructing URL', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({}),
    } as any);

    await getOidcDiscoveryDocument('https://auth.example.com/');

    expect(fetch).toHaveBeenCalledWith(
      'https://auth.example.com/.well-known/openid-configuration'
    );
  });

  it('throws error when response is not ok', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: false,
      statusText: 'Not Found',
    } as any);

    await expect(getOidcDiscoveryDocument('https://auth.example.com')).rejects.toThrow(
      'Failed to fetch OIDC discovery: Not Found'
    );
  });

  it('throws error when fetch fails', async () => {
    vi.mocked(fetch).mockRejectedValue(new Error('Network error'));

    await expect(getOidcDiscoveryDocument('https://auth.example.com')).rejects.toThrow(
      'Network error'
    );
  });
});
