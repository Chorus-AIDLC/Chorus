import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock Prisma
const prismaMock = vi.hoisted(() => {
  return {
    user: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
    },
    agent: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
    },
    agentSession: {
      findUnique: vi.fn(),
    },
    idea: {
      findFirst: vi.fn(),
    },
    proposal: {
      findFirst: vi.fn(),
    },
    task: {
      findFirst: vi.fn(),
    },
    document: {
      findFirst: vi.fn(),
    },
  };
});
vi.mock("@/lib/prisma", () => ({ prisma: prismaMock }));

import {
  getActorName,
  formatAssignee,
  formatCreatedBy,
  formatAssigneeComplete,
  formatReview,
  batchGetActorNames,
  batchFormatCreatedBy,
  getSessionName,
  validateTargetExists,
} from '../uuid-resolver';
import { makeUser, makeAgent } from '@/__test-utils__/fixtures';

describe('getActorName', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns user name for user type', async () => {
    const user = makeUser({ uuid: 'user-1', name: 'Alice' });
    prismaMock.user.findUnique.mockResolvedValue(user);

    const name = await getActorName('user', 'user-1');
    expect(name).toBe('Alice');
    expect(prismaMock.user.findUnique).toHaveBeenCalledWith({
      where: { uuid: 'user-1' },
      select: { name: true, email: true },
    });
  });

  it('falls back to email if user name is null', async () => {
    const user = makeUser({ uuid: 'user-2', name: null, email: 'bob@test.com' });
    prismaMock.user.findUnique.mockResolvedValue(user);

    const name = await getActorName('user', 'user-2');
    expect(name).toBe('bob@test.com');
  });

  it('returns Unknown if user not found', async () => {
    prismaMock.user.findUnique.mockResolvedValue(null);

    const name = await getActorName('user', 'missing');
    expect(name).toBe('Unknown');
  });

  it('returns agent name for agent type', async () => {
    const agent = makeAgent({ uuid: 'agent-1', name: 'PM Agent' });
    prismaMock.agent.findUnique.mockResolvedValue(agent);

    const name = await getActorName('agent', 'agent-1');
    expect(name).toBe('PM Agent');
    expect(prismaMock.agent.findUnique).toHaveBeenCalledWith({
      where: { uuid: 'agent-1' },
      select: { name: true },
    });
  });

  it('returns null if agent not found', async () => {
    prismaMock.agent.findUnique.mockResolvedValue(null);

    const name = await getActorName('agent', 'missing');
    expect(name).toBeNull();
  });

  it('returns null for unknown actor type', async () => {
    const name = await getActorName('unknown', 'some-uuid');
    expect(name).toBeNull();
  });
});

describe('formatAssignee', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns formatted assignee for valid user', async () => {
    const user = makeUser({ uuid: 'user-1', name: 'Alice' });
    prismaMock.user.findUnique.mockResolvedValue(user);

    const result = await formatAssignee('user', 'user-1');
    expect(result).toEqual({
      type: 'user',
      uuid: 'user-1',
      name: 'Alice',
    });
  });

  it('returns formatted assignee for valid agent', async () => {
    const agent = makeAgent({ uuid: 'agent-1', name: 'Dev Agent' });
    prismaMock.agent.findUnique.mockResolvedValue(agent);

    const result = await formatAssignee('agent', 'agent-1');
    expect(result).toEqual({
      type: 'agent',
      uuid: 'agent-1',
      name: 'Dev Agent',
    });
  });

  it('returns null if assigneeType is null', async () => {
    const result = await formatAssignee(null, 'user-1');
    expect(result).toBeNull();
  });

  it('returns null if assigneeUuid is null', async () => {
    const result = await formatAssignee('user', null);
    expect(result).toBeNull();
  });

  it('returns assignee with Unknown name if user not found', async () => {
    prismaMock.user.findUnique.mockResolvedValue(null);

    const result = await formatAssignee('user', 'missing');
    expect(result).toEqual({
      type: 'user',
      uuid: 'missing',
      name: 'Unknown',
    });
  });
});

