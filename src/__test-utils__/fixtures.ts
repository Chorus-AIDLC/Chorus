/**
 * Shared test fixtures — factory functions for common entities.
 * Use these in tests to create realistic mock data without repeating boilerplate.
 */

let counter = 0;
function nextUuid() {
  counter++;
  return `00000000-0000-0000-0000-${String(counter).padStart(12, '0')}`;
}

export function resetFixtureCounter() {
  counter = 0;
}

export function makeCompany(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    uuid: nextUuid(),
    name: 'Test Company',
    emailDomain: 'test.com',
    oidcEnabled: false,
    oidcIssuer: null,
    oidcClientId: null,
    oidcClientSecret: null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...overrides,
  };
}

export function makeUser(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    uuid: nextUuid(),
    email: 'user@test.com',
    name: 'Test User',
    companyUuid: '00000000-0000-0000-0000-000000000001',
    companyId: 1,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...overrides,
  };
}

export function makeAgent(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    uuid: nextUuid(),
    name: 'Test Agent',
    roles: ['developer_agent'],
    persona: null,
    systemPrompt: null,
    companyUuid: '00000000-0000-0000-0000-000000000001',
    companyId: 1,
    ownerUuid: '00000000-0000-0000-0000-000000000002',
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...overrides,
  };
}

export function makeProject(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    uuid: nextUuid(),
    name: 'Test Project',
    description: 'A test project',
    companyUuid: '00000000-0000-0000-0000-000000000001',
    companyId: 1,
    groupUuid: null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...overrides,
  };
}

export function makeTask(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    uuid: nextUuid(),
    title: 'Test Task',
    description: 'A test task description',
    status: 'open',
    priority: 'medium',
    storyPoints: null,
    assigneeType: null,
    assigneeUuid: null,
    assignedAt: null,
    assignedByUuid: null,
    acceptanceCriteria: null,
    projectUuid: '00000000-0000-0000-0000-000000000010',
    companyUuid: '00000000-0000-0000-0000-000000000001',
    companyId: 1,
    proposalUuid: null,
    createdByUuid: '00000000-0000-0000-0000-000000000002',
    createdByType: 'user',
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...overrides,
  };
}

export function makeIdea(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    uuid: nextUuid(),
    title: 'Test Idea',
    content: 'A test idea',
    status: 'open',
    assigneeType: null,
    assigneeUuid: null,
    assignedAt: null,
    elaborationStatus: null,
    projectUuid: '00000000-0000-0000-0000-000000000010',
    companyUuid: '00000000-0000-0000-0000-000000000001',
    companyId: 1,
    createdByUuid: '00000000-0000-0000-0000-000000000002',
    createdByType: 'user',
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...overrides,
  };
}

export function makeProposal(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    uuid: nextUuid(),
    title: 'Test Proposal',
    description: 'A test proposal',
    status: 'draft',
    inputType: 'idea',
    inputUuids: [],
    documentDrafts: [],
    taskDrafts: [],
    projectUuid: '00000000-0000-0000-0000-000000000010',
    companyUuid: '00000000-0000-0000-0000-000000000001',
    companyId: 1,
    createdByUuid: '00000000-0000-0000-0000-000000000002',
    createdByType: 'agent',
    reviewedByUuid: null,
    reviewNote: null,
    reviewedAt: null,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...overrides,
  };
}

export function makeAcceptanceCriterion(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    uuid: nextUuid(),
    taskUuid: '00000000-0000-0000-0000-000000000020',
    description: 'Test criterion',
    required: true,
    devStatus: 'pending',
    devEvidence: null,
    devMarkedByType: null,
    devMarkedBy: null,
    devMarkedAt: null,
    status: 'pending',
    evidence: null,
    markedByType: null,
    markedBy: null,
    markedAt: null,
    sortOrder: 0,
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...overrides,
  };
}

/** Common auth contexts for testing */
export const authContexts = {
  user: {
    type: 'user' as const,
    companyUuid: '00000000-0000-0000-0000-000000000001',
    actorUuid: '00000000-0000-0000-0000-000000000002',
    userUuid: '00000000-0000-0000-0000-000000000002',
  },
  agent: {
    type: 'agent' as const,
    companyUuid: '00000000-0000-0000-0000-000000000001',
    actorUuid: '00000000-0000-0000-0000-000000000003',
    agentUuid: '00000000-0000-0000-0000-000000000003',
    roles: ['developer_agent'],
  },
  pmAgent: {
    type: 'agent' as const,
    companyUuid: '00000000-0000-0000-0000-000000000001',
    actorUuid: '00000000-0000-0000-0000-000000000004',
    agentUuid: '00000000-0000-0000-0000-000000000004',
    roles: ['pm_agent'],
  },
  adminAgent: {
    type: 'agent' as const,
    companyUuid: '00000000-0000-0000-0000-000000000001',
    actorUuid: '00000000-0000-0000-0000-000000000005',
    agentUuid: '00000000-0000-0000-0000-000000000005',
    roles: ['admin_agent'],
  },
  superAdmin: {
    type: 'super_admin' as const,
    companyUuid: '00000000-0000-0000-0000-000000000001',
    actorUuid: 'super-admin',
  },
};
