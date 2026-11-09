// cli-agent-session-sync — daemon-cli-session.service (register / heartbeat / release / bind).
import { describe, it, expect, vi, beforeEach } from "vitest";

const mockPrisma = vi.hoisted(() => {
  const client = {
    idea: { findFirst: vi.fn() },
    daemonSession: { create: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), updateMany: vi.fn() },
    daemonSessionTurn: { create: vi.fn(), updateMany: vi.fn() },
    daemonConnection: { findMany: vi.fn(), findFirst: vi.fn() },
    daemonDirectoryRequest: { findMany: vi.fn() },
    projectAgentCwdPreference: { findFirst: vi.fn() },
  } as Record<string, any>;
  client.$transaction = vi.fn(async (op: (c: unknown) => unknown) => op(client));
  return client;
});
vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
const mockLogger = vi.hoisted(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), child: vi.fn() }));
vi.mock("@/lib/logger", () => ({ default: { ...mockLogger, child: () => mockLogger } }));
vi.mock("@/services/daemon-connection.service", () => ({ STALE_THRESHOLD_MS: 90_000 }));
const mockCanAccess = vi.hoisted(() => vi.fn(async () => true));
vi.mock("@/services/project-access.service", () => ({ canActorAccessProject: mockCanAccess }));
const session = vi.hoisted(() => ({
  drainQueuedTurns: vi.fn(async () => [] as string[]),
  endCliTurn: vi.fn(async () => []),
  publishSessionActivityEvent: vi.fn(),
  publishTranscriptEvent: vi.fn(),
}));
vi.mock("@/services/daemon-session.service", () => session);

import {
  bindUnboundCliSessionsForConnection,
  CliInvalidIdeaError,
  CliLeaseConflictError,
  CliSessionNotFoundError,
  findServingConnection,
  heartbeatCliSession,
  registerCliSession,
  releaseCliSession,
} from "@/services/daemon-cli-session.service";

const auth = { companyUuid: "company-1", actorUuid: "agent-1" };
const fresh = () => new Date();

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.daemonConnection.findMany.mockResolvedValue([]);
  mockPrisma.daemonDirectoryRequest.findMany.mockResolvedValue([]);
  mockPrisma.daemonSession.findFirst.mockResolvedValue(null);
  mockPrisma.projectAgentCwdPreference.findFirst.mockResolvedValue(null);
  mockCanAccess.mockResolvedValue(true);
  session.drainQueuedTurns.mockResolvedValue([]);
});

describe("findServingConnection (D5)", () => {
  it("binds the online connection whose own cwd equals the launch cwd (runtimeCwd null)", async () => {
    mockPrisma.daemonConnection.findMany.mockResolvedValueOnce([
      { uuid: "c-other", cwd: "/elsewhere", lastSeenAt: fresh() },
      { uuid: "c-exact", cwd: "/repo", lastSeenAt: fresh() },
      { uuid: "c-stale", cwd: "/repo", lastSeenAt: new Date(Date.now() - 200_000) },
    ]);
    expect(await findServingConnection("company-1", "agent-1", "box", "/repo")).toEqual({ connectionUuid: "c-exact", runtimeCwd: null });
    expect(mockPrisma.daemonConnection.findMany.mock.calls[0][0].where).toEqual({
      companyUuid: "company-1", agentUuid: "agent-1", host: "box", status: "online",
    });
  });

  it("returns null when no connection is online on the host", async () => {
    mockPrisma.daemonConnection.findMany.mockResolvedValueOnce([{ uuid: "c", cwd: "/repo", lastSeenAt: new Date(0) }]);
    expect(await findServingConnection("company-1", "agent-1", "box", "/repo")).toBeNull();
  });

  it("binds a discovered directory (validate / roots) with runtimeCwd = launch cwd", async () => {
    mockPrisma.daemonConnection.findMany.mockResolvedValue([{ uuid: "c1", cwd: "/home/u", lastSeenAt: fresh() }]);
    mockPrisma.daemonDirectoryRequest.findMany.mockResolvedValueOnce([
      { targetConnectionUuid: "c1", operation: "validate", result: { normalizedPath: "/home/u/other" } },
      { targetConnectionUuid: "c1", operation: "roots", result: "junk" },
      { targetConnectionUuid: "c1", operation: "validate", result: { normalizedPath: "/home/u/repo" } },
    ]);
    expect(await findServingConnection("company-1", "agent-1", "box", "/home/u/repo")).toEqual({ connectionUuid: "c1", runtimeCwd: "/home/u/repo" });

    mockPrisma.daemonDirectoryRequest.findMany.mockResolvedValueOnce([
      { targetConnectionUuid: "c1", operation: "roots", result: { roots: ["/srv", "/home/u"] } },
    ]);
    expect(await findServingConnection("company-1", "agent-1", "box", "/home/u/repo")).toEqual({ connectionUuid: "c1", runtimeCwd: "/home/u/repo" });
  });

  it("binds a directed cwd (existing session runtimeCwd) or a project-fixed preference; else null", async () => {
    mockPrisma.daemonConnection.findMany.mockResolvedValue([{ uuid: "c1", cwd: "/a", lastSeenAt: fresh() }]);
    mockPrisma.daemonSession.findFirst.mockResolvedValueOnce({ originConnectionUuid: "c1" });
    expect(await findServingConnection("company-1", "agent-1", "box", "/b")).toEqual({ connectionUuid: "c1", runtimeCwd: "/b" });
    mockPrisma.projectAgentCwdPreference.findFirst.mockResolvedValueOnce({ uuid: "p" });
    expect(await findServingConnection("company-1", "agent-1", "box", "/b")).toEqual({ connectionUuid: "c1", runtimeCwd: "/b" });
    expect(await findServingConnection("company-1", "agent-1", "box", "/b")).toBeNull();
  });
});

