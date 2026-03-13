import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock jose before importing
vi.mock('jose', () => ({
  createRemoteJWKSet: vi.fn(),
  jwtVerify: vi.fn(),
}));

// Mock prisma before importing
vi.mock('@/lib/prisma', () => ({
  prisma: {
    company: {
      findFirst: vi.fn(),
    },
    user: {
      findFirst: vi.fn(),
    },
  },
}));
vi.mock('@/generated/prisma/client', () => ({ PrismaClient: vi.fn() }));

import { createRemoteJWKSet, jwtVerify } from 'jose';
import { prisma } from '@/lib/prisma';
import { verifyOidcAccessToken, isOidcToken } from '../oidc-auth';

// Helper to create fake JWT tokens
function createFakeJwt(header: object, payload: object): string {
  const headerB64 = Buffer.from(JSON.stringify(header)).toString('base64url');
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = 'fake-signature';
  return `${headerB64}.${payloadB64}.${signature}`;
}

describe('verifyOidcAccessToken', () => {
  const mockIssuer = 'https://cognito.us-east-1.amazonaws.com/us-east-1_EXAMPLE';
  const mockCompany = {
    uuid: 'company-123',
    name: 'Test Company',
    oidcEnabled: true,
    oidcIssuer: mockIssuer,
  };
  const mockUser = {
    uuid: 'user-456',
    email: 'user@example.com',
    name: 'Test User',
    companyUuid: 'company-123',
    oidcSub: 'user-sub-789',
  };

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset console.error mock to avoid noise in test output
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  it('returns UserAuthContext for valid access token', async () => {
    const token = createFakeJwt(
      { alg: 'RS256', kid: 'key-id' },
      { iss: mockIssuer, sub: 'user-sub-789', token_use: 'access', email: 'user@example.com' }
    );

    const mockJwks = vi.fn();
    vi.mocked(createRemoteJWKSet).mockReturnValue(mockJwks as any);
    vi.mocked(jwtVerify).mockResolvedValue({
      payload: {
        iss: mockIssuer,
        sub: 'user-sub-789',
        token_use: 'access',
        email: 'user@example.com',
      },
      protectedHeader: { alg: 'RS256' },
    } as any);

    vi.mocked(prisma.company.findFirst).mockResolvedValue(mockCompany as any);
    vi.mocked(prisma.user.findFirst).mockResolvedValue(mockUser as any);

    const result = await verifyOidcAccessToken(token);

    expect(result).toEqual({
      type: 'user',
      companyUuid: 'company-123',
      actorUuid: 'user-456',
      email: 'user@example.com',
      name: 'Test User',
    });
  });

  it('returns null for invalid JWT structure (not 3 parts)', async () => {
    const result = await verifyOidcAccessToken('invalid.token');

    expect(result).toBeNull();
    expect(jwtVerify).not.toHaveBeenCalled();
  });

  it('returns null when issuer is missing in payload', async () => {
    const token = createFakeJwt(
      { alg: 'RS256' },
      { sub: 'user-sub', token_use: 'access' } // No iss
    );

    const result = await verifyOidcAccessToken(token);

    expect(result).toBeNull();
    expect(jwtVerify).not.toHaveBeenCalled();
  });

  it('returns null when token_use is not "access"', async () => {
    const token = createFakeJwt(
      { alg: 'RS256' },
      { iss: mockIssuer, sub: 'user-sub-789', token_use: 'id' }
    );

    vi.mocked(jwtVerify).mockResolvedValue({
      payload: {
        iss: mockIssuer,
        sub: 'user-sub-789',
        token_use: 'id',
      },
      protectedHeader: { alg: 'RS256' },
    } as any);

    const result = await verifyOidcAccessToken(token);

    expect(result).toBeNull();
    expect(prisma.company.findFirst).not.toHaveBeenCalled();
  });

  it('returns null when company is not found', async () => {
    const token = createFakeJwt(
      { alg: 'RS256' },
      { iss: mockIssuer, sub: 'user-sub-789', token_use: 'access' }
    );

    vi.mocked(jwtVerify).mockResolvedValue({
      payload: {
        iss: mockIssuer,
        sub: 'user-sub-789',
        token_use: 'access',
      },
      protectedHeader: { alg: 'RS256' },
    } as any);

    vi.mocked(prisma.company.findFirst).mockResolvedValue(null);

    const result = await verifyOidcAccessToken(token);

    expect(result).toBeNull();
    expect(prisma.user.findFirst).not.toHaveBeenCalled();
  });

  it('returns null when user is not found', async () => {
    const token = createFakeJwt(
      { alg: 'RS256' },
      { iss: mockIssuer, sub: 'user-sub-789', token_use: 'access' }
    );

    vi.mocked(jwtVerify).mockResolvedValue({
      payload: {
        iss: mockIssuer,
        sub: 'user-sub-789',
        token_use: 'access',
      },
      protectedHeader: { alg: 'RS256' },
    } as any);

    vi.mocked(prisma.company.findFirst).mockResolvedValue(mockCompany as any);
    vi.mocked(prisma.user.findFirst).mockResolvedValue(null);

    const result = await verifyOidcAccessToken(token);

    expect(result).toBeNull();
  });

  it('returns null when jwtVerify throws', async () => {
    const token = createFakeJwt(
      { alg: 'RS256' },
      { iss: mockIssuer, sub: 'user-sub-789', token_use: 'access' }
    );

    vi.mocked(jwtVerify).mockRejectedValue(new Error('Signature verification failed'));

    const result = await verifyOidcAccessToken(token);

    expect(result).toBeNull();
    expect(console.error).toHaveBeenCalledWith(
      'OIDC token verification failed:',
      expect.any(Error)
    );
  });

  it('creates JWKS with correct issuer URL', async () => {
    // Use a unique issuer to avoid JWKS cache collision
    const uniqueIssuer = 'https://cognito.us-west-2.amazonaws.com/us-west-2_UNIQUE';
    const token = createFakeJwt(
      { alg: 'RS256' },
      { iss: uniqueIssuer, sub: 'user-sub-789', token_use: 'access' }
    );

    const mockJwks = vi.fn();
    vi.mocked(createRemoteJWKSet).mockReturnValue(mockJwks as any);
    vi.mocked(jwtVerify).mockResolvedValue({
      payload: {
        iss: uniqueIssuer,
        sub: 'user-sub-789',
        token_use: 'access',
      },
      protectedHeader: { alg: 'RS256' },
    } as any);

    vi.mocked(prisma.company.findFirst).mockResolvedValue({
      ...mockCompany,
      oidcIssuer: uniqueIssuer,
    } as any);
    vi.mocked(prisma.user.findFirst).mockResolvedValue(mockUser as any);

    await verifyOidcAccessToken(token);

    expect(createRemoteJWKSet).toHaveBeenCalled();
    const jwksUrl = vi.mocked(createRemoteJWKSet).mock.calls[0][0];
    expect(jwksUrl.toString()).toBe(`${uniqueIssuer}/.well-known/jwks.json`);
  });

  it('uses user email from payload when user email is null', async () => {
    const token = createFakeJwt(
      { alg: 'RS256' },
      { iss: mockIssuer, sub: 'user-sub-789', token_use: 'access', email: 'payload@example.com' }
    );

    vi.mocked(jwtVerify).mockResolvedValue({
      payload: {
        iss: mockIssuer,
        sub: 'user-sub-789',
        token_use: 'access',
        email: 'payload@example.com',
      },
      protectedHeader: { alg: 'RS256' },
    } as any);

    vi.mocked(prisma.company.findFirst).mockResolvedValue(mockCompany as any);
    vi.mocked(prisma.user.findFirst).mockResolvedValue({
      ...mockUser,
      email: null,
    } as any);

    const result = await verifyOidcAccessToken(token);

    expect(result?.email).toBe('payload@example.com');
  });

  it('accepts token without token_use field', async () => {
    const token = createFakeJwt(
      { alg: 'RS256' },
      { iss: mockIssuer, sub: 'user-sub-789' } // No token_use
    );

    vi.mocked(jwtVerify).mockResolvedValue({
      payload: {
        iss: mockIssuer,
        sub: 'user-sub-789',
      },
      protectedHeader: { alg: 'RS256' },
    } as any);

    vi.mocked(prisma.company.findFirst).mockResolvedValue(mockCompany as any);
    vi.mocked(prisma.user.findFirst).mockResolvedValue(mockUser as any);

    const result = await verifyOidcAccessToken(token);

    expect(result).not.toBeNull();
    expect(result?.actorUuid).toBe('user-456');
  });
});

