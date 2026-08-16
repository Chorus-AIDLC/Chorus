import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock Prisma
const prismaMock = vi.hoisted(() => {
  return {
    user: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
    },
    agent: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
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
    agentInstance: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      findMany: vi.fn(),
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
  resolveAssigneeAgentUuid,
  buildAssigneeMatch,
  isAssignmentOwnedByActor,
  resolveAssigneeInstanceInfo,
  batchGetAssigneeInstanceInfo,
  resolveAssignmentActor,
  batchResolveAssignmentActors,
} from '../uuid-resolver';
import type { AuthContext } from '@/types/auth';
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

  // add-agent-instance-addressing: an agent_instance assignee resolves its name to
  // the OWNING agent (getActorName) AND enriches the payload with the pinned
  // (host, cwd) place + owning agentUuid (resolveAssigneeInstanceInfo) so the UI
  // can render the instance and gate ownership.
  it('enriches an agent_instance assignee with its (host, cwd) place + owning agent', async () => {
    // formatAssigneeComplete runs getActorName + resolveAssigneeInstanceInfo
    // concurrently (Promise.all), both hitting agentInstance.findUnique with a
    // DIFFERENT `select`. Branch on the select shape rather than call order.
    prismaMock.agentInstance.findUnique.mockImplementation((args: { select?: Record<string, unknown> }) =>
      args.select && 'agent' in args.select
        ? Promise.resolve({ agent: { name: 'Worker Bot' } })
        : Promise.resolve({ agentUuid: 'agent-9', host: 'ci-host', cwd: '/srv/app' }),
    );

    const result = await formatAssigneeComplete('agent_instance', 'inst-1', null, null);

    expect(result).toEqual({
      type: 'agent_instance',
      uuid: 'inst-1',
      name: 'Worker Bot',
      assignedAt: null,
      assignedBy: null,
      instance: { agentUuid: 'agent-9', host: 'ci-host', cwd: '/srv/app' },
    });
  });

  it('omits instance enrichment when the agent_instance row is missing', async () => {
    // Name still resolves (agent relation present) but the info lookup returns null.
    prismaMock.agentInstance.findUnique.mockImplementation((args: { select?: Record<string, unknown> }) =>
      args.select && 'agent' in args.select
        ? Promise.resolve({ agent: { name: 'Worker Bot' } })
        : Promise.resolve(null),
    );

    const result = await formatAssigneeComplete('agent_instance', 'inst-x', null, null);

    expect(result).toEqual({
      type: 'agent_instance',
      uuid: 'inst-x',
      name: 'Worker Bot',
      assignedAt: null,
      assignedBy: null,
    });
    expect((result as { instance?: unknown }).instance).toBeUndefined();
  });
});

describe('assignment provenance resolution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('resolves a typed agent within the resource company', async () => {
    prismaMock.agent.findFirst.mockResolvedValue({ name: 'Orchestrator' });

    await expect(
      resolveAssignmentActor('company-1', 'agent', 'agent-1'),
    ).resolves.toEqual({
      type: 'agent',
      uuid: 'agent-1',
      name: 'Orchestrator',
    });
    expect(prismaMock.agent.findFirst).toHaveBeenCalledWith({
      where: { uuid: 'agent-1', companyUuid: 'company-1' },
      select: { name: true },
    });
    expect(prismaMock.user.findFirst).not.toHaveBeenCalled();
  });

  it('infers legacy provenance user-first, then agent', async () => {
    prismaMock.user.findFirst.mockResolvedValue(null);
    prismaMock.agent.findFirst.mockResolvedValue({ name: 'Legacy Agent' });

    await expect(
      resolveAssignmentActor('company-1', null, 'legacy-1'),
    ).resolves.toEqual({
      type: 'agent',
      uuid: 'legacy-1',
      name: 'Legacy Agent',
    });
    expect(prismaMock.user.findFirst).toHaveBeenCalledBefore(
      prismaMock.agent.findFirst,
    );
  });

  it('returns null for unknown or deleted typed identities', async () => {
    prismaMock.agent.findFirst.mockResolvedValue(null);
    await expect(
      resolveAssignmentActor('company-1', 'agent', 'missing'),
    ).resolves.toBeNull();
  });

  it('batch-resolves typed and legacy provenance with two company-scoped queries', async () => {
    prismaMock.user.findMany.mockResolvedValue([
      { uuid: 'shared', name: 'Historical User', email: 'u@example.com' },
    ]);
    prismaMock.agent.findMany.mockResolvedValue([
      { uuid: 'shared', name: 'Agent Same UUID' },
      { uuid: 'agent-2', name: 'Agent Two' },
    ]);

    await expect(
      batchResolveAssignmentActors('company-1', [
        { assignedByType: null, assignedByUuid: 'shared' },
        { assignedByType: 'agent', assignedByUuid: 'agent-2' },
        { assignedByType: 'user', assignedByUuid: 'missing' },
      ]),
    ).resolves.toEqual([
      { type: 'user', uuid: 'shared', name: 'Historical User' },
      { type: 'agent', uuid: 'agent-2', name: 'Agent Two' },
      null,
    ]);
    expect(prismaMock.user.findMany).toHaveBeenCalledTimes(1);
    expect(prismaMock.agent.findMany).toHaveBeenCalledTimes(1);
  });
});

