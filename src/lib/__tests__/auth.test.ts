import { describe, it, expect, vi, beforeEach } from 'vitest';
import { NextRequest, NextResponse } from 'next/server';

// Mock dependencies that auth.ts imports transitively
vi.mock('@/lib/prisma', () => ({ prisma: {} }));
vi.mock('@/generated/prisma/client', () => ({ PrismaClient: vi.fn() }));
vi.mock('@/lib/super-admin', () => ({ getSuperAdminFromRequest: vi.fn() }));
vi.mock('@/lib/user-session', () => ({ getUserSessionFromRequest: vi.fn() }));
vi.mock('@/lib/oidc-auth', () => ({ verifyOidcAccessToken: vi.fn(), isOidcToken: vi.fn() }));
vi.mock('@/lib/api-key', () => ({
  validateApiKey: vi.fn(),
  extractApiKey: vi.fn((h: string | null) => h?.startsWith('Bearer ') ? h.substring(7) : h),
}));

import {
  getAuthContext,
  isAgent,
  isUser,
  hasRole,
  isPmAgent,
  isDeveloperAgent,
  requireAuth,
  requireUser,
  requireAgentRole,
  isAssignee,
  isSuperAdmin,
  requireSuperAdmin,
} from '../auth';
import type { AgentAuthContext, UserAuthContext, AuthContext, SuperAdminAuthContext } from '@/types/auth';
import { validateApiKey } from '@/lib/api-key';
import { getSuperAdminFromRequest } from '@/lib/super-admin';
import { getUserSessionFromRequest } from '@/lib/user-session';
import { verifyOidcAccessToken, isOidcToken } from '@/lib/oidc-auth';

const userCtx: UserAuthContext = {
  type: 'user',
  companyUuid: 'comp-uuid',
  actorUuid: 'user-uuid',
  email: 'test@test.com',
  name: 'Test User',
};

const agentCtx: AgentAuthContext = {
  type: 'agent',
  companyUuid: 'comp-uuid',
  actorUuid: 'agent-uuid',
  roles: ['developer'],
  agentName: 'Dev Agent',
};

const pmAgentCtx: AgentAuthContext = {
  type: 'agent',
  companyUuid: 'comp-uuid',
  actorUuid: 'pm-uuid',
  roles: ['pm'],
  agentName: 'PM Agent',
};

const multiRoleCtx: AgentAuthContext = {
  type: 'agent',
  companyUuid: 'comp-uuid',
  actorUuid: 'multi-uuid',
  roles: ['pm', 'developer'],
  agentName: 'Multi Agent',
};

describe('isAgent', () => {
  it('returns true for agent context', () => {
    expect(isAgent(agentCtx)).toBe(true);
  });

  it('returns false for user context', () => {
    expect(isAgent(userCtx)).toBe(false);
  });
});

describe('isUser', () => {
  it('returns true for user context', () => {
    expect(isUser(userCtx)).toBe(true);
  });

  it('returns false for agent context', () => {
    expect(isUser(agentCtx)).toBe(false);
  });
});

describe('hasRole', () => {
  it('returns true when agent has the role', () => {
    expect(hasRole(agentCtx, 'developer')).toBe(true);
  });

  it('returns false when agent does not have the role', () => {
    expect(hasRole(agentCtx, 'pm')).toBe(false);
  });

  it('returns false for user context (not an agent)', () => {
    expect(hasRole(userCtx, 'developer')).toBe(false);
  });

  it('works with multiple roles', () => {
    expect(hasRole(multiRoleCtx, 'pm')).toBe(true);
    expect(hasRole(multiRoleCtx, 'developer')).toBe(true);
    expect(hasRole(multiRoleCtx, 'admin')).toBe(false);
  });
});

describe('isPmAgent', () => {
  it('returns true for pm agent', () => {
    expect(isPmAgent(pmAgentCtx)).toBe(true);
  });

  it('returns false for developer agent', () => {
    expect(isPmAgent(agentCtx)).toBe(false);
  });

  it('returns false for user context', () => {
    expect(isPmAgent(userCtx)).toBe(false);
  });
});

describe('isDeveloperAgent', () => {
  it('returns true for developer agent', () => {
    expect(isDeveloperAgent(agentCtx)).toBe(true);
  });

  it('returns false for pm agent', () => {
    expect(isDeveloperAgent(pmAgentCtx)).toBe(false);
  });

  it('returns false for user context', () => {
    expect(isDeveloperAgent(userCtx)).toBe(false);
  });
});