describe("registerCliSession", () => {
  function primeCreate(originConnectionUuid: string | null) {
    mockPrisma.daemonSession.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      ...data, uuid: "session-1", agent: { ownerUuid: "owner-1" },
    }));
    mockPrisma.daemonSessionTurn.create.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
      ...data, uuid: "turn-1", createdAt: new Date(),
    }));
    if (originConnectionUuid) {
      mockPrisma.daemonConnection.findMany.mockResolvedValueOnce([{ uuid: originConnectionUuid, cwd: "/repo", lastSeenAt: fresh() }]);
    }
  }

  it("creates an ad-hoc bound session, a running cli_session turn and a 60s lease", async () => {
    primeCreate("conn-1");
    const res = await registerCliSession(auth, { agentType: "claude_code", host: "box", cwd: "/repo" });
    expect(res).toMatchObject({
      sessionUuid: "session-1", turnUuid: "turn-1", leaseTtlSec: 60, heartbeatIntervalSec: 15,
      originBound: true, continuable: true,
    });
    expect(res.sessionId).toMatch(/^[0-9a-f-]{36}$/);
    expect(res.leaseHolder).toMatch(/^[0-9a-f-]{36}$/);
    const data = mockPrisma.daemonSession.create.mock.calls[0][0].data;
    expect(data).toMatchObject({
      companyUuid: "company-1", agentUuid: "agent-1", sessionId: res.sessionId, directIdeaUuid: null,
      originConnectionUuid: "conn-1", runtimeCwd: null, cliLeaseHolder: res.leaseHolder, cliHost: "box", cliCwd: "/repo",
      continuable: true,
    });
    expect(data.cliLeaseExpiresAt.getTime() - Date.now()).toBeGreaterThan(55_000);
    expect(mockPrisma.daemonSessionTurn.create.mock.calls[0][0].data).toMatchObject({
      sessionUuid: "session-1", seq: 1, trigger: "cli_session", status: "running",
    });
    expect(mockPrisma.daemonSessionTurn.create.mock.calls[0][0].data.wakeTargetConnectionUuid).toBeUndefined();
    expect(session.publishTranscriptEvent).toHaveBeenCalledWith(expect.objectContaining({ trigger: "turn_created" }));
    expect(session.publishSessionActivityEvent).toHaveBeenCalledWith(expect.objectContaining({ type: "session_started", agentOwnerUuid: "owner-1" }));
  });

  it("registers unbound when no daemon serves the cwd, anchored to an Idea with its own sessionId", async () => {
    primeCreate(null);
    mockPrisma.idea.findFirst.mockResolvedValueOnce({ projectUuid: "project-1" });
    const res = await registerCliSession(auth, {
      agentType: "claude_code", host: "box", cwd: "/repo", ideaUuid: "idea-1", title: "T", continuable: false, backendSessionId: "b-1",
    });
    expect(res).toMatchObject({ originBound: false, continuable: false });
    const data = mockPrisma.daemonSession.create.mock.calls[0][0].data;
    expect(data).toMatchObject({ directIdeaUuid: "idea-1", originConnectionUuid: null, title: "T", backendSessionId: "b-1", continuable: false });
    expect(data.sessionId).not.toBe("idea-1");
    expect(mockCanAccess).toHaveBeenCalledWith("company-1", { type: "agent", uuid: "agent-1" }, "project-1", "editor");
  });

  it("rejects an unknown or inaccessible idea with CliInvalidIdeaError and creates nothing", async () => {
    mockPrisma.idea.findFirst.mockResolvedValueOnce(null);
    await expect(registerCliSession(auth, { agentType: "x", host: "h", cwd: "/c", ideaUuid: "nope" })).rejects.toBeInstanceOf(CliInvalidIdeaError);
    mockPrisma.idea.findFirst.mockResolvedValueOnce({ projectUuid: "p" });
    mockCanAccess.mockResolvedValueOnce(false);
    await expect(registerCliSession(auth, { agentType: "x", host: "h", cwd: "/c", ideaUuid: "private" })).rejects.toBeInstanceOf(CliInvalidIdeaError);
    expect(mockPrisma.daemonSession.create).not.toHaveBeenCalled();
  });
});