describe('resolveAssigneeInstanceInfo', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns null for a non-instance assignee type without any DB read', async () => {
    expect(await resolveAssigneeInstanceInfo('agent', 'agent-1')).toBeNull();
    expect(await resolveAssigneeInstanceInfo('user', 'user-1')).toBeNull();
    expect(await resolveAssigneeInstanceInfo(null, null)).toBeNull();
    expect(prismaMock.agentInstance.findUnique).not.toHaveBeenCalled();
  });

  it('returns the (agentUuid, host, cwd) for an existing instance', async () => {
    prismaMock.agentInstance.findUnique.mockResolvedValue({
      agentUuid: 'agent-7',
      host: '',
      cwd: null,
    });
    const result = await resolveAssigneeInstanceInfo('agent_instance', 'inst-2');
    expect(result).toEqual({ agentUuid: 'agent-7', host: '', cwd: null });
  });

  it('returns null when the instance row does not exist', async () => {
    prismaMock.agentInstance.findUnique.mockResolvedValue(null);
    expect(await resolveAssigneeInstanceInfo('agent_instance', 'gone')).toBeNull();
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

  // add-agent-instance-addressing: the third arm. Without it an instance-pinned
  // assignee's name was never resolved → it fell to null → it silently vanished
  // from any batched list/kanban render. Keyed by the INSTANCE uuid (the row's
  // assigneeUuid), valued by the OWNING agent's name.
  it('resolves agent_instance names to the owning agent, keyed by the instance uuid', async () => {
    prismaMock.user.findMany.mockResolvedValue([]);
    prismaMock.agent.findMany.mockResolvedValue([]);
    prismaMock.agentInstance.findMany.mockResolvedValue([
      { uuid: 'inst-1', agent: { name: 'Worker Bot' } },
      { uuid: 'inst-2', agent: { name: 'Other Bot' } },
    ]);

    const result = await batchGetActorNames([
      { type: 'agent_instance', uuid: 'inst-1' },
      { type: 'agent_instance', uuid: 'inst-2' },
    ]);

    expect(result.get('inst-1')).toBe('Worker Bot');
    expect(result.get('inst-2')).toBe('Other Bot');
    expect(prismaMock.agentInstance.findMany).toHaveBeenCalledWith({
      where: { uuid: { in: ['inst-1', 'inst-2'] } },
      select: { uuid: true, agent: { select: { name: true } } },
    });
  });

  it('resolves all three types together in one batch', async () => {
    prismaMock.user.findMany.mockResolvedValue([makeUser({ uuid: 'user-1', name: 'Alice' })]);
    prismaMock.agent.findMany.mockResolvedValue([makeAgent({ uuid: 'agent-1', name: 'Bot' })]);
    prismaMock.agentInstance.findMany.mockResolvedValue([
      { uuid: 'inst-1', agent: { name: 'Pinned Bot' } },
    ]);

    const result = await batchGetActorNames([
      { type: 'user', uuid: 'user-1' },
      { type: 'agent', uuid: 'agent-1' },
      { type: 'agent_instance', uuid: 'inst-1' },
    ]);

    expect(result.get('user-1')).toBe('Alice');
    expect(result.get('agent-1')).toBe('Bot');
    expect(result.get('inst-1')).toBe('Pinned Bot');
  });

  it('skips an instance whose owning agent relation is missing', async () => {
    prismaMock.user.findMany.mockResolvedValue([]);
    prismaMock.agent.findMany.mockResolvedValue([]);
    prismaMock.agentInstance.findMany.mockResolvedValue([
      { uuid: 'inst-1', agent: null },
    ]);

    const result = await batchGetActorNames([{ type: 'agent_instance', uuid: 'inst-1' }]);
    expect(result.has('inst-1')).toBe(false);
  });

  it('does not query agentInstance when there are no instance actors', async () => {
    prismaMock.user.findMany.mockResolvedValue([makeUser({ uuid: 'user-1', name: 'Alice' })]);
    prismaMock.agent.findMany.mockResolvedValue([]);

    await batchGetActorNames([{ type: 'user', uuid: 'user-1' }]);
    expect(prismaMock.agentInstance.findMany).not.toHaveBeenCalled();
  });
});

