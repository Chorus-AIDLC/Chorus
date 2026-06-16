import { describe, it, expect, vi, beforeEach } from "vitest";

// ===== Prisma mock =====
const mockPrisma = vi.hoisted(() => ({
  daemonConnection: {
    upsert: vi.fn(),
    updateMany: vi.fn(),
    findMany: vi.fn(),
  },
}));
vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));

const mockLogger = vi.hoisted(() => ({
  error: vi.fn(),
  warn: vi.fn(),
  info: vi.fn(),
  debug: vi.fn(),
}));
vi.mock("@/lib/logger", () => ({ default: mockLogger }));

import {
  DAEMON_CLIENT_TYPES,
  STALE_THRESHOLD_MS,
  parseSelfReport,
  registerConnection,
  markDisconnected,
  touchConnection,
  listConnectionsForOwner,
  listConnectionsForAgent,
  type SelfReport,
} from "@/services/daemon-connection.service";

// ===== Helpers =====
const companyUuid = "company-0000-0000-0000-000000000001";
const agentUuid = "agent-0000-0000-0000-000000000001";
const connectionUuid = "conn-0000-0000-0000-000000000001";
const connectedAt = new Date("2026-06-15T03:00:00.000Z");
const handle = { uuid: connectionUuid, connectedAt };

beforeEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

// ===== Constants =====
describe("constants", () => {
  it("DAEMON_CLIENT_TYPES are exactly claude_code + openclaw", () => {
    expect(DAEMON_CLIENT_TYPES).toEqual(["claude_code", "openclaw"]);
  });

  it("STALE_THRESHOLD_MS is 90s (3x the 30s heartbeat)", () => {
    expect(STALE_THRESHOLD_MS).toBe(90_000);
    expect(STALE_THRESHOLD_MS).toBe(3 * 30_000);
  });
});

// ===== parseSelfReport =====
describe("parseSelfReport", () => {
  it("parses all params including a valid ISO-8601 startedAt", () => {
    const params = new URLSearchParams({
      clientType: "claude_code",
      clientVersion: "0.11.0",
      host: "mac.local",
      startedAt: "2026-06-15T03:00:00.000Z",
    });
    const report = parseSelfReport(params);
    expect(report.clientType).toBe("claude_code");
    expect(report.clientVersion).toBe("0.11.0");
    expect(report.host).toBe("mac.local");
    expect(report.startedAt).toBeInstanceOf(Date);
    expect(report.startedAt?.toISOString()).toBe("2026-06-15T03:00:00.000Z");
  });

  it("defaults missing string params: clientType='' and nullable fields null", () => {
    const report = parseSelfReport(new URLSearchParams());
    expect(report.clientType).toBe("");
    expect(report.clientVersion).toBeNull();
    expect(report.host).toBeNull();
    expect(report.startedAt).toBeNull();
  });

  it("parses an unparseable startedAt to null (no Invalid Date)", () => {
    const params = new URLSearchParams({
      clientType: "openclaw",
      startedAt: "not-a-date",
    });
    const report = parseSelfReport(params);
    expect(report.startedAt).toBeNull();
  });

  it("parses an empty-string startedAt to null", () => {
    const params = new URLSearchParams({ clientType: "claude_code", startedAt: "" });
    expect(parseSelfReport(params).startedAt).toBeNull();
  });
});