describe("heartbeatCliSession", () => {
  it("renews the lease fenced on holder + owner and records a late backendSessionId", async () => {
    mockPrisma.daemonSession.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.daemonSessionTurn.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.daemonSession.findFirst.mockResolvedValue({ uuid: "s", originConnectionUuid: "c", continuable: true, cliLeaseHolder: "h" });
    const res = await heartbeatCliSession(auth, "s", { leaseHolder: "h", backendSessionId: "b-1" });
    expect(res).toMatchObject({ leaseTtlSec: 60, heartbeatIntervalSec: 15, originBound: true });
    expect(mockPrisma.daemonSession.updateMany.mock.calls[0][0].where).toEqual({
      uuid: "s", companyUuid: "company-1", agentUuid: "agent-1", cliLeaseHolder: "h",
    });
    expect(mockPrisma.daemonSession.updateMany.mock.calls[1][0]).toEqual({
      where: { uuid: "s", backendSessionId: null }, data: { backendSessionId: "b-1" },
    });
    expect(mockPrisma.daemonSessionTurn.updateMany).toHaveBeenCalledWith({
      where: { sessionUuid: "s", trigger: "cli_session", backendSessionId: null }, data: { backendSessionId: "b-1" },
    });
  });

  it("404 for an unknown/foreign session, 409 for a stale holder", async () => {
    mockPrisma.daemonSession.updateMany.mockResolvedValue({ count: 0 });
    mockPrisma.daemonSession.findFirst.mockResolvedValueOnce(null);
    await expect(heartbeatCliSession(auth, "s", { leaseHolder: "h" })).rejects.toBeInstanceOf(CliSessionNotFoundError);
    mockPrisma.daemonSession.findFirst.mockResolvedValueOnce({ uuid: "s" });
    await expect(heartbeatCliSession(auth, "s", { leaseHolder: "old" })).rejects.toBeInstanceOf(CliLeaseConflictError);
  });
});