describe('batchGetAssigneeInstanceInfo', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns an empty map (and no query) for empty input', async () => {
    const result = await batchGetAssigneeInstanceInfo([]);
    expect(result.size).toBe(0);
    expect(prismaMock.agentInstance.findMany).not.toHaveBeenCalled();
  });

  it('resolves (agentUuid, host, cwd) per instance uuid, deduplicated', async () => {
    prismaMock.agentInstance.findMany.mockResolvedValue([
      { uuid: 'inst-1', agentUuid: 'agent-1', host: 'h1', cwd: '/a' },
      { uuid: 'inst-2', agentUuid: 'agent-2', host: '', cwd: null },
    ]);

    const result = await batchGetAssigneeInstanceInfo(['inst-1', 'inst-2', 'inst-1']);

    expect(result.get('inst-1')).toEqual({ agentUuid: 'agent-1', host: 'h1', cwd: '/a' });
    expect(result.get('inst-2')).toEqual({ agentUuid: 'agent-2', host: '', cwd: null });
    expect(prismaMock.agentInstance.findMany).toHaveBeenCalledWith({
      where: { uuid: { in: ['inst-1', 'inst-2'] } },
      select: { uuid: true, agentUuid: true, host: true, cwd: true },
    });
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

describe('getActorName — agent_instance', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the owning agent name for an agent_instance', async () => {
    prismaMock.agentInstance.findUnique.mockResolvedValue({
      agent: { name: 'Admin Claude' },
    });

    const name = await getActorName('agent_instance', 'inst-1');
    expect(name).toBe('Admin Claude');
    expect(prismaMock.agentInstance.findUnique).toHaveBeenCalledWith({
      where: { uuid: 'inst-1' },
      select: { agent: { select: { name: true } } },
    });
  });

  it('returns null when the instance is not found', async () => {
    prismaMock.agentInstance.findUnique.mockResolvedValue(null);

    const name = await getActorName('agent_instance', 'missing');
    expect(name).toBeNull();
  });
});