describe('isOidcToken', () => {
  it('returns false for API key with cho_ prefix', () => {
    expect(isOidcToken('cho_abc123xyz')).toBe(false);
  });

  it('returns true for valid JWT with RS256 algorithm', () => {
    const token = createFakeJwt({ alg: 'RS256', typ: 'JWT' }, { sub: 'user-123' });
    expect(isOidcToken(token)).toBe(true);
  });

  it('returns true for valid JWT with ES256 algorithm', () => {
    const token = createFakeJwt({ alg: 'ES256', typ: 'JWT' }, { sub: 'user-123' });
    expect(isOidcToken(token)).toBe(true);
  });

  it('returns true for valid JWT with RS384 algorithm', () => {
    const token = createFakeJwt({ alg: 'RS384', typ: 'JWT' }, { sub: 'user-123' });
    expect(isOidcToken(token)).toBe(true);
  });

  it('returns true for valid JWT with ES384 algorithm', () => {
    const token = createFakeJwt({ alg: 'ES384', typ: 'JWT' }, { sub: 'user-123' });
    expect(isOidcToken(token)).toBe(true);
  });

  it('returns false for JWT with HS256 algorithm', () => {
    const token = createFakeJwt({ alg: 'HS256', typ: 'JWT' }, { sub: 'user-123' });
    expect(isOidcToken(token)).toBe(false);
  });

  it('returns false for non-JWT string', () => {
    expect(isOidcToken('not-a-jwt-token')).toBe(false);
  });

  it('returns false for malformed JWT (only 2 parts)', () => {
    expect(isOidcToken('header.payload')).toBe(false);
  });

  it('returns false for malformed JWT (4 parts)', () => {
    expect(isOidcToken('part1.part2.part3.part4')).toBe(false);
  });

  it('returns false for malformed base64 in header', () => {
    expect(isOidcToken('not-base64!!!.payload.signature')).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isOidcToken('')).toBe(false);
  });
});
