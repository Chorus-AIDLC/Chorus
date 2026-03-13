import { describe, it, expect, vi } from 'vitest';

// Mock dependencies that auth.ts imports transitively
vi.mock('@/lib/prisma', () => ({ prisma: {} }));
vi.mock('@/generated/prisma/client', () => ({ PrismaClient: vi.fn() }));
vi.mock('@/lib/super-admin', () => ({ getSuperAdminFromRequest: vi.fn() }));
vi.mock('@/lib/user-session', () => ({ getUserSessionFromRequest: vi.fn() }));
vi.mock('@/lib/oidc-auth', () => ({ verifyOidcAccessToken: vi.fn(), isOidcToken: vi.fn() }));

import { isAgent, isUser, hasRole, isPmAgent, isDeveloperAgent } from '../auth';
import type { AgentAuthContext, UserAuthContext, AuthContext } from '@/types/auth';

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