describe('resolveAssigneeAgentUuid', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the assigneeUuid as-is for an agent', async () => {
    const result = await resolveAssigneeAgentUuid('comp-1', 'agent', 'agent-1');
    expect(result).toBe('agent-1');
    // No DB lookup for a plain agent — the uuid already IS the agent uuid.
    expect(prismaMock.agentInstance.findFirst).not.toHaveBeenCalled();
  });

  it("resolves an agent_instance to its owning agent's uuid (company-scoped)", async () => {
    prismaMock.agentInstance.findFirst.mockResolvedValue({ agentUuid: 'agent-9' });

    const result = await resolveAssigneeAgentUuid('comp-1', 'agent_instance', 'inst-1');
    expect(result).toBe('agent-9');
    expect(prismaMock.agentInstance.findFirst).toHaveBeenCalledWith({
      where: { uuid: 'inst-1', companyUuid: 'comp-1' },
      select: { agentUuid: true },
    });
  });

  it('returns null for an agent_instance that does not resolve', async () => {
    prismaMock.agentInstance.findFirst.mockResolvedValue(null);
    const result = await resolveAssigneeAgentUuid('comp-1', 'agent_instance', 'missing');
    expect(result).toBeNull();
  });

  it('returns null for a user', async () => {
    const result = await resolveAssigneeAgentUuid('comp-1', 'user', 'user-1');
    expect(result).toBeNull();
  });

  it('returns null for null type or uuid', async () => {
    expect(await resolveAssigneeAgentUuid('comp-1', null, 'x')).toBeNull();
    expect(await resolveAssigneeAgentUuid('comp-1', 'agent', null)).toBeNull();
  });

  it('returns null for an unknown type', async () => {
    const result = await resolveAssigneeAgentUuid('comp-1', 'robot', 'x');
    expect(result).toBeNull();
  });
});

describe('buildAssigneeMatch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const agentAuth = (over: Partial<AuthContext> = {}): AuthContext => ({
    type: 'agent',
    companyUuid: 'comp-1',
    actorUuid: 'agent-1',
    ownerUuid: 'owner-1',
    ...over,
  });

  it('matches agent rows, owner-as-assignee user rows, AND the actor instance uuids', async () => {
    prismaMock.agentInstance.findMany.mockResolvedValue([
      { uuid: 'inst-1' },
      { uuid: 'inst-2' },
    ]);

    const conditions = await buildAssigneeMatch(agentAuth());

    expect(conditions).toEqual([
      { assigneeType: 'agent', assigneeUuid: 'agent-1' },
      { assigneeType: 'user', assigneeUuid: 'owner-1' },
      { assigneeType: 'agent_instance', assigneeUuid: { in: ['inst-1', 'inst-2'] } },
    ]);
    // The instance arm targets INSTANCE uuids, never the actor uuid.
    const instArm = conditions.find((c) => c.assigneeType === 'agent_instance')!;
    expect(instArm.assigneeUuid).toEqual({ in: ['inst-1', 'inst-2'] });
    expect(instArm.assigneeUuid).not.toBe('agent-1');
    expect(prismaMock.agentInstance.findMany).toHaveBeenCalledWith({
      where: { companyUuid: 'comp-1', agentUuid: 'agent-1' },
      select: { uuid: true },
    });
  });

  it('omits the agent_instance arm when the agent has no instances', async () => {
    prismaMock.agentInstance.findMany.mockResolvedValue([]);

    const conditions = await buildAssigneeMatch(agentAuth());

    expect(conditions).toEqual([
      { assigneeType: 'agent', assigneeUuid: 'agent-1' },
      { assigneeType: 'user', assigneeUuid: 'owner-1' },
    ]);
    expect(conditions.some((c) => c.assigneeType === 'agent_instance')).toBe(false);
  });

  it('omits the owner-user arm when the agent has no owner', async () => {
    prismaMock.agentInstance.findMany.mockResolvedValue([]);

    const conditions = await buildAssigneeMatch(agentAuth({ ownerUuid: undefined }));

    expect(conditions).toEqual([
      { assigneeType: 'agent', assigneeUuid: 'agent-1' },
    ]);
  });

  it('matches only the user row for a user actor (no DB read)', async () => {
    const conditions = await buildAssigneeMatch({
      type: 'user',
      companyUuid: 'comp-1',
      actorUuid: 'user-1',
    } as AuthContext);

    expect(conditions).toEqual([{ assigneeType: 'user', assigneeUuid: 'user-1' }]);
    expect(prismaMock.agentInstance.findMany).not.toHaveBeenCalled();
  });

  it('REGRESSION: a naive flat {assigneeType:"agent", assigneeUuid:actor} filter misses an agent_instance row', async () => {
    // This is the exact bug the helper exists to prevent: an agent_instance row's
    // assigneeUuid is an INSTANCE uuid, so the old flat agent-equality condition
    // can never match it — the helper's IN-arm is what catches it.
    const agentInstanceRow = { assigneeType: 'agent_instance', assigneeUuid: 'inst-1' };
    const naiveFlatCondition = { assigneeType: 'agent', assigneeUuid: 'agent-1' };

    const matchesNaive =
      agentInstanceRow.assigneeType === naiveFlatCondition.assigneeType &&
      agentInstanceRow.assigneeUuid === naiveFlatCondition.assigneeUuid;
    expect(matchesNaive).toBe(false); // the bug: silently dropped

    prismaMock.agentInstance.findMany.mockResolvedValue([{ uuid: 'inst-1' }]);
    const conditions = await buildAssigneeMatch(agentAuth());
    const instArm = conditions.find((c) => c.assigneeType === 'agent_instance')!;
    const matchesHelper =
      instArm &&
      agentInstanceRow.assigneeType === instArm.assigneeType &&
      (instArm.assigneeUuid as { in: string[] }).in.includes(agentInstanceRow.assigneeUuid);
    expect(matchesHelper).toBe(true); // the fix: the helper's IN-arm catches it
  });
});