// ===== registerConnection =====
describe("registerConnection", () => {
  it("writes an online row for a daemon clientType and returns a {uuid, connectedAt} handle", async () => {
    mockPrisma.daemonConnection.upsert.mockResolvedValue({ uuid: connectionUuid, connectedAt });
    const report: SelfReport = {
      clientType: "claude_code",
      clientVersion: "0.11.0",
      host: "mac.local",
      startedAt: new Date("2026-06-15T03:00:00.000Z"),
    };

    const result = await registerConnection(companyUuid, agentUuid, report);

    expect(result).toEqual({ uuid: connectionUuid, connectedAt });
    expect(mockPrisma.daemonConnection.upsert).toHaveBeenCalledTimes(1);
    const arg = mockPrisma.daemonConnection.upsert.mock.calls[0][0];
    // Upsert key is the composite unique (agentUuid, clientType, host).
    expect(arg.where).toEqual({
      agentUuid_clientType_host: {
        agentUuid,
        clientType: "claude_code",
        host: "mac.local",
      },
    });
    expect(arg.create.status).toBe("online");
    expect(arg.create.companyUuid).toBe(companyUuid);
    expect(arg.create.host).toBe("mac.local");
    expect(arg.create.connectedAt).toBeInstanceOf(Date);
    expect(arg.create.lastSeenAt).toBeInstanceOf(Date);
    // update branch flips back to online + clears disconnectedAt + refreshes
    // connectedAt (the fencing token for an older generation's late calls).
    expect(arg.update.status).toBe("online");
    expect(arg.update.disconnectedAt).toBeNull();
    expect(arg.update.connectedAt).toBeInstanceOf(Date);
    expect(arg.update.companyUuid).toBe(companyUuid);
    // The handle's connectedAt comes from the persisted row, not the local clock.
    expect(arg.select).toEqual({ uuid: true, connectedAt: true });
  });

  it("registers an openclaw clientType", async () => {
    mockPrisma.daemonConnection.upsert.mockResolvedValue({ uuid: connectionUuid, connectedAt });
    const result = await registerConnection(companyUuid, agentUuid, {
      clientType: "openclaw",
      host: "linux-box",
    });
    expect(result).toEqual({ uuid: connectionUuid, connectedAt });
    expect(mockPrisma.daemonConnection.upsert).toHaveBeenCalledTimes(1);
  });

  it("returns null and writes nothing for a non-daemon clientType (browser)", async () => {
    const result = await registerConnection(companyUuid, agentUuid, {
      clientType: "browser",
      host: "mac.local",
    });
    expect(result).toBeNull();
    expect(mockPrisma.daemonConnection.upsert).not.toHaveBeenCalled();
  });

  it("returns null and writes nothing for an unrecognized clientType", async () => {
    const result = await registerConnection(companyUuid, agentUuid, {
      clientType: "something-else",
    });
    expect(result).toBeNull();
    expect(mockPrisma.daemonConnection.upsert).not.toHaveBeenCalled();
  });

  it("returns null and writes nothing for an empty clientType", async () => {
    const result = await registerConnection(companyUuid, agentUuid, { clientType: "" });
    expect(result).toBeNull();
    expect(mockPrisma.daemonConnection.upsert).not.toHaveBeenCalled();
  });

  it("upserts the same (agentUuid, clientType, host) row on reconnect rather than inserting", async () => {
    mockPrisma.daemonConnection.upsert.mockResolvedValue({ uuid: connectionUuid, connectedAt });
    const report: SelfReport = { clientType: "claude_code", host: "mac.local" };

    const first = await registerConnection(companyUuid, agentUuid, report);
    const second = await registerConnection(companyUuid, agentUuid, report);

    expect(first).toEqual({ uuid: connectionUuid, connectedAt });
    expect(second).toEqual({ uuid: connectionUuid, connectedAt });
    // Two upsert calls, both keyed on the same composite — never .create.
    expect(mockPrisma.daemonConnection.upsert).toHaveBeenCalledTimes(2);
    const firstWhere = mockPrisma.daemonConnection.upsert.mock.calls[0][0].where;
    const secondWhere = mockPrisma.daemonConnection.upsert.mock.calls[1][0].where;
    expect(firstWhere).toEqual(secondWhere);
  });

  it("defaults a missing host to '' so the composite key stays deterministic", async () => {
    mockPrisma.daemonConnection.upsert.mockResolvedValue({ uuid: connectionUuid, connectedAt });
    await registerConnection(companyUuid, agentUuid, { clientType: "claude_code" });
    const arg = mockPrisma.daemonConnection.upsert.mock.calls[0][0];
    expect(arg.where.agentUuid_clientType_host.host).toBe("");
    expect(arg.create.host).toBe("");
  });

  it("coerces missing clientVersion/startedAt to null", async () => {
    mockPrisma.daemonConnection.upsert.mockResolvedValue({ uuid: connectionUuid, connectedAt });
    await registerConnection(companyUuid, agentUuid, {
      clientType: "claude_code",
      host: "h",
    });
    const arg = mockPrisma.daemonConnection.upsert.mock.calls[0][0];
    expect(arg.create.clientVersion).toBeNull();
    expect(arg.create.startedAt).toBeNull();
  });

  it("swallows + logs a persistence error and returns null (never throws)", async () => {
    mockPrisma.daemonConnection.upsert.mockRejectedValue(new Error("db down"));
    const result = await registerConnection(companyUuid, agentUuid, {
      clientType: "claude_code",
      host: "mac.local",
    });
    expect(result).toBeNull();
    expect(mockLogger.error).toHaveBeenCalledTimes(1);
  });
});