describe("releaseCliSession", () => {
  it("clears the lease, stores continuable:false, ends the CLI turn and drains immediately", async () => {
    mockPrisma.daemonSession.updateMany.mockResolvedValueOnce({ count: 1 });
    // The shared drain retires (never delivers) the queued turns of a not-continuable session.
    session.drainQueuedTurns.mockResolvedValueOnce([]);
    mockPrisma.daemonSession.findFirst.mockResolvedValueOnce({ uuid: "s", originConnectionUuid: "c", continuable: false, cliLeaseHolder: null });
    const res = await releaseCliSession(auth, "s", { leaseHolder: "h", continuable: false, reason: "exit 0" });
    expect(res).toEqual({ released: true, continuable: false, originBound: true, deliveredTurnUuids: [] });
    expect(mockPrisma.daemonSession.updateMany).toHaveBeenCalledWith({
      where: { uuid: "s", companyUuid: "company-1", agentUuid: "agent-1", cliLeaseHolder: "h" },
      data: { cliLeaseHolder: null, cliLeaseExpiresAt: null, continuable: false },
    });
    expect(session.endCliTurn).toHaveBeenCalledWith("s", expect.any(Date));
    expect(session.drainQueuedTurns).toHaveBeenCalledWith("company-1", "s", expect.any(Date));
  });

  it("reports the turns the drain delivered for a continuable release", async () => {
    mockPrisma.daemonSession.updateMany.mockResolvedValueOnce({ count: 1 });
    session.drainQueuedTurns.mockResolvedValueOnce(["t2"]);
    mockPrisma.daemonSession.findFirst.mockResolvedValueOnce({ uuid: "s", originConnectionUuid: "c", continuable: true, cliLeaseHolder: null });
    const res = await releaseCliSession(auth, "s", { leaseHolder: "h", continuable: true });
    expect(res.deliveredTurnUuids).toEqual(["t2"]);
  });

  it("keeps the stored flag on continuable:true and maps 404 / 409", async () => {
    mockPrisma.daemonSession.updateMany.mockResolvedValueOnce({ count: 1 });
    mockPrisma.daemonSession.findFirst.mockResolvedValueOnce(null);
    const res = await releaseCliSession(auth, "s", { leaseHolder: "h", continuable: true });
    expect(res).toMatchObject({ continuable: true, originBound: false, deliveredTurnUuids: [] });
    expect(mockPrisma.daemonSession.updateMany.mock.calls[0][0].data).toEqual({ cliLeaseHolder: null, cliLeaseExpiresAt: null });

    mockPrisma.daemonSession.updateMany.mockResolvedValue({ count: 0 });
    mockPrisma.daemonSession.findFirst.mockResolvedValueOnce(null);
    await expect(releaseCliSession(auth, "s", { leaseHolder: "h", continuable: true })).rejects.toBeInstanceOf(CliSessionNotFoundError);
    mockPrisma.daemonSession.findFirst.mockResolvedValueOnce({ uuid: "s" });
    await expect(releaseCliSession(auth, "s", { leaseHolder: "h", continuable: true })).rejects.toBeInstanceOf(CliLeaseConflictError);
    expect(session.endCliTurn).toHaveBeenCalledTimes(1);
  });
});

describe("bindUnboundCliSessionsForConnection (D5)", () => {
  it("binds unbound sessions of the agent+host the connection serves, conditionally, then drains", async () => {
    mockPrisma.daemonConnection.findFirst.mockResolvedValueOnce({ agentUuid: "agent-1", host: "box" });
    mockPrisma.daemonSession.findMany.mockResolvedValueOnce([
      { uuid: "s1", cliCwd: "/repo" }, { uuid: "s2", cliCwd: "/unserved" }, { uuid: "s3", cliCwd: "/repo" },
    ]);
    mockPrisma.daemonConnection.findMany.mockResolvedValue([{ uuid: "conn-1", cwd: "/repo", lastSeenAt: fresh() }]);
    mockPrisma.daemonSession.updateMany.mockResolvedValueOnce({ count: 1 }).mockResolvedValueOnce({ count: 0 });
    expect(await bindUnboundCliSessionsForConnection("company-1", "conn-1")).toBe(1);
    expect(mockPrisma.daemonSession.findMany.mock.calls[0][0].where).toEqual({
      companyUuid: "company-1", agentUuid: "agent-1", originConnectionUuid: null, cliHost: "box", cliCwd: { not: null },
    });
    expect(mockPrisma.daemonSession.updateMany).toHaveBeenCalledWith({
      where: { uuid: "s1", companyUuid: "company-1", originConnectionUuid: null },
      data: { originConnectionUuid: "conn-1", runtimeCwd: null },
    });
    expect(session.drainQueuedTurns).toHaveBeenCalledTimes(1);
    expect(session.drainQueuedTurns).toHaveBeenCalledWith("company-1", "s1");
  });

  it("is a no-op for an unknown connection and swallows failures", async () => {
    mockPrisma.daemonConnection.findFirst.mockResolvedValueOnce(null);
    expect(await bindUnboundCliSessionsForConnection("company-1", "x")).toBe(0);
    mockPrisma.daemonConnection.findFirst.mockRejectedValueOnce(new Error("db"));
    expect(await bindUnboundCliSessionsForConnection("company-1", "x")).toBe(0);
    expect(mockLogger.error).toHaveBeenCalled();
  });
});