describe('isAssignmentOwnedByActor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const agentAuth = (over: Partial<AuthContext> = {}): AuthContext => ({
    type: 'agent',
    companyUuid: 'comp-1',
    actorUuid: 'agent-1',
    ownerUuid: 'owner-1',
    ...over,
  });

  it('passes a plain agent assignment whose uuid is the actor (no DB lookup)', async () => {
    const result = await isAssignmentOwnedByActor(agentAuth(), 'agent', 'agent-1');
    expect(result).toBe(true);
    expect(prismaMock.agentInstance.findFirst).not.toHaveBeenCalled();
  });

  it('rejects a plain agent assignment whose uuid is a different agent', async () => {
    const result = await isAssignmentOwnedByActor(agentAuth(), 'agent', 'agent-2');
    expect(result).toBe(false);
  });

  it('passes an agent_instance assignment owned by the actor (resolved instance → agent)', async () => {
    prismaMock.agentInstance.findFirst.mockResolvedValue({ agentUuid: 'agent-1' });
    const result = await isAssignmentOwnedByActor(agentAuth(), 'agent_instance', 'inst-1');
    expect(result).toBe(true);
    expect(prismaMock.agentInstance.findFirst).toHaveBeenCalledWith({
      where: { uuid: 'inst-1', companyUuid: 'comp-1' },
      select: { agentUuid: true },
    });
  });

  it('rejects an agent_instance assignment owned by a DIFFERENT agent', async () => {
    prismaMock.agentInstance.findFirst.mockResolvedValue({ agentUuid: 'agent-2' });
    const result = await isAssignmentOwnedByActor(agentAuth(), 'agent_instance', 'inst-1');
    expect(result).toBe(false);
  });

  it('rejects an agent_instance assignment that does not resolve', async () => {
    prismaMock.agentInstance.findFirst.mockResolvedValue(null);
    const result = await isAssignmentOwnedByActor(agentAuth(), 'agent_instance', 'missing');
    expect(result).toBe(false);
  });

  it('passes a user assignment matching the agent owner (owner-as-assignee)', async () => {
    const result = await isAssignmentOwnedByActor(agentAuth(), 'user', 'owner-1');
    expect(result).toBe(true);
  });

  it('rejects a user assignment when the agent has no owner', async () => {
    const result = await isAssignmentOwnedByActor(agentAuth({ ownerUuid: undefined }), 'user', 'owner-1');
    expect(result).toBe(false);
  });

  it('returns false for a null/absent assignment', async () => {
    expect(await isAssignmentOwnedByActor(agentAuth(), null, 'x')).toBe(false);
    expect(await isAssignmentOwnedByActor(agentAuth(), 'agent', null)).toBe(false);
  });

  it('returns false for an unknown assignee type', async () => {
    const result = await isAssignmentOwnedByActor(agentAuth(), 'robot', 'x');
    expect(result).toBe(false);
  });
});