// ===== markDisconnected =====
describe("markDisconnected", () => {
  it("sets status=offline + disconnectedAt, fenced by companyUuid + uuid + connectedAt", async () => {
    mockPrisma.daemonConnection.updateMany.mockResolvedValue({ count: 1 });
    await markDisconnected(companyUuid, handle);
    expect(mockPrisma.daemonConnection.updateMany).toHaveBeenCalledTimes(1);
    const arg = mockPrisma.daemonConnection.updateMany.mock.calls[0][0];
    // connectedAt in the where clause is the generation fence: a stale abort
    // from an older generation matches 0 rows once the row has been re-registered.
    expect(arg.where).toEqual({ uuid: connectionUuid, companyUuid, connectedAt });
    expect(arg.data.status).toBe("offline");
    expect(arg.data.disconnectedAt).toBeInstanceOf(Date);
  });

  it("matches 0 rows (no-op) when a newer generation has refreshed connectedAt", async () => {
    // The conditional update simply affects 0 rows — the service neither throws
    // nor logs an error for the stale-abort case.
    mockPrisma.daemonConnection.updateMany.mockResolvedValue({ count: 0 });
    await expect(markDisconnected(companyUuid, handle)).resolves.toBeUndefined();
    expect(mockLogger.error).not.toHaveBeenCalled();
  });

  it("swallows + logs a persistence error (never throws)", async () => {
    mockPrisma.daemonConnection.updateMany.mockRejectedValue(new Error("db down"));
    await expect(markDisconnected(companyUuid, handle)).resolves.toBeUndefined();
    expect(mockLogger.error).toHaveBeenCalledTimes(1);
  });
});

// ===== touchConnection =====
describe("touchConnection", () => {
  it("bumps lastSeenAt and ensures status=online, fenced by companyUuid + uuid + connectedAt", async () => {
    mockPrisma.daemonConnection.updateMany.mockResolvedValue({ count: 1 });
    await touchConnection(companyUuid, handle);
    expect(mockPrisma.daemonConnection.updateMany).toHaveBeenCalledTimes(1);
    const arg = mockPrisma.daemonConnection.updateMany.mock.calls[0][0];
    expect(arg.where).toEqual({ uuid: connectionUuid, companyUuid, connectedAt });
    expect(arg.data.status).toBe("online");
    expect(arg.data.lastSeenAt).toBeInstanceOf(Date);
  });

  it("matches 0 rows (no-op) when a newer generation has refreshed connectedAt", async () => {
    mockPrisma.daemonConnection.updateMany.mockResolvedValue({ count: 0 });
    await expect(touchConnection(companyUuid, handle)).resolves.toBeUndefined();
    expect(mockLogger.error).not.toHaveBeenCalled();
  });

  it("swallows + logs a persistence error (never throws)", async () => {
    mockPrisma.daemonConnection.updateMany.mockRejectedValue(new Error("db down"));
    await expect(touchConnection(companyUuid, handle)).resolves.toBeUndefined();
    expect(mockLogger.error).toHaveBeenCalledTimes(1);
  });
});

// ===== Read projection (listConnectionsForOwner / listConnectionsForAgent) =====

// Pin "now" so the staleness boundary is deterministic. Date.now() in the
// mapper is driven by the faked clock.
const NOW = new Date("2026-06-15T04:00:00.000Z");
const ownerUuid = "owner-0000-0000-0000-000000000001";

// Build a DaemonConnection row fixture, dating lastSeenAt `agoMs` before NOW.
// The `agent` relation is included by default (matches the production query's
// `include: { agent: { select: { name: true } } }`). Pass `agent: null` to
// simulate a row whose related agent could not be resolved.
function makeRow(
  overrides: {
    uuid?: string;
    status?: string;
    agoMs?: number; // how long before NOW lastSeenAt was
    startedAt?: Date | null;
    clientVersion?: string | null;
    host?: string;
    disconnectedAt?: Date | null;
    agent?: { name: string } | null;
  } = {},
) {
  const agoMs = overrides.agoMs ?? 0;
  return {
    uuid: overrides.uuid ?? connectionUuid,
    agentUuid,
    clientType: "claude_code",
    // Use `in` (not `??`) for the nullable fields so an explicit null override
    // is honored rather than falling through to the default.
    clientVersion: "clientVersion" in overrides ? overrides.clientVersion : "0.11.0",
    host: overrides.host ?? "mac.local",
    startedAt:
      "startedAt" in overrides ? overrides.startedAt : new Date("2026-06-15T03:00:00.000Z"),
    status: overrides.status ?? "online",
    connectedAt: new Date("2026-06-15T03:30:00.000Z"),
    lastSeenAt: new Date(NOW.getTime() - agoMs),
    disconnectedAt: "disconnectedAt" in overrides ? overrides.disconnectedAt : null,
    agent: "agent" in overrides ? overrides.agent : { name: "Build Agent" },
  };
}