describe('getAuthContext', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function makeRequest(url: string, headers: Record<string, string> = {}, cookies: Record<string, string> = {}): NextRequest {
    const req = new NextRequest(new URL(url, 'http://localhost:3000'));
    Object.entries(headers).forEach(([key, value]) => {
      req.headers.set(key, value);
    });
    // Set cookies on the request
    Object.entries(cookies).forEach(([key, value]) => {
      req.cookies.set(key, value);
    });
    return req;
  }

  it('returns agent context when Bearer token is a valid API key', async () => {
    const mockAgent = {
      uuid: 'agent-uuid',
      companyUuid: 'company-uuid',
      name: 'Test Agent',
      roles: ['developer'],
      ownerUuid: 'owner-uuid',
    };

    vi.mocked(validateApiKey).mockResolvedValue({
      valid: true,
      agent: mockAgent,
    });

    const req = makeRequest('/api/test', { authorization: 'Bearer cho_testkey123' });
    const result = await getAuthContext(req);

    expect(result).toEqual({
      type: 'agent',
      companyUuid: 'company-uuid',
      actorUuid: 'agent-uuid',
      roles: ['developer'],
      ownerUuid: 'owner-uuid',
      agentName: 'Test Agent',
    });
    expect(validateApiKey).toHaveBeenCalledWith('cho_testkey123');
  });

  it('returns user context when Bearer token is a valid OIDC token', async () => {
    const mockUserContext: UserAuthContext = {
      type: 'user',
      companyUuid: 'company-uuid',
      actorUuid: 'user-uuid',
      email: 'user@test.com',
      name: 'Test User',
    };

    vi.mocked(isOidcToken).mockReturnValue(true);
    vi.mocked(verifyOidcAccessToken).mockResolvedValue(mockUserContext);

    const req = makeRequest('/api/test', { authorization: 'Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...' });
    const result = await getAuthContext(req);

    expect(result).toEqual(mockUserContext);
    expect(verifyOidcAccessToken).toHaveBeenCalled();
  });

  it('falls back to user session when Bearer token is invalid', async () => {
    const mockUserContext: UserAuthContext = {
      type: 'user',
      companyUuid: 'company-uuid',
      actorUuid: 'user-uuid',
      email: 'user@test.com',
    };

    vi.mocked(isOidcToken).mockReturnValue(false);
    vi.mocked(getUserSessionFromRequest).mockResolvedValue(mockUserContext);

    const req = makeRequest('/api/test', { authorization: 'Bearer invalid_token' });
    const result = await getAuthContext(req);

    expect(result).toEqual(mockUserContext);
  });

  it('returns user context from session cookie when no Authorization header', async () => {
    const mockUserContext: UserAuthContext = {
      type: 'user',
      companyUuid: 'company-uuid',
      actorUuid: 'user-uuid',
    };

    vi.mocked(getUserSessionFromRequest).mockResolvedValue(mockUserContext);

    const req = makeRequest('/api/test');
    const result = await getAuthContext(req);

    expect(result).toEqual(mockUserContext);
    expect(getUserSessionFromRequest).toHaveBeenCalled();
  });

  it('returns user context from OIDC cookie when no Authorization header', async () => {
    const mockUserContext: UserAuthContext = {
      type: 'user',
      companyUuid: 'company-uuid',
      actorUuid: 'user-uuid',
    };

    vi.mocked(getUserSessionFromRequest).mockResolvedValue(null);
    vi.mocked(isOidcToken).mockReturnValue(true);
    vi.mocked(verifyOidcAccessToken).mockResolvedValue(mockUserContext);

    const req = makeRequest('/api/test', {}, { oidc_access_token: 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9...' });
    const result = await getAuthContext(req);

    expect(result).toEqual(mockUserContext);
    expect(verifyOidcAccessToken).toHaveBeenCalled();
  });

  it('returns null when all authentication methods fail', async () => {
    vi.mocked(getUserSessionFromRequest).mockResolvedValue(null);
    vi.mocked(isOidcToken).mockReturnValue(false);

    const req = makeRequest('/api/test');
    const result = await getAuthContext(req);

    expect(result).toBeNull();
  });

  it('returns null when API key validation fails', async () => {
    vi.mocked(validateApiKey).mockResolvedValue({ valid: false, error: 'Invalid key' });
    vi.mocked(getUserSessionFromRequest).mockResolvedValue(null);

    const req = makeRequest('/api/test', { authorization: 'Bearer cho_invalidkey' });
    const result = await getAuthContext(req);

    expect(result).toBeNull();
  });
});

describe('requireAuth', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls handler when authenticated', async () => {
    const mockAuth: UserAuthContext = {
      type: 'user',
      companyUuid: 'company-uuid',
      actorUuid: 'user-uuid',
    };

    vi.mocked(getUserSessionFromRequest).mockResolvedValue(mockAuth);

    const handler = vi.fn().mockResolvedValue(NextResponse.json({ success: true }));
    const wrappedHandler = requireAuth(handler);

    const req = new NextRequest(new URL('http://localhost:3000/api/test'));
    const context = { params: Promise.resolve({}) };

    await wrappedHandler(req, context);

    expect(handler).toHaveBeenCalledWith(req, context, mockAuth);
  });

  it('returns 401 when not authenticated', async () => {
    vi.mocked(getUserSessionFromRequest).mockResolvedValue(null);

    const handler = vi.fn();
    const wrappedHandler = requireAuth(handler);

    const req = new NextRequest(new URL('http://localhost:3000/api/test'));
    const context = { params: Promise.resolve({}) };

    const response = await wrappedHandler(req, context);

    expect(handler).not.toHaveBeenCalled();
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.success).toBe(false);
  });
});