describe('formatCreatedBy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns formatted creator when type is specified as user', async () => {
    const user = makeUser({ uuid: 'user-1', name: 'Alice' });
    prismaMock.user.findUnique.mockResolvedValue(user);

    const result = await formatCreatedBy('user-1', 'user');
    expect(result).toEqual({
      type: 'user',
      uuid: 'user-1',
      name: 'Alice',
    });
  });

  it('returns formatted creator when type is specified as agent', async () => {
    const agent = makeAgent({ uuid: 'agent-1', name: 'PM Agent' });
    prismaMock.agent.findUnique.mockResolvedValue(agent);

    const result = await formatCreatedBy('agent-1', 'agent');
    expect(result).toEqual({
      type: 'agent',
      uuid: 'agent-1',
      name: 'PM Agent',
    });
  });

  it('tries user first when type not specified and finds user', async () => {
    const user = makeUser({ uuid: 'creator-1', name: 'Alice' });
    prismaMock.user.findUnique.mockResolvedValue(user);

    const result = await formatCreatedBy('creator-1');
    expect(result).toEqual({
      type: 'user',
      uuid: 'creator-1',
      name: 'Alice',
    });
    expect(prismaMock.user.findUnique).toHaveBeenCalled();
    expect(prismaMock.agent.findUnique).not.toHaveBeenCalled();
  });

  it('tries agent if user not found when type not specified', async () => {
    prismaMock.user.findUnique.mockResolvedValue(null);
    const agent = makeAgent({ uuid: 'creator-2', name: 'Bot' });
    prismaMock.agent.findUnique.mockResolvedValue(agent);

    const result = await formatCreatedBy('creator-2');
    expect(result).toEqual({
      type: 'agent',
      uuid: 'creator-2',
      name: 'Bot',
    });
    expect(prismaMock.user.findUnique).toHaveBeenCalled();
    expect(prismaMock.agent.findUnique).toHaveBeenCalled();
  });

  it('returns null if neither user nor agent found', async () => {
    prismaMock.user.findUnique.mockResolvedValue(null);
    prismaMock.agent.findUnique.mockResolvedValue(null);

    const result = await formatCreatedBy('missing');
    expect(result).toBeNull();
  });

  it('returns creator with Unknown name if specified user not found', async () => {
    prismaMock.user.findUnique.mockResolvedValue(null);

    const result = await formatCreatedBy('missing', 'user');
    expect(result).toEqual({
      type: 'user',
      uuid: 'missing',
      name: 'Unknown',
    });
  });
});

describe('formatAssigneeComplete', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns complete assignee info with all fields', async () => {
    const user = makeUser({ uuid: 'user-1', name: 'Alice' });
    const assigner = makeUser({ uuid: 'user-2', name: 'Bob' });
    prismaMock.user.findUnique
      .mockResolvedValueOnce(user)
      .mockResolvedValueOnce(assigner);

    const assignedAt = new Date('2026-01-15T10:00:00Z');
    const result = await formatAssigneeComplete('user', 'user-1', assignedAt, 'user-2');

    expect(result).toEqual({
      type: 'user',
      uuid: 'user-1',
      name: 'Alice',
      assignedAt: '2026-01-15T10:00:00.000Z',
      assignedBy: {
        type: 'user',
        uuid: 'user-2',
        name: 'Bob',
      },
    });
  });

  it('returns null assignedBy if assignedByUuid is null', async () => {
    const user = makeUser({ uuid: 'user-1', name: 'Alice' });
    prismaMock.user.findUnique.mockResolvedValue(user);

    const result = await formatAssigneeComplete('user', 'user-1', null, null);

    expect(result).toEqual({
      type: 'user',
      uuid: 'user-1',
      name: 'Alice',
      assignedAt: null,
      assignedBy: null,
    });
  });

  it('returns null if assigneeType is null', async () => {
    const result = await formatAssigneeComplete(null, 'user-1', null, null);
    expect(result).toBeNull();
  });

  it('returns null if assigneeUuid is null', async () => {
    const result = await formatAssigneeComplete('user', null, null, null);
    expect(result).toBeNull();
  });

  it('returns assignee with Unknown name if user not found', async () => {
    prismaMock.user.findUnique.mockResolvedValue(null);

    const result = await formatAssigneeComplete('user', 'missing', null, null);
    expect(result).toEqual({
      type: 'user',
      uuid: 'missing',
      name: 'Unknown',
      assignedAt: null,
      assignedBy: null,
    });
  });
});