describe("listConnectionsForOwner", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  it("filters by companyUuid + agent.ownerUuid, joins the agent's display name, and maps rows to ConnectionView", async () => {
    mockPrisma.daemonConnection.findMany.mockResolvedValue([makeRow()]);

    const result = await listConnectionsForOwner(companyUuid, ownerUuid);

    expect(mockPrisma.daemonConnection.findMany).toHaveBeenCalledTimes(1);
    // The `include` is what carries Agent.name into the projection — without it
    // agentName would silently project null for every connection.
    expect(mockPrisma.daemonConnection.findMany.mock.calls[0][0]).toEqual({
      where: { companyUuid, agent: { ownerUuid } },
      include: { agent: { select: { name: true } } },
    });
    expect(result).toHaveLength(1);
    const view = result[0];
    // Full projection shape, with timestamps mapped to ISO strings.
    expect(view).toEqual({
      uuid: connectionUuid,
      agentUuid,
      agentName: "Build Agent",
      clientType: "claude_code",
      clientVersion: "0.11.0",
      host: "mac.local",
      startedAt: "2026-06-15T03:00:00.000Z",
      status: "online",
      effectiveStatus: "online",
      connectedAt: "2026-06-15T03:30:00.000Z",
      lastSeenAt: "2026-06-15T04:00:00.000Z",
      disconnectedAt: null,
    });
  });

  it("maps null startedAt / clientVersion / disconnectedAt through as null", async () => {
    mockPrisma.daemonConnection.findMany.mockResolvedValue([
      makeRow({ startedAt: null, clientVersion: null, disconnectedAt: null, host: "" }),
    ]);
    const [view] = await listConnectionsForOwner(companyUuid, ownerUuid);
    expect(view.startedAt).toBeNull();
    expect(view.clientVersion).toBeNull();
    expect(view.disconnectedAt).toBeNull();
    expect(view.host).toBe("");
  });

  it("projects agentName: null (not throw) when the agent relation cannot be resolved", async () => {
    // Should not happen in practice given onDelete: Cascade, but the mapper
    // is belt-and-suspenders so a missing relation never crashes the read path.
    mockPrisma.daemonConnection.findMany.mockResolvedValue([makeRow({ agent: null })]);
    const [view] = await listConnectionsForOwner(companyUuid, ownerUuid);
    expect(view.agentName).toBeNull();
    // Other fields still project correctly.
    expect(view.uuid).toBe(connectionUuid);
    expect(view.agentUuid).toBe(agentUuid);
  });

  it("returns an empty array when there are genuinely no rows", async () => {
    mockPrisma.daemonConnection.findMany.mockResolvedValue([]);
    await expect(listConnectionsForOwner(companyUuid, ownerUuid)).resolves.toEqual([]);
  });

  it("PROPAGATES a query error (does NOT swallow to [] like the write functions)", async () => {
    mockPrisma.daemonConnection.findMany.mockRejectedValue(new Error("db down"));
    await expect(listConnectionsForOwner(companyUuid, ownerUuid)).rejects.toThrow("db down");
    // Crucially, no swallow-and-log: the read path surfaces the error.
    expect(mockLogger.error).not.toHaveBeenCalled();
  });
});

describe("listConnectionsForAgent", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  it("filters by companyUuid + agentUuid, joins the agent's display name, and maps rows to ConnectionView", async () => {
    mockPrisma.daemonConnection.findMany.mockResolvedValue([makeRow()]);

    const result = await listConnectionsForAgent(companyUuid, agentUuid);

    expect(mockPrisma.daemonConnection.findMany).toHaveBeenCalledTimes(1);
    // Same `include` as the owner-scoped query so agent-self callers see
    // agentName too — uniform projection across both scopes.
    expect(mockPrisma.daemonConnection.findMany.mock.calls[0][0]).toEqual({
      where: { companyUuid, agentUuid },
      include: { agent: { select: { name: true } } },
    });
    expect(result).toHaveLength(1);
    expect(result[0].uuid).toBe(connectionUuid);
    expect(result[0].agentName).toBe("Build Agent");
    expect(result[0].effectiveStatus).toBe("online");
  });

  it("projects agentName: null (not throw) when the agent relation cannot be resolved", async () => {
    mockPrisma.daemonConnection.findMany.mockResolvedValue([makeRow({ agent: null })]);
    const [view] = await listConnectionsForAgent(companyUuid, agentUuid);
    expect(view.agentName).toBeNull();
  });

  it("PROPAGATES a query error (does NOT swallow to [])", async () => {
    mockPrisma.daemonConnection.findMany.mockRejectedValue(new Error("db down"));
    await expect(listConnectionsForAgent(companyUuid, agentUuid)).rejects.toThrow("db down");
    expect(mockLogger.error).not.toHaveBeenCalled();
  });
});