describe('requireUser', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls handler when authenticated as user', async () => {
    const mockAuth: UserAuthContext = {
      type: 'user',
      companyUuid: 'company-uuid',
      actorUuid: 'user-uuid',
    };

    vi.mocked(getUserSessionFromRequest).mockResolvedValue(mockAuth);

    const handler = vi.fn().mockResolvedValue(NextResponse.json({ success: true }));
    const wrappedHandler = requireUser(handler);

    const req = new NextRequest(new URL('http://localhost:3000/api/test'));
    const context = { params: Promise.resolve({}) };

    await wrappedHandler(req, context);

    expect(handler).toHaveBeenCalledWith(req, context, mockAuth);
  });

  it('returns 403 when authenticated as agent', async () => {
    const mockAuth: AgentAuthContext = {
      type: 'agent',
      companyUuid: 'company-uuid',
      actorUuid: 'agent-uuid',
      roles: ['developer'],
      agentName: 'Test Agent',
    };

    vi.mocked(getUserSessionFromRequest).mockResolvedValue(mockAuth as unknown as UserAuthContext);

    const handler = vi.fn();
    const wrappedHandler = requireUser(handler);

    const req = new NextRequest(new URL('http://localhost:3000/api/test'));
    const context = { params: Promise.resolve({}) };

    const response = await wrappedHandler(req, context);

    expect(handler).not.toHaveBeenCalled();
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error.message).toContain('user authentication');
  });
});

describe('requireAgentRole', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls handler when agent has required role', async () => {
    const mockAuth: AgentAuthContext = {
      type: 'agent',
      companyUuid: 'company-uuid',
      actorUuid: 'agent-uuid',
      roles: ['developer'],
      agentName: 'Test Agent',
    };

    vi.mocked(getUserSessionFromRequest).mockResolvedValue(mockAuth as unknown as UserAuthContext);

    const handler = vi.fn().mockResolvedValue(NextResponse.json({ success: true }));
    const wrappedHandler = requireAgentRole('developer', handler);

    const req = new NextRequest(new URL('http://localhost:3000/api/test'));
    const context = { params: Promise.resolve({}) };

    await wrappedHandler(req, context);

    expect(handler).toHaveBeenCalledWith(req, context, mockAuth);
  });

  it('returns 403 when agent lacks required role', async () => {
    const mockAuth: AgentAuthContext = {
      type: 'agent',
      companyUuid: 'company-uuid',
      actorUuid: 'agent-uuid',
      roles: ['developer'],
      agentName: 'Test Agent',
    };

    vi.mocked(getUserSessionFromRequest).mockResolvedValue(mockAuth as unknown as UserAuthContext);

    const handler = vi.fn();
    const wrappedHandler = requireAgentRole('pm', handler);

    const req = new NextRequest(new URL('http://localhost:3000/api/test'));
    const context = { params: Promise.resolve({}) };

    const response = await wrappedHandler(req, context);

    expect(handler).not.toHaveBeenCalled();
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error.message).toContain('pm role');
  });

  it('returns 403 when authenticated as user', async () => {
    const mockAuth: UserAuthContext = {
      type: 'user',
      companyUuid: 'company-uuid',
      actorUuid: 'user-uuid',
    };

    vi.mocked(getUserSessionFromRequest).mockResolvedValue(mockAuth);

    const handler = vi.fn();
    const wrappedHandler = requireAgentRole('developer', handler);

    const req = new NextRequest(new URL('http://localhost:3000/api/test'));
    const context = { params: Promise.resolve({}) };

    const response = await wrappedHandler(req, context);

    expect(handler).not.toHaveBeenCalled();
    expect(response.status).toBe(403);
    const body = await response.json();
    expect(body.error.message).toContain('agent authentication');
  });
});