describe('formatReview', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns formatted review info', async () => {
    const user = makeUser({ uuid: 'user-1', name: 'Reviewer' });
    prismaMock.user.findUnique.mockResolvedValue(user);

    const reviewedAt = new Date('2026-01-20T12:00:00Z');
    const result = await formatReview('user-1', 'Looks good', reviewedAt);

    expect(result).toEqual({
      reviewedBy: {
        type: 'user',
        uuid: 'user-1',
        name: 'Reviewer',
      },
      reviewNote: 'Looks good',
      reviewedAt: '2026-01-20T12:00:00.000Z',
    });
  });

  it('returns null if reviewedByUuid is null', async () => {
    const result = await formatReview(null, 'note', new Date());
    expect(result).toBeNull();
  });

  it('returns null if reviewer not found in user or agent tables', async () => {
    prismaMock.user.findUnique.mockResolvedValue(null);
    prismaMock.agent.findUnique.mockResolvedValue(null);

    const result = await formatReview('missing', 'note', new Date());
    expect(result).toBeNull();
  });

  it('resolves agent reviewer when not found as user', async () => {
    prismaMock.user.findUnique.mockResolvedValue(null);
    prismaMock.agent.findUnique.mockResolvedValue({ name: 'Admin Agent' });

    const reviewedAt = new Date('2026-01-20T12:00:00Z');
    const result = await formatReview('agent-1', 'Approved', reviewedAt);
    expect(result).toEqual({
      reviewedBy: {
        type: 'agent',
        uuid: 'agent-1',
        name: 'Admin Agent',
      },
      reviewNote: 'Approved',
      reviewedAt: '2026-01-20T12:00:00.000Z',
    });
  });

  it('handles null reviewNote and reviewedAt', async () => {
    const user = makeUser({ uuid: 'user-1', name: 'Reviewer' });
    prismaMock.user.findUnique.mockResolvedValue(user);

    const result = await formatReview('user-1', null, null);

    expect(result).toEqual({
      reviewedBy: {
        type: 'user',
        uuid: 'user-1',
        name: 'Reviewer',
      },
      reviewNote: null,
      reviewedAt: null,
    });
  });
});

describe('batchGetActorNames', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns empty map for empty input', async () => {
    const result = await batchGetActorNames([]);
    expect(result.size).toBe(0);
  });

  it('fetches user names in batch', async () => {
    const users = [
      makeUser({ uuid: 'user-1', name: 'Alice' }),
      makeUser({ uuid: 'user-2', name: 'Bob' }),
    ];
    prismaMock.user.findMany.mockResolvedValue(users);
    prismaMock.agent.findMany.mockResolvedValue([]);

    const result = await batchGetActorNames([
      { type: 'user', uuid: 'user-1' },
      { type: 'user', uuid: 'user-2' },
    ]);

    expect(result.get('user-1')).toBe('Alice');
    expect(result.get('user-2')).toBe('Bob');
    expect(prismaMock.user.findMany).toHaveBeenCalledWith({
      where: { uuid: { in: ['user-1', 'user-2'] } },
      select: { uuid: true, name: true, email: true },
    });
  });

  it('fetches agent names in batch', async () => {
    const agents = [
      makeAgent({ uuid: 'agent-1', name: 'PM Agent' }),
      makeAgent({ uuid: 'agent-2', name: 'Dev Agent' }),
    ];
    prismaMock.user.findMany.mockResolvedValue([]);
    prismaMock.agent.findMany.mockResolvedValue(agents);

    const result = await batchGetActorNames([
      { type: 'agent', uuid: 'agent-1' },
      { type: 'agent', uuid: 'agent-2' },
    ]);

    expect(result.get('agent-1')).toBe('PM Agent');
    expect(result.get('agent-2')).toBe('Dev Agent');
    expect(prismaMock.agent.findMany).toHaveBeenCalledWith({
      where: { uuid: { in: ['agent-1', 'agent-2'] } },
      select: { uuid: true, name: true },
    });
  });

  it('fetches both users and agents in parallel', async () => {
    const users = [makeUser({ uuid: 'user-1', name: 'Alice' })];
    const agents = [makeAgent({ uuid: 'agent-1', name: 'Bot' })];
    prismaMock.user.findMany.mockResolvedValue(users);
    prismaMock.agent.findMany.mockResolvedValue(agents);

    const result = await batchGetActorNames([
      { type: 'user', uuid: 'user-1' },
      { type: 'agent', uuid: 'agent-1' },
    ]);

    expect(result.get('user-1')).toBe('Alice');
    expect(result.get('agent-1')).toBe('Bot');
  });

  it('deduplicates actors by uuid', async () => {
    const users = [makeUser({ uuid: 'user-1', name: 'Alice' })];
    prismaMock.user.findMany.mockResolvedValue(users);
    prismaMock.agent.findMany.mockResolvedValue([]);

    await batchGetActorNames([
      { type: 'user', uuid: 'user-1' },
      { type: 'user', uuid: 'user-1' },
      { type: 'user', uuid: 'user-1' },
    ]);

    expect(prismaMock.user.findMany).toHaveBeenCalledWith({
      where: { uuid: { in: ['user-1'] } },
      select: { uuid: true, name: true, email: true },
    });
  });

  it('uses email as fallback for users without name', async () => {
    const users = [makeUser({ uuid: 'user-1', name: null, email: 'alice@test.com' })];
    prismaMock.user.findMany.mockResolvedValue(users);
    prismaMock.agent.findMany.mockResolvedValue([]);

    const result = await batchGetActorNames([{ type: 'user', uuid: 'user-1' }]);

    expect(result.get('user-1')).toBe('alice@test.com');
  });
});