describe("effectiveStatus derivation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  it("online + fresh (lastSeenAt within threshold) → online", async () => {
    mockPrisma.daemonConnection.findMany.mockResolvedValue([
      makeRow({ status: "online", agoMs: STALE_THRESHOLD_MS - 1 }),
    ]);
    const [view] = await listConnectionsForOwner(companyUuid, ownerUuid);
    expect(view.effectiveStatus).toBe("online");
  });

  it("online + stale (lastSeenAt older than threshold) → offline", async () => {
    mockPrisma.daemonConnection.findMany.mockResolvedValue([
      makeRow({ status: "online", agoMs: STALE_THRESHOLD_MS + 1 }),
    ]);
    const [view] = await listConnectionsForOwner(companyUuid, ownerUuid);
    expect(view.effectiveStatus).toBe("offline");
    // raw status is still passed through unchanged
    expect(view.status).toBe("online");
  });

  it("online + exactly at the threshold → online (inclusive boundary)", async () => {
    mockPrisma.daemonConnection.findMany.mockResolvedValue([
      makeRow({ status: "online", agoMs: STALE_THRESHOLD_MS }),
    ]);
    const [view] = await listConnectionsForOwner(companyUuid, ownerUuid);
    expect(view.effectiveStatus).toBe("online");
  });

  it("online + one ms over the threshold → offline (just-over boundary)", async () => {
    mockPrisma.daemonConnection.findMany.mockResolvedValue([
      makeRow({ status: "online", agoMs: STALE_THRESHOLD_MS + 1 }),
    ]);
    const [view] = await listConnectionsForOwner(companyUuid, ownerUuid);
    expect(view.effectiveStatus).toBe("offline");
  });

  it("offline → offline regardless of a fresh lastSeenAt", async () => {
    mockPrisma.daemonConnection.findMany.mockResolvedValue([
      makeRow({ status: "offline", agoMs: 0 }),
    ]);
    const [view] = await listConnectionsForOwner(companyUuid, ownerUuid);
    expect(view.effectiveStatus).toBe("offline");
  });
});

describe("ordering", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  it("sorts online-first, then lastSeenAt desc", async () => {
    // Build rows out of final order:
    //  - offlineOld:  offline, lastSeenAt 1h ago
    //  - onlineOld:   online + fresh, lastSeenAt 60s ago
    //  - onlineNew:   online + fresh, lastSeenAt now
    //  - offlineNew:  offline, lastSeenAt 30s ago
    mockPrisma.daemonConnection.findMany.mockResolvedValue([
      makeRow({ uuid: "offline-old", status: "offline", agoMs: 60 * 60 * 1000 }),
      makeRow({ uuid: "online-old", status: "online", agoMs: 60_000 }),
      makeRow({ uuid: "online-new", status: "online", agoMs: 0 }),
      makeRow({ uuid: "offline-new", status: "offline", agoMs: 30_000 }),
    ]);

    const result = await listConnectionsForOwner(companyUuid, ownerUuid);

    // Online (newest lastSeenAt first), then offline (newest lastSeenAt first).
    expect(result.map((v) => v.uuid)).toEqual([
      "online-new",
      "online-old",
      "offline-new",
      "offline-old",
    ]);
    expect(result.map((v) => v.effectiveStatus)).toEqual([
      "online",
      "online",
      "offline",
      "offline",
    ]);
  });

  it("treats a stale online row as offline for ordering purposes", async () => {
    // A status=online but stale row must sort with the offline group, since
    // ordering keys on effectiveStatus, not the raw status.
    mockPrisma.daemonConnection.findMany.mockResolvedValue([
      makeRow({ uuid: "stale-online", status: "online", agoMs: STALE_THRESHOLD_MS + 1 }),
      makeRow({ uuid: "fresh-online", status: "online", agoMs: 0 }),
    ]);
    const result = await listConnectionsForOwner(companyUuid, ownerUuid);
    expect(result.map((v) => v.uuid)).toEqual(["fresh-online", "stale-online"]);
    expect(result.map((v) => v.effectiveStatus)).toEqual(["online", "offline"]);
  });
});