describe('isAssignee', () => {
  it('returns true when user is the assignee', () => {
    expect(isAssignee(userCtx, 'user', 'user-uuid')).toBe(true);
  });

  it('returns false when user is not the assignee', () => {
    expect(isAssignee(userCtx, 'user', 'other-uuid')).toBe(false);
  });

  it('returns true when agent is the assignee', () => {
    expect(isAssignee(agentCtx, 'agent', 'agent-uuid')).toBe(true);
  });

  it('returns false when agent is not the assignee', () => {
    expect(isAssignee(agentCtx, 'agent', 'other-uuid')).toBe(false);
  });

  it('returns true when agent owner matches user assignee', () => {
    const agentWithOwner: AgentAuthContext = {
      ...agentCtx,
      ownerUuid: 'owner-uuid',
    };
    expect(isAssignee(agentWithOwner, 'user', 'owner-uuid')).toBe(true);
  });

  it('returns false when agent has no owner', () => {
    expect(isAssignee(agentCtx, 'user', 'some-user-uuid')).toBe(false);
  });

  it('returns false when assigneeType is null', () => {
    expect(isAssignee(userCtx, null, 'user-uuid')).toBe(false);
  });

  it('returns false when assigneeUuid is null', () => {
    expect(isAssignee(userCtx, 'user', null)).toBe(false);
  });

  it('returns false when both assigneeType and assigneeUuid are null', () => {
    expect(isAssignee(userCtx, null, null)).toBe(false);
  });
});

describe('isSuperAdmin', () => {
  it('returns true for super admin context', () => {
    const superAdminCtx: SuperAdminAuthContext = {
      type: 'super_admin',
      email: 'admin@test.com',
    };
    expect(isSuperAdmin(superAdminCtx)).toBe(true);
  });

  it('returns false for user context', () => {
    expect(isSuperAdmin(userCtx)).toBe(false);
  });

  it('returns false for agent context', () => {
    expect(isSuperAdmin(agentCtx)).toBe(false);
  });
});

describe('requireSuperAdmin', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('calls handler when authenticated as super admin', async () => {
    const mockAuth: SuperAdminAuthContext = {
      type: 'super_admin',
      email: 'admin@test.com',
    };

    vi.mocked(getSuperAdminFromRequest).mockResolvedValue(mockAuth);

    const handler = vi.fn().mockResolvedValue(NextResponse.json({ success: true }));
    const wrappedHandler = requireSuperAdmin(handler);

    const req = new NextRequest(new URL('http://localhost:3000/api/test'));
    const context = { params: Promise.resolve({}) };

    await wrappedHandler(req, context);

    expect(handler).toHaveBeenCalledWith(req, context, mockAuth);
  });

  it('returns 401 when not authenticated as super admin', async () => {
    vi.mocked(getSuperAdminFromRequest).mockResolvedValue(null);

    const handler = vi.fn();
    const wrappedHandler = requireSuperAdmin(handler);

    const req = new NextRequest(new URL('http://localhost:3000/api/test'));
    const context = { params: Promise.resolve({}) };

    const response = await wrappedHandler(req, context);

    expect(handler).not.toHaveBeenCalled();
    expect(response.status).toBe(401);
    const body = await response.json();
    expect(body.error.message).toContain('Super Admin');
  });
});