describe('batchFormatCreatedBy', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns empty map for empty input', async () => {
    const result = await batchFormatCreatedBy([]);
    expect(result.size).toBe(0);
  });

  it('tries users first, then agents for remaining', async () => {
    const users = [makeUser({ uuid: 'uuid-1', name: 'Alice' })];
    const agents = [makeAgent({ uuid: 'uuid-2', name: 'Bot' })];
    prismaMock.user.findMany.mockResolvedValue(users);
    prismaMock.agent.findMany.mockResolvedValue(agents);

    const result = await batchFormatCreatedBy(['uuid-1', 'uuid-2']);

    expect(result.get('uuid-1')).toEqual({ type: 'user', uuid: 'uuid-1', name: 'Alice' });
    expect(result.get('uuid-2')).toEqual({ type: 'agent', uuid: 'uuid-2', name: 'Bot' });
    expect(prismaMock.user.findMany).toHaveBeenCalledWith({
      where: { uuid: { in: ['uuid-1', 'uuid-2'] } },
      select: { uuid: true, name: true, email: true },
    });
    expect(prismaMock.agent.findMany).toHaveBeenCalledWith({
      where: { uuid: { in: ['uuid-2'] } },
      select: { uuid: true, name: true },
    });
  });

  it('skips agent query if all UUIDs found in users', async () => {
    const users = [
      makeUser({ uuid: 'uuid-1', name: 'Alice' }),
      makeUser({ uuid: 'uuid-2', name: 'Bob' }),
    ];
    prismaMock.user.findMany.mockResolvedValue(users);

    const result = await batchFormatCreatedBy(['uuid-1', 'uuid-2']);

    expect(result.size).toBe(2);
    expect(prismaMock.agent.findMany).not.toHaveBeenCalled();
  });

  it('deduplicates input UUIDs', async () => {
    const users = [makeUser({ uuid: 'uuid-1', name: 'Alice' })];
    prismaMock.user.findMany.mockResolvedValue(users);

    await batchFormatCreatedBy(['uuid-1', 'uuid-1', 'uuid-1']);

    expect(prismaMock.user.findMany).toHaveBeenCalledWith({
      where: { uuid: { in: ['uuid-1'] } },
      select: { uuid: true, name: true, email: true },
    });
  });
});

describe('getSessionName', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns session name when found', async () => {
    prismaMock.agentSession.findUnique.mockResolvedValue({
      name: 't5-worker',
    } as any);

    const result = await getSessionName('session-1');
    expect(result).toBe('t5-worker');
    expect(prismaMock.agentSession.findUnique).toHaveBeenCalledWith({
      where: { uuid: 'session-1' },
      select: { name: true },
    });
  });

  it('returns null when session not found', async () => {
    prismaMock.agentSession.findUnique.mockResolvedValue(null);

    const result = await getSessionName('missing');
    expect(result).toBeNull();
  });
});

describe('validateTargetExists', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('validates idea exists', async () => {
    prismaMock.idea.findFirst.mockResolvedValue({ uuid: 'idea-1' } as any);

    const result = await validateTargetExists('idea', 'idea-1', 'comp-1');
    expect(result).toBe(true);
    expect(prismaMock.idea.findFirst).toHaveBeenCalledWith({
      where: { uuid: 'idea-1', companyUuid: 'comp-1' },
      select: { uuid: true },
    });
  });

  it('validates proposal exists', async () => {
    prismaMock.proposal.findFirst.mockResolvedValue({ uuid: 'prop-1' } as any);

    const result = await validateTargetExists('proposal', 'prop-1', 'comp-1');
    expect(result).toBe(true);
  });

  it('validates task exists', async () => {
    prismaMock.task.findFirst.mockResolvedValue({ uuid: 'task-1' } as any);

    const result = await validateTargetExists('task', 'task-1', 'comp-1');
    expect(result).toBe(true);
  });

  it('validates document exists', async () => {
    prismaMock.document.findFirst.mockResolvedValue({ uuid: 'doc-1' } as any);

    const result = await validateTargetExists('document', 'doc-1', 'comp-1');
    expect(result).toBe(true);
  });

  it('returns false when target not found', async () => {
    prismaMock.task.findFirst.mockResolvedValue(null);

    const result = await validateTargetExists('task', 'missing', 'comp-1');
    expect(result).toBe(false);
  });

  it('returns false for unknown target type', async () => {
    const result = await validateTargetExists('unknown' as any, 'id', 'comp-1');
    expect(result).toBe(false);
  });
});
