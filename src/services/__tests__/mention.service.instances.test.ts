import { describe, it, expect, vi, beforeEach } from "vitest";

// ===== Mocks (hoisted) =====
// This suite covers the cwd-addressable-instances additions (T3): parseMentions
// pin extraction, enrichAgentInstances, and searchMentionables({withInstances}).
// It mocks listConnectionsForAgent directly (rather than the prisma row shape)
// so the per-instance candidate mapping is asserted in isolation.

const {
  mockPrisma,
  mockGetActorName,
  mockGetPreferences,
  mockCreateBatch,
  mockListConnectionsForAgent,
} = vi.hoisted(() => ({
  mockPrisma: {
    mention: { createMany: vi.fn() },
    user: { findFirst: vi.fn(), findMany: vi.fn() },
    agent: { findFirst: vi.fn(), findMany: vi.fn() },
    project: { findUnique: vi.fn() },
    comment: { findUnique: vi.fn() },
    daemonConnection: { findMany: vi.fn() },
    daemonExecution: { groupBy: vi.fn() },
  },
  mockGetActorName: vi.fn().mockResolvedValue("Test Actor"),
  mockGetPreferences: vi.fn().mockResolvedValue({ mentioned: true }),
  mockCreateBatch: vi.fn().mockResolvedValue([]),
  mockListConnectionsForAgent: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/uuid-resolver", () => ({ getActorName: mockGetActorName }));
vi.mock("@/services/notification.service", () => ({
  getPreferences: (...args: unknown[]) => mockGetPreferences(...args),
  createBatch: (...args: unknown[]) => mockCreateBatch(...args),
}));
vi.mock("@/services/daemon-connection.service", () => ({
  // STALE_THRESHOLD_MS is also imported by the service; keep it a plain constant.
  STALE_THRESHOLD_MS: 90_000,
  listConnectionsForAgent: (...args: unknown[]) =>
    mockListConnectionsForAgent(...args),
}));

import {
  parseMentions,
  enrichAgentInstances,
  searchMentionables,
  type Mentionable,
} from "@/services/mention.service";

const COMPANY_UUID = "11111111-1111-1111-1111-111111111111";
const AGENT_A = "aaaaaaaa-1111-1111-1111-111111111111";
const AGENT_B = "bbbbbbbb-2222-2222-2222-222222222222";
const USER_UUID = "44444444-4444-4444-4444-444444444444";

function connView(over: Record<string, unknown>) {
  return {
    uuid: "conn-x",
    agentUuid: AGENT_A,
    agentName: "DevBot",
    clientType: "claude_code",
    clientVersion: "0.11.0",
    host: "Laptop-Q3",
    cwd: "/home/u/dev/chorus",
    startedAt: null,
    status: "online",
    effectiveStatus: "online",
    connectedAt: "2026-06-23T00:00:00.000Z",
    lastSeenAt: "2026-06-23T00:00:00.000Z",
    disconnectedAt: null,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.daemonConnection.findMany.mockResolvedValue([]);
  mockPrisma.daemonExecution.groupBy.mockResolvedValue([]);
  mockListConnectionsForAgent.mockResolvedValue([]);
});

describe("parseMentions — pinned instance suffix (T3)", () => {
  it("extracts a pinned (host, cwd) from the markup suffix", () => {
    const content = `@[DevBot](agent:${AGENT_A}?cwd=%2Fhome%2Fu%2Fdev%2Fchorus&host=Laptop-Q3)`;
    const refs = parseMentions(content);
    expect(refs).toHaveLength(1);
    expect(refs[0]).toEqual({
      type: "agent",
      uuid: AGENT_A,
      displayName: "DevBot",
      pinnedHost: "Laptop-Q3",
      pinnedCwd: "/home/u/dev/chorus",
    });
  });

  it("leaves an un-pinned mention object-identical to the legacy shape", () => {
    const refs = parseMentions(`@[DevBot](agent:${AGENT_A})`);
    expect(refs[0]).toEqual({
      type: "agent",
      uuid: AGENT_A,
      displayName: "DevBot",
    });
    // No additive keys on an un-pinned ref.
    expect("pinnedHost" in refs[0]).toBe(false);
    expect("pinnedCwd" in refs[0]).toBe(false);
  });

  it("decodes an unknown-path pin (empty cwd) to a null cwd", () => {
    const refs = parseMentions(`@[DevBot](agent:${AGENT_A}?cwd=&host=ci-runner)`);
    expect(refs[0].pinnedCwd).toBeNull();
    expect(refs[0].pinnedHost).toBe("ci-runner");
  });
});

describe("enrichAgentInstances (T3)", () => {
  it("issues NO connection query when there are no agent candidates", async () => {
    const results: Mentionable[] = [
      { type: "user", uuid: USER_UUID, name: "Alice" },
    ];
    await enrichAgentInstances(COMPANY_UUID, results);
    expect(mockListConnectionsForAgent).not.toHaveBeenCalled();
    expect(results[0].instances).toBeUndefined();
  });

  it("maps listConnectionsForAgent rows to per-instance candidates (online + offline)", async () => {
    mockListConnectionsForAgent.mockResolvedValue([
      connView({ uuid: "c1", host: "Laptop-Q3", cwd: "/home/u/dev/chorus", effectiveStatus: "online" }),
      connView({ uuid: "c2", host: "ci-runner-02", cwd: "/home/u/dev/chorus", effectiveStatus: "offline" }),
      connView({ uuid: "c3", host: "Laptop-Q3", cwd: null, effectiveStatus: "online" }),
    ]);
    const results: Mentionable[] = [
      { type: "agent", uuid: AGENT_A, name: "DevBot" },
    ];
    await enrichAgentInstances(COMPANY_UUID, results);

    expect(mockListConnectionsForAgent).toHaveBeenCalledWith(COMPANY_UUID, AGENT_A);
    expect(results[0].instances).toEqual([
      { connectionUuid: "c1", host: "Laptop-Q3", cwd: "/home/u/dev/chorus", effectiveStatus: "online" },
      { connectionUuid: "c2", host: "ci-runner-02", cwd: "/home/u/dev/chorus", effectiveStatus: "offline" },
      { connectionUuid: "c3", host: "Laptop-Q3", cwd: null, effectiveStatus: "online" },
    ]);
  });

  it("attaches an empty instances array for an agent with no connections", async () => {
    mockListConnectionsForAgent.mockResolvedValue([]);
    const results: Mentionable[] = [
      { type: "agent", uuid: AGENT_A, name: "DevBot" },
    ];
    await enrichAgentInstances(COMPANY_UUID, results);
    expect(results[0].instances).toEqual([]);
  });

  it("never enriches user candidates", async () => {
    mockListConnectionsForAgent.mockResolvedValue([connView({ uuid: "c1" })]);
    const results: Mentionable[] = [
      { type: "user", uuid: USER_UUID, name: "Alice" },
      { type: "agent", uuid: AGENT_A, name: "DevBot" },
    ];
    await enrichAgentInstances(COMPANY_UUID, results);
    expect(results[0].instances).toBeUndefined();
    expect(results[1].instances).toHaveLength(1);
  });

  it("batches one query per candidate agent", async () => {
    mockListConnectionsForAgent.mockResolvedValue([]);
    const results: Mentionable[] = [
      { type: "agent", uuid: AGENT_A, name: "A" },
      { type: "agent", uuid: AGENT_B, name: "B" },
    ];
    await enrichAgentInstances(COMPANY_UUID, results);
    expect(mockListConnectionsForAgent).toHaveBeenCalledTimes(2);
  });
});

describe("searchMentionables — withInstances (T3)", () => {
  it("attaches instances only when withInstances is set", async () => {
    mockPrisma.agent.findMany.mockResolvedValue([
      { uuid: AGENT_A, name: "DevBot", roles: [] },
    ]);
    // Online via liveness enrichment so the agent survives the slice.
    mockPrisma.daemonConnection.findMany.mockResolvedValue([
      { agentUuid: AGENT_A, status: "online", lastSeenAt: new Date() },
    ]);
    mockListConnectionsForAgent.mockResolvedValue([
      connView({ uuid: "c1" }),
      connView({ uuid: "c2", host: "ci-runner-02", effectiveStatus: "offline" }),
    ]);

    const withOff = await searchMentionables({
      companyUuid: COMPANY_UUID,
      query: "",
      actorType: "user",
      actorUuid: USER_UUID,
      withInstances: true,
    });
    expect(withOff[0].instances).toHaveLength(2);
    expect(mockListConnectionsForAgent).toHaveBeenCalledWith(COMPANY_UUID, AGENT_A);
  });

  it("does NOT query instances when withInstances is omitted (default)", async () => {
    mockPrisma.agent.findMany.mockResolvedValue([
      { uuid: AGENT_A, name: "DevBot", roles: [] },
    ]);
    const res = await searchMentionables({
      companyUuid: COMPANY_UUID,
      query: "",
      actorType: "user",
      actorUuid: USER_UUID,
    });
    expect(res[0].instances).toBeUndefined();
    expect(mockListConnectionsForAgent).not.toHaveBeenCalled();
  });
});
