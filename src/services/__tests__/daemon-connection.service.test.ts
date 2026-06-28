import { describe, it, expect, vi, beforeEach } from "vitest";

// ===== Prisma mock =====
const mockPrisma = vi.hoisted(() => ({
  daemonConnection: {
    upsert: vi.fn(),
    updateMany: vi.fn(),
    findMany: vi.fn(),
    // The null-cwd (old-daemon) compatibility path does not use upsert (Prisma
    // cannot target a NULL compound-key field); it does findFirst → update/create.
    findFirst: vi.fn(),
    update: vi.fn(),
    create: vi.fn(),
  },
  // The durable AgentInstance materialized/reused alongside each connection in the
  // SAME registerConnection write path. Same two-path shape as the connection upsert
  // (compound-key upsert for a real cwd; findFirst→create/update for the NULL-cwd
  // old-daemon path), plus findMany for the InstancePicker list.
  agentInstance: {
    upsert: vi.fn(),
    findFirst: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    findMany: vi.fn(),
  },
}));
vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));

// Stable instance uuid the AgentInstance upsert resolves to by default, so the
// connection-focused registerConnection tests below need not re-stub it each time.
const instanceUuid = "inst-0000-0000-0000-000000000001";

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
  resolveInstanceByTuple,
  resolveInstanceForConnection,
  listInstancesForAgent,
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
  // Default AgentInstance resolutions so the connection-focused registerConnection
  // tests (which only assert connection behavior) don't have to stub the instance
  // upsert. The instance-specific tests below override these as needed.
  //  - real-cwd path → compound-key upsert returns the stable instance uuid
  //  - null-cwd path → findFirst yields an existing instance (reuse, no create)
  mockPrisma.agentInstance.upsert.mockResolvedValue({ uuid: instanceUuid });
  mockPrisma.agentInstance.findFirst.mockResolvedValue({ uuid: instanceUuid });
  mockPrisma.agentInstance.create.mockResolvedValue({ uuid: instanceUuid });
  mockPrisma.agentInstance.update.mockResolvedValue({ uuid: instanceUuid });
});

// ===== Constants =====
describe("constants", () => {
  it("DAEMON_CLIENT_TYPES are claude_code + openclaw + codex", () => {
    expect(DAEMON_CLIENT_TYPES).toEqual(["claude_code", "openclaw", "codex"]);
  });

  it("STALE_THRESHOLD_MS is 90s (3x the 30s heartbeat)", () => {
    expect(STALE_THRESHOLD_MS).toBe(90_000);
    expect(STALE_THRESHOLD_MS).toBe(3 * 30_000);
  });
});

// ===== parseSelfReport =====
describe("parseSelfReport", () => {
  it("parses all params including cwd and a valid ISO-8601 startedAt", () => {
    const params = new URLSearchParams({
      clientType: "claude_code",
      clientVersion: "0.11.0",
      host: "mac.local",
      cwd: "/Users/me/projects/alpha",
      startedAt: "2026-06-15T03:00:00.000Z",
    });
    const report = parseSelfReport(params);
    expect(report.clientType).toBe("claude_code");
    expect(report.clientVersion).toBe("0.11.0");
    expect(report.host).toBe("mac.local");
    expect(report.cwd).toBe("/Users/me/projects/alpha");
    expect(report.startedAt).toBeInstanceOf(Date);
    expect(report.startedAt?.toISOString()).toBe("2026-06-15T03:00:00.000Z");
  });

  it("defaults missing string params: clientType='' and nullable fields null (cwd→null for an old daemon)", () => {
    const report = parseSelfReport(new URLSearchParams());
    expect(report.clientType).toBe("");
    expect(report.clientVersion).toBeNull();
    expect(report.host).toBeNull();
    // HARD-1: a daemon that does not report cwd → cwd:null (NOT ""). This is the
    // single representation of "unknown cwd".
    expect(report.cwd).toBeNull();
    expect(report.startedAt).toBeNull();
  });

  it("parses cwd independently of host (a cwd with no host is honored)", () => {
    const report = parseSelfReport(
      new URLSearchParams({ clientType: "claude_code", cwd: "/srv/work" }),
    );
    expect(report.host).toBeNull();
    expect(report.cwd).toBe("/srv/work");
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
//
// Two write paths to cover (Module Contract 3 — both upsert paths):
//   - cwd PRESENT (current daemon) → a single compound-key `upsert` carrying the
//     REAL cwd. This is what supersedes T1's `cwd=""` shim.
//   - cwd NULL (old daemon, HARD-1) → findFirst → update/create (NOT upsert),
//     because Prisma can't target NULL in the compound-unique where.
describe("registerConnection", () => {
  describe("cwd present (current daemon) → compound-key upsert on the REAL cwd", () => {
    it("writes an online row keyed on (agent, clientType, host, cwd) and returns a {uuid, connectedAt} handle", async () => {
      mockPrisma.daemonConnection.upsert.mockResolvedValue({ uuid: connectionUuid, connectedAt });
      const report: SelfReport = {
        clientType: "claude_code",
        clientVersion: "0.11.0",
        host: "mac.local",
        cwd: "/Users/me/projects/alpha",
        startedAt: new Date("2026-06-15T03:00:00.000Z"),
      };

      const result = await registerConnection(companyUuid, agentUuid, report);

      expect(result).toEqual({ uuid: connectionUuid, connectedAt });
      // The null-compat path must NOT be taken for a present cwd.
      expect(mockPrisma.daemonConnection.findFirst).not.toHaveBeenCalled();
      expect(mockPrisma.daemonConnection.upsert).toHaveBeenCalledTimes(1);
      const arg = mockPrisma.daemonConnection.upsert.mock.calls[0][0];
      // The composite unique key now carries the REAL cwd (no more "" shim).
      expect(arg.where).toEqual({
        agentUuid_clientType_host_cwd: {
          agentUuid,
          clientType: "claude_code",
          host: "mac.local",
          cwd: "/Users/me/projects/alpha",
        },
      });
      expect(arg.create.cwd).toBe("/Users/me/projects/alpha");
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
      // The SAME write path materialized + linked the durable AgentInstance: the
      // connection's create AND refresh data both carry the resolved instance uuid.
      expect(arg.create.agentInstanceUuid).toBe(instanceUuid);
      expect(arg.update.agentInstanceUuid).toBe(instanceUuid);
    });

    it("registers an openclaw clientType", async () => {
      mockPrisma.daemonConnection.upsert.mockResolvedValue({ uuid: connectionUuid, connectedAt });
      const result = await registerConnection(companyUuid, agentUuid, {
        clientType: "openclaw",
        host: "linux-box",
        cwd: "/srv/work",
      });
      expect(result).toEqual({ uuid: connectionUuid, connectedAt });
      expect(mockPrisma.daemonConnection.upsert).toHaveBeenCalledTimes(1);
    });

    it("registers a codex clientType (codex daemon backend)", async () => {
      mockPrisma.daemonConnection.upsert.mockResolvedValue({ uuid: connectionUuid, connectedAt });
      const result = await registerConnection(companyUuid, agentUuid, {
        clientType: "codex",
        host: "linux-box",
        cwd: "/srv/work",
      });
      expect(result).toEqual({ uuid: connectionUuid, connectedAt });
      expect(mockPrisma.daemonConnection.upsert).toHaveBeenCalledTimes(1);
    });

    it("upserts the same composite key on reconnect rather than inserting", async () => {
      mockPrisma.daemonConnection.upsert.mockResolvedValue({ uuid: connectionUuid, connectedAt });
      const report: SelfReport = {
        clientType: "claude_code",
        host: "mac.local",
        cwd: "/w",
      };

      const first = await registerConnection(companyUuid, agentUuid, report);
      const second = await registerConnection(companyUuid, agentUuid, report);

      expect(first).toEqual({ uuid: connectionUuid, connectedAt });
      expect(second).toEqual({ uuid: connectionUuid, connectedAt });
      // Two upsert calls, both keyed on the same composite — never .create.
      expect(mockPrisma.daemonConnection.upsert).toHaveBeenCalledTimes(2);
      expect(mockPrisma.daemonConnection.create).not.toHaveBeenCalled();
      const firstWhere = mockPrisma.daemonConnection.upsert.mock.calls[0][0].where;
      const secondWhere = mockPrisma.daemonConnection.upsert.mock.calls[1][0].where;
      expect(firstWhere).toEqual(secondWhere);
    });

    it("the SAME agent+host with two DIFFERENT cwds upserts two DISTINCT composite keys (overwrite-bug fix)", async () => {
      mockPrisma.daemonConnection.upsert
        .mockResolvedValueOnce({ uuid: "conn-cwd-a", connectedAt })
        .mockResolvedValueOnce({ uuid: "conn-cwd-b", connectedAt });

      const a = await registerConnection(companyUuid, agentUuid, {
        clientType: "claude_code",
        host: "mac.local",
        cwd: "/work/a",
      });
      const b = await registerConnection(companyUuid, agentUuid, {
        clientType: "claude_code",
        host: "mac.local",
        cwd: "/work/b",
      });

      expect(a?.uuid).toBe("conn-cwd-a");
      expect(b?.uuid).toBe("conn-cwd-b");
      const whereA = mockPrisma.daemonConnection.upsert.mock.calls[0][0].where
        .agentUuid_clientType_host_cwd;
      const whereB = mockPrisma.daemonConnection.upsert.mock.calls[1][0].where
        .agentUuid_clientType_host_cwd;
      // Same agent + same host, but the cwd differs → the keys are NOT equal, so
      // they target different rows (no overwrite). The real DB-level proof of two
      // independent rows lives in the integration test.
      expect(whereA.host).toBe(whereB.host);
      expect(whereA.agentUuid).toBe(whereB.agentUuid);
      expect(whereA.cwd).toBe("/work/a");
      expect(whereB.cwd).toBe("/work/b");
      expect(whereA).not.toEqual(whereB);
    });

    it("defaults a missing host to '' so the composite key stays deterministic", async () => {
      mockPrisma.daemonConnection.upsert.mockResolvedValue({ uuid: connectionUuid, connectedAt });
      await registerConnection(companyUuid, agentUuid, { clientType: "claude_code", cwd: "/w" });
      const arg = mockPrisma.daemonConnection.upsert.mock.calls[0][0];
      expect(arg.where.agentUuid_clientType_host_cwd.host).toBe("");
      expect(arg.create.host).toBe("");
    });

    it("coerces missing clientVersion/startedAt to null", async () => {
      mockPrisma.daemonConnection.upsert.mockResolvedValue({ uuid: connectionUuid, connectedAt });
      await registerConnection(companyUuid, agentUuid, {
        clientType: "claude_code",
        host: "h",
        cwd: "/w",
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
        cwd: "/w",
      });
      expect(result).toBeNull();
      expect(mockLogger.error).toHaveBeenCalledTimes(1);
    });
  });

  describe("cwd null (old daemon, HARD-1) → findFirst then update/create, NOT upsert", () => {
    it("creates a cwd=null row on first connect (no existing null row)", async () => {
      mockPrisma.daemonConnection.findFirst.mockResolvedValue(null);
      mockPrisma.daemonConnection.create.mockResolvedValue({ uuid: connectionUuid, connectedAt });

      // No cwd in the report → an old daemon. Must NOT throw / reject.
      const result = await registerConnection(companyUuid, agentUuid, {
        clientType: "claude_code",
        host: "mac.local",
      });

      expect(result).toEqual({ uuid: connectionUuid, connectedAt });
      // The compound-key upsert must NOT be used for the NULL cwd path.
      expect(mockPrisma.daemonConnection.upsert).not.toHaveBeenCalled();
      // Looked for an existing null row keyed on (agent, clientType, host, cwd:null).
      expect(mockPrisma.daemonConnection.findFirst).toHaveBeenCalledTimes(1);
      expect(mockPrisma.daemonConnection.findFirst.mock.calls[0][0].where).toEqual({
        agentUuid,
        clientType: "claude_code",
        host: "mac.local",
        cwd: null,
      });
      // Then created exactly one row with cwd:null.
      expect(mockPrisma.daemonConnection.create).toHaveBeenCalledTimes(1);
      const createArg = mockPrisma.daemonConnection.create.mock.calls[0][0];
      expect(createArg.data.cwd).toBeNull();
      expect(createArg.data.status).toBe("online");
      expect(createArg.data.companyUuid).toBe(companyUuid);
    });

    it("REUSES the existing cwd=null row on reconnect (update by uuid) — no null-row pileup", async () => {
      mockPrisma.daemonConnection.findFirst.mockResolvedValue({ uuid: connectionUuid });
      mockPrisma.daemonConnection.update.mockResolvedValue({ uuid: connectionUuid, connectedAt });

      const result = await registerConnection(companyUuid, agentUuid, {
        clientType: "claude_code",
        host: "mac.local",
      });

      expect(result).toEqual({ uuid: connectionUuid, connectedAt });
      expect(mockPrisma.daemonConnection.upsert).not.toHaveBeenCalled();
      // Crucially: it UPDATEs the found row by uuid — it does NOT create a second
      // null row. This is the anti-pileup guarantee.
      expect(mockPrisma.daemonConnection.create).not.toHaveBeenCalled();
      expect(mockPrisma.daemonConnection.update).toHaveBeenCalledTimes(1);
      const updateArg = mockPrisma.daemonConnection.update.mock.calls[0][0];
      expect(updateArg.where).toEqual({ uuid: connectionUuid });
      expect(updateArg.data.status).toBe("online");
      expect(updateArg.data.disconnectedAt).toBeNull();
      expect(updateArg.data.connectedAt).toBeInstanceOf(Date);
    });

    it("treats an explicit cwd:null in the report the same as a missing cwd", async () => {
      mockPrisma.daemonConnection.findFirst.mockResolvedValue(null);
      mockPrisma.daemonConnection.create.mockResolvedValue({ uuid: connectionUuid, connectedAt });
      await registerConnection(companyUuid, agentUuid, {
        clientType: "claude_code",
        host: "mac.local",
        cwd: null,
      });
      expect(mockPrisma.daemonConnection.findFirst).toHaveBeenCalledTimes(1);
      expect(mockPrisma.daemonConnection.upsert).not.toHaveBeenCalled();
    });

    it("swallows + logs a persistence error on the null path and returns null (never throws)", async () => {
      mockPrisma.daemonConnection.findFirst.mockRejectedValue(new Error("db down"));
      const result = await registerConnection(companyUuid, agentUuid, {
        clientType: "claude_code",
        host: "mac.local",
      });
      expect(result).toBeNull();
      expect(mockLogger.error).toHaveBeenCalledTimes(1);
    });
  });

  describe("clientType gating (no write at all)", () => {
    it("returns null and writes nothing for a non-daemon clientType (browser)", async () => {
      const result = await registerConnection(companyUuid, agentUuid, {
        clientType: "browser",
        host: "mac.local",
        cwd: "/w",
      });
      expect(result).toBeNull();
      expect(mockPrisma.daemonConnection.upsert).not.toHaveBeenCalled();
      expect(mockPrisma.daemonConnection.findFirst).not.toHaveBeenCalled();
      expect(mockPrisma.daemonConnection.create).not.toHaveBeenCalled();
    });

    it("returns null and writes nothing for an unrecognized clientType", async () => {
      const result = await registerConnection(companyUuid, agentUuid, {
        clientType: "something-else",
      });
      expect(result).toBeNull();
      expect(mockPrisma.daemonConnection.upsert).not.toHaveBeenCalled();
      expect(mockPrisma.daemonConnection.findFirst).not.toHaveBeenCalled();
    });

    it("returns null and writes nothing for an empty clientType", async () => {
      const result = await registerConnection(companyUuid, agentUuid, { clientType: "" });
      expect(result).toBeNull();
      expect(mockPrisma.daemonConnection.upsert).not.toHaveBeenCalled();
      expect(mockPrisma.daemonConnection.findFirst).not.toHaveBeenCalled();
      // A gated (non-daemon) clientType must not touch the instance table either.
      expect(mockPrisma.agentInstance.upsert).not.toHaveBeenCalled();
      expect(mockPrisma.agentInstance.findFirst).not.toHaveBeenCalled();
      expect(mockPrisma.agentInstance.create).not.toHaveBeenCalled();
    });
  });
});

// ===== AgentInstance materialization inside registerConnection =====
//
// AC#1: the SAME write path that upserts the connection ALSO upserts the
// AgentInstance for (companyUuid, agentUuid, host, cwd) and links the connection
// (agentInstanceUuid) to it. AC#2: a repeat report reuses the row (no duplicate)
// and the instance uuid is stable across reconnects even though the connection uuid
// churns. AC#3: the null-cwd path avoids the Postgres NULL-unique collision via
// findFirst → create/update.
describe("registerConnection → AgentInstance upsert + connection link", () => {
  describe("cwd present → compound-key AgentInstance upsert (new identity)", () => {
    it("AC#1: upserts the AgentInstance for (company, agent, host, cwd) and links the connection to its uuid", async () => {
      mockPrisma.agentInstance.upsert.mockResolvedValue({ uuid: instanceUuid });
      mockPrisma.daemonConnection.upsert.mockResolvedValue({ uuid: connectionUuid, connectedAt });

      const result = await registerConnection(companyUuid, agentUuid, {
        clientType: "claude_code",
        host: "mac.local",
        cwd: "/Users/me/projects/alpha",
      });

      expect(result).toEqual({ uuid: connectionUuid, connectedAt });
      // The instance is upserted on the compound identity key — NOT the null path.
      expect(mockPrisma.agentInstance.upsert).toHaveBeenCalledTimes(1);
      expect(mockPrisma.agentInstance.findFirst).not.toHaveBeenCalled();
      expect(mockPrisma.agentInstance.create).not.toHaveBeenCalled();
      const instArg = mockPrisma.agentInstance.upsert.mock.calls[0][0];
      expect(instArg.where).toEqual({
        companyUuid_agentUuid_host_cwd: {
          companyUuid,
          agentUuid,
          host: "mac.local",
          cwd: "/Users/me/projects/alpha",
        },
      });
      expect(instArg.create).toEqual({
        companyUuid,
        agentUuid,
        host: "mac.local",
        cwd: "/Users/me/projects/alpha",
      });
      // The connection write carries the resolved instance uuid in BOTH branches.
      const connArg = mockPrisma.daemonConnection.upsert.mock.calls[0][0];
      expect(connArg.create.agentInstanceUuid).toBe(instanceUuid);
      expect(connArg.update.agentInstanceUuid).toBe(instanceUuid);
    });

    it("defaults a missing host to '' in BOTH the connection and the instance key", async () => {
      mockPrisma.agentInstance.upsert.mockResolvedValue({ uuid: instanceUuid });
      mockPrisma.daemonConnection.upsert.mockResolvedValue({ uuid: connectionUuid, connectedAt });
      await registerConnection(companyUuid, agentUuid, { clientType: "claude_code", cwd: "/w" });
      const instArg = mockPrisma.agentInstance.upsert.mock.calls[0][0];
      expect(instArg.where.companyUuid_agentUuid_host_cwd.host).toBe("");
      expect(instArg.create.host).toBe("");
    });
  });

  describe("cwd present → AgentInstance reuse across repeat reports + reconnect (AC#2)", () => {
    it("a repeat report upserts the SAME instance key (reuse, no duplicate) and stays linked", async () => {
      mockPrisma.agentInstance.upsert.mockResolvedValue({ uuid: instanceUuid });
      mockPrisma.daemonConnection.upsert.mockResolvedValue({ uuid: connectionUuid, connectedAt });
      const report: SelfReport = { clientType: "claude_code", host: "mac.local", cwd: "/w" };

      await registerConnection(companyUuid, agentUuid, report);
      await registerConnection(companyUuid, agentUuid, report);

      // Upsert (not create) both times, keyed identically → DB reuses one row.
      expect(mockPrisma.agentInstance.upsert).toHaveBeenCalledTimes(2);
      expect(mockPrisma.agentInstance.create).not.toHaveBeenCalled();
      const firstKey = mockPrisma.agentInstance.upsert.mock.calls[0][0].where;
      const secondKey = mockPrisma.agentInstance.upsert.mock.calls[1][0].where;
      expect(firstKey).toEqual(secondKey);
    });

    it("AC#2: the instance uuid is STABLE across a reconnect even though the connection uuid changes", async () => {
      // Same identity, but the daemon reconnected → a brand-new connection uuid.
      // The AgentInstance upsert resolves the SAME uuid both times (durable identity).
      mockPrisma.agentInstance.upsert.mockResolvedValue({ uuid: instanceUuid });
      mockPrisma.daemonConnection.upsert
        .mockResolvedValueOnce({ uuid: "conn-gen-1", connectedAt })
        .mockResolvedValueOnce({ uuid: "conn-gen-2", connectedAt });
      const report: SelfReport = { clientType: "claude_code", host: "mac.local", cwd: "/w" };

      const first = await registerConnection(companyUuid, agentUuid, report);
      const second = await registerConnection(companyUuid, agentUuid, report);

      // Connection uuid churned…
      expect(first?.uuid).toBe("conn-gen-1");
      expect(second?.uuid).toBe("conn-gen-2");
      // …but BOTH connection writes linked to the SAME durable instance uuid.
      expect(mockPrisma.daemonConnection.upsert.mock.calls[0][0].create.agentInstanceUuid).toBe(
        instanceUuid,
      );
      expect(mockPrisma.daemonConnection.upsert.mock.calls[1][0].update.agentInstanceUuid).toBe(
        instanceUuid,
      );
    });
  });

  describe("cwd null (old daemon) → AgentInstance findFirst → create/update, NOT upsert (AC#3)", () => {
    it("creates a cwd=null instance on first connect (no existing null instance)", async () => {
      mockPrisma.agentInstance.findFirst.mockResolvedValue(null);
      mockPrisma.agentInstance.create.mockResolvedValue({ uuid: instanceUuid });
      // Old daemon also lands a null-cwd CONNECTION row via its own null path.
      mockPrisma.daemonConnection.findFirst.mockResolvedValue(null);
      mockPrisma.daemonConnection.create.mockResolvedValue({ uuid: connectionUuid, connectedAt });

      const result = await registerConnection(companyUuid, agentUuid, {
        clientType: "claude_code",
        host: "mac.local",
      });

      expect(result).toEqual({ uuid: connectionUuid, connectedAt });
      // The compound-key upsert must NOT be used for a NULL cwd (Postgres NULL-distinct).
      expect(mockPrisma.agentInstance.upsert).not.toHaveBeenCalled();
      // Looked for an existing null-cwd instance keyed on (company, agent, host, cwd:null).
      expect(mockPrisma.agentInstance.findFirst).toHaveBeenCalledTimes(1);
      expect(mockPrisma.agentInstance.findFirst.mock.calls[0][0].where).toEqual({
        companyUuid,
        agentUuid,
        host: "mac.local",
        cwd: null,
      });
      // Then created exactly one instance row with cwd:null.
      expect(mockPrisma.agentInstance.create).toHaveBeenCalledTimes(1);
      expect(mockPrisma.agentInstance.create.mock.calls[0][0].data).toEqual({
        companyUuid,
        agentUuid,
        host: "mac.local",
        cwd: null,
      });
      // And the null-cwd connection row was linked to the created instance.
      expect(mockPrisma.daemonConnection.create.mock.calls[0][0].data.agentInstanceUuid).toBe(
        instanceUuid,
      );
    });

    it("AC#3: REUSES the existing cwd=null instance on reconnect (no duplicate null instance)", async () => {
      mockPrisma.agentInstance.findFirst.mockResolvedValue({ uuid: instanceUuid });
      mockPrisma.agentInstance.update.mockResolvedValue({ uuid: instanceUuid });
      mockPrisma.daemonConnection.findFirst.mockResolvedValue({ uuid: connectionUuid });
      mockPrisma.daemonConnection.update.mockResolvedValue({ uuid: connectionUuid, connectedAt });

      const result = await registerConnection(companyUuid, agentUuid, {
        clientType: "claude_code",
        host: "mac.local",
      });

      expect(result).toEqual({ uuid: connectionUuid, connectedAt });
      // The anti-pileup guarantee: it UPDATEs the found instance by uuid (touch
      // updatedAt), it does NOT create a second null instance.
      expect(mockPrisma.agentInstance.create).not.toHaveBeenCalled();
      expect(mockPrisma.agentInstance.upsert).not.toHaveBeenCalled();
      expect(mockPrisma.agentInstance.update).toHaveBeenCalledTimes(1);
      expect(mockPrisma.agentInstance.update.mock.calls[0][0].where).toEqual({ uuid: instanceUuid });
      // The reconnecting null-cwd connection row is re-linked to the same instance.
      expect(mockPrisma.daemonConnection.update.mock.calls[0][0].data.agentInstanceUuid).toBe(
        instanceUuid,
      );
    });
  });

  describe("instance-link resilience (additive link never blocks registration)", () => {
    it("a failed instance upsert is swallowed + logged, and the connection STILL registers with a null link", async () => {
      // The additive-link contract: an AgentInstance-table failure must NOT abort the
      // connection registration. upsertAgentInstance swallows + logs and returns null;
      // the connection upsert then runs and lands the row with agentInstanceUuid:null.
      mockPrisma.agentInstance.upsert.mockRejectedValue(new Error("instance db down"));
      mockPrisma.daemonConnection.upsert.mockResolvedValue({ uuid: connectionUuid, connectedAt });

      const result = await registerConnection(companyUuid, agentUuid, {
        clientType: "claude_code",
        host: "mac.local",
        cwd: "/w",
      });

      // The connection registration SUCCEEDS — the instance failure did not block it.
      expect(result).toEqual({ uuid: connectionUuid, connectedAt });
      // The instance failure was logged exactly once (swallowed inside upsertAgentInstance).
      expect(mockLogger.error).toHaveBeenCalledTimes(1);
      // The connection write ran and degraded the link to null in BOTH branches.
      expect(mockPrisma.daemonConnection.upsert).toHaveBeenCalledTimes(1);
      const connArg = mockPrisma.daemonConnection.upsert.mock.calls[0][0];
      expect(connArg.create.agentInstanceUuid).toBeNull();
      expect(connArg.update.agentInstanceUuid).toBeNull();
    });

    it("a failed instance findFirst on the null-cwd path also degrades to a null link, connection still registers", async () => {
      // Same contract on the old-daemon (null-cwd) instance path.
      mockPrisma.agentInstance.findFirst.mockRejectedValue(new Error("instance db down"));
      mockPrisma.daemonConnection.findFirst.mockResolvedValue(null);
      mockPrisma.daemonConnection.create.mockResolvedValue({ uuid: connectionUuid, connectedAt });

      const result = await registerConnection(companyUuid, agentUuid, {
        clientType: "claude_code",
        host: "mac.local",
      });

      expect(result).toEqual({ uuid: connectionUuid, connectedAt });
      expect(mockLogger.error).toHaveBeenCalledTimes(1);
      // The null-cwd connection row was still created, with a null instance link.
      expect(mockPrisma.daemonConnection.create).toHaveBeenCalledTimes(1);
      expect(mockPrisma.daemonConnection.create.mock.calls[0][0].data.agentInstanceUuid).toBeNull();
    });
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
// `include: { agent: { select: { name: true, ownerUuid: true } } }`). Pass
// `agent: null` to simulate a row whose related agent could not be resolved.
function makeRow(
  overrides: {
    uuid?: string;
    status?: string;
    agoMs?: number; // how long before NOW lastSeenAt was
    startedAt?: Date | null;
    clientVersion?: string | null;
    host?: string;
    cwd?: string | null;
    disconnectedAt?: Date | null;
    agentInstanceUuid?: string | null;
    agent?: { name: string; ownerUuid: string | null } | null;
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
    cwd: "cwd" in overrides ? overrides.cwd : "/Users/me/projects/alpha",
    startedAt:
      "startedAt" in overrides ? overrides.startedAt : new Date("2026-06-15T03:00:00.000Z"),
    status: overrides.status ?? "online",
    connectedAt: new Date("2026-06-15T03:30:00.000Z"),
    lastSeenAt: new Date(NOW.getTime() - agoMs),
    disconnectedAt: "disconnectedAt" in overrides ? overrides.disconnectedAt : null,
    agentInstanceUuid:
      "agentInstanceUuid" in overrides ? overrides.agentInstanceUuid : instanceUuid,
    agent:
      "agent" in overrides
        ? overrides.agent
        : { name: "Build Agent", ownerUuid },
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
    // The `include` is what carries Agent.name + ownerUuid into the projection —
    // without it agentName/ownerUuid would silently project null for every
    // connection.
    expect(mockPrisma.daemonConnection.findMany.mock.calls[0][0]).toEqual({
      where: { companyUuid, agent: { ownerUuid } },
      include: { agent: { select: { name: true, ownerUuid: true } } },
    });
    expect(result).toHaveLength(1);
    const view = result[0];
    // Full projection shape, with timestamps mapped to ISO strings.
    expect(view).toEqual({
      uuid: connectionUuid,
      agentUuid,
      agentName: "Build Agent",
      ownerUuid,
      clientType: "claude_code",
      clientVersion: "0.11.0",
      host: "mac.local",
      cwd: "/Users/me/projects/alpha",
      startedAt: "2026-06-15T03:00:00.000Z",
      status: "online",
      effectiveStatus: "online",
      connectedAt: "2026-06-15T03:30:00.000Z",
      lastSeenAt: "2026-06-15T04:00:00.000Z",
      disconnectedAt: null,
      // The durable instance link is now part of the projection (additive).
      agentInstanceUuid: instanceUuid,
    });
  });

  it("maps null startedAt / clientVersion / disconnectedAt / cwd through as null (old daemon)", async () => {
    mockPrisma.daemonConnection.findMany.mockResolvedValue([
      makeRow({ startedAt: null, clientVersion: null, disconnectedAt: null, host: "", cwd: null }),
    ]);
    const [view] = await listConnectionsForOwner(companyUuid, ownerUuid);
    expect(view.startedAt).toBeNull();
    expect(view.clientVersion).toBeNull();
    expect(view.disconnectedAt).toBeNull();
    expect(view.host).toBe("");
    // An old daemon's null cwd projects through as null (not "").
    expect(view.cwd).toBeNull();
  });

  it("projects a non-null cwd through to the view (the new identity dimension is observable)", async () => {
    mockPrisma.daemonConnection.findMany.mockResolvedValue([makeRow({ cwd: "/work/beta" })]);
    const [view] = await listConnectionsForOwner(companyUuid, ownerUuid);
    expect(view.cwd).toBe("/work/beta");
  });

  it("projects agentName: null (not throw) when the agent relation cannot be resolved", async () => {
    // Should not happen in practice given onDelete: Cascade, but the mapper
    // is belt-and-suspenders so a missing relation never crashes the read path.
    mockPrisma.daemonConnection.findMany.mockResolvedValue([makeRow({ agent: null })]);
    const [view] = await listConnectionsForOwner(companyUuid, ownerUuid);
    expect(view.agentName).toBeNull();
    // ownerUuid likewise projects null (not throw) from an unresolved relation.
    expect(view.ownerUuid).toBeNull();
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
    // agentName + ownerUuid too — uniform projection across both scopes.
    expect(mockPrisma.daemonConnection.findMany.mock.calls[0][0]).toEqual({
      where: { companyUuid, agentUuid },
      include: { agent: { select: { name: true, ownerUuid: true } } },
    });
    expect(result).toHaveLength(1);
    expect(result[0].uuid).toBe(connectionUuid);
    expect(result[0].agentName).toBe("Build Agent");
    expect(result[0].ownerUuid).toBe(ownerUuid);
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

// ===== T3 — 派单选连接维度不变 (AC#5 / Module Contract 5) =====
// Dispatch selects a connection by AGENT + ONLINE status only (the chokepoint takes the
// FIRST online connection of the agent). Introducing multi-path (same agent, several cwd
// rows) and null-cwd (old daemon) rows must NOT make that selection miss, error, or
// collapse rows — and there is NO project→cwd inference. These tests model the exact read
// the dispatch chokepoint runs (listConnectionsForAgent, then first-online) and prove it
// behaves correctly across those new row shapes.
describe("T3 dispatch selection across multi-cwd + null-cwd connections", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  it("surfaces EVERY same-agent cwd row (multi-path does not collapse/miss connections)", async () => {
    mockPrisma.daemonConnection.findMany.mockResolvedValue([
      makeRow({ uuid: "conn-a", cwd: "/dev/repo-a", status: "online", agoMs: 0 }),
      makeRow({ uuid: "conn-b", cwd: "/dev/repo-b", status: "online", agoMs: 1000 }),
      makeRow({ uuid: "conn-null", cwd: null, status: "online", agoMs: 2000 }),
    ]);
    const result = await listConnectionsForAgent(companyUuid, agentUuid);
    // All three distinct connections are returned — none missed, none merged.
    expect(result.map((v) => v.uuid).sort()).toEqual(["conn-a", "conn-b", "conn-null"]);
    expect(result.map((v) => v.cwd).sort()).toEqual(["/dev/repo-a", "/dev/repo-b", null].sort());
    // The query dimension is unchanged — agent + company, NO cwd / project filter.
    expect(mockPrisma.daemonConnection.findMany.mock.calls[0][0].where).toEqual({
      companyUuid,
      agentUuid,
    });
  });

  it("the dispatch chokepoint's 'first online' selection is unaffected by cwd (online-first sort)", async () => {
    // One OFFLINE repo-a row + two ONLINE rows (repo-b, then null). The first-online pick
    // must land an ONLINE connection regardless of cwd — selection is by online status,
    // never by cwd or project.
    mockPrisma.daemonConnection.findMany.mockResolvedValue([
      makeRow({ uuid: "conn-a-offline", cwd: "/dev/repo-a", status: "offline", agoMs: 0 }),
      makeRow({ uuid: "conn-b-online", cwd: "/dev/repo-b", status: "online", agoMs: 5000 }),
      makeRow({ uuid: "conn-null-online", cwd: null, status: "online", agoMs: 1000 }),
    ]);
    const result = await listConnectionsForAgent(companyUuid, agentUuid);
    // The chokepoint does exactly this: take the first effectiveStatus==="online" entry.
    const origin = result.find((c) => c.effectiveStatus === "online");
    expect(origin).toBeTruthy();
    expect(origin!.effectiveStatus).toBe("online");
    // Online-first, then lastSeenAt desc: the freshest online (null-cwd, agoMs 1000) leads
    // the offline repo-a row — i.e. a null-cwd connection is fully selectable as origin.
    expect(origin!.uuid).toBe("conn-null-online");
  });

  it("a null-cwd (old daemon) connection is selectable as the sole online connection (HARD-1)", async () => {
    // Old daemon only: a single cwd=null online row. Dispatch must still select it.
    mockPrisma.daemonConnection.findMany.mockResolvedValue([
      makeRow({ uuid: "conn-old", cwd: null, status: "online", agoMs: 0 }),
    ]);
    const result = await listConnectionsForAgent(companyUuid, agentUuid);
    const origin = result.find((c) => c.effectiveStatus === "online");
    expect(origin?.uuid).toBe("conn-old");
    expect(origin?.cwd).toBeNull();
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

// ===== Instance resolvers (resolveInstanceByTuple / resolveInstanceForConnection) =====
//
// The wake path turns a pin's (host, cwd) — from a mention suffix or an
// agent_instance assignment — into the durable instance pointer. These resolvers
// are read functions: they PROPAGATE a query error (null/[] must mean "absent",
// never "the DB threw").
describe("resolveInstanceByTuple", () => {
  it("returns the instance uuid for a present-cwd tuple, normalizing a null host to ''", async () => {
    mockPrisma.agentInstance.findFirst.mockResolvedValue({ uuid: instanceUuid });
    const result = await resolveInstanceByTuple(companyUuid, agentUuid, null, "/work");
    expect(result).toBe(instanceUuid);
    // A null host is normalized to "" so the lookup key matches what registerConnection wrote.
    expect(mockPrisma.agentInstance.findFirst.mock.calls[0][0].where).toEqual({
      companyUuid,
      agentUuid,
      host: "",
      cwd: "/work",
    });
  });

  it("resolves a null-cwd tuple via findFirst with cwd:null (the NULL-distinct lookup)", async () => {
    mockPrisma.agentInstance.findFirst.mockResolvedValue({ uuid: instanceUuid });
    const result = await resolveInstanceByTuple(companyUuid, agentUuid, "mac.local", null);
    expect(result).toBe(instanceUuid);
    expect(mockPrisma.agentInstance.findFirst.mock.calls[0][0].where).toEqual({
      companyUuid,
      agentUuid,
      host: "mac.local",
      cwd: null,
    });
  });

  it("returns null when no instance matches the tuple", async () => {
    mockPrisma.agentInstance.findFirst.mockResolvedValue(null);
    await expect(
      resolveInstanceByTuple(companyUuid, agentUuid, "mac.local", "/work"),
    ).resolves.toBeNull();
  });

  it("PROPAGATES a query error (read rule — does not swallow)", async () => {
    mockPrisma.agentInstance.findFirst.mockRejectedValue(new Error("db down"));
    await expect(
      resolveInstanceByTuple(companyUuid, agentUuid, "mac.local", "/work"),
    ).rejects.toThrow("db down");
    expect(mockLogger.error).not.toHaveBeenCalled();
  });
});

describe("resolveInstanceForConnection", () => {
  it("returns the connection's linked agentInstanceUuid, scoped by companyUuid", async () => {
    mockPrisma.daemonConnection.findFirst.mockResolvedValue({ agentInstanceUuid: instanceUuid });
    const result = await resolveInstanceForConnection(companyUuid, connectionUuid);
    expect(result).toBe(instanceUuid);
    expect(mockPrisma.daemonConnection.findFirst.mock.calls[0][0]).toEqual({
      where: { uuid: connectionUuid, companyUuid },
      select: { agentInstanceUuid: true },
    });
  });

  it("returns null when the connection is not yet linked (pre-migration row)", async () => {
    mockPrisma.daemonConnection.findFirst.mockResolvedValue({ agentInstanceUuid: null });
    await expect(resolveInstanceForConnection(companyUuid, connectionUuid)).resolves.toBeNull();
  });

  it("returns null when the connection does not exist in this company", async () => {
    mockPrisma.daemonConnection.findFirst.mockResolvedValue(null);
    await expect(resolveInstanceForConnection(companyUuid, connectionUuid)).resolves.toBeNull();
  });

  it("PROPAGATES a query error (read rule)", async () => {
    mockPrisma.daemonConnection.findFirst.mockRejectedValue(new Error("db down"));
    await expect(resolveInstanceForConnection(companyUuid, connectionUuid)).rejects.toThrow(
      "db down",
    );
  });
});

// ===== listInstancesForAgent — online status DERIVED from linked connections =====
//
// AC#4: an instance is `online` iff ANY of its linked DaemonConnections is
// effectively online (status==="online" AND within STALE_THRESHOLD_MS). The
// instance row itself stores NO liveness (R5). This backs the InstancePicker's
// "online instances only" rule — the UI filters on `online`.
describe("listInstancesForAgent", () => {
  const NOW2 = new Date("2026-06-15T05:00:00.000Z");

  // Build an AgentInstance row fixture with its linked connections' liveness fields.
  function makeInstance(
    overrides: {
      uuid?: string;
      host?: string;
      cwd?: string | null;
      updatedAt?: Date;
      connections?: { status: string; agoMs: number }[];
    } = {},
  ) {
    return {
      uuid: overrides.uuid ?? instanceUuid,
      agentUuid,
      host: overrides.host ?? "mac.local",
      cwd: "cwd" in overrides ? overrides.cwd : "/work",
      createdAt: new Date("2026-06-15T04:00:00.000Z"),
      updatedAt: overrides.updatedAt ?? new Date("2026-06-15T04:30:00.000Z"),
      connections: (overrides.connections ?? []).map((c) => ({
        status: c.status,
        lastSeenAt: new Date(NOW2.getTime() - c.agoMs),
      })),
    };
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW2);
  });

  it("queries by company + agent and pulls just the connections' liveness fields", async () => {
    mockPrisma.agentInstance.findMany.mockResolvedValue([
      makeInstance({ connections: [{ status: "online", agoMs: 0 }] }),
    ]);
    await listInstancesForAgent(companyUuid, agentUuid);
    expect(mockPrisma.agentInstance.findMany.mock.calls[0][0]).toEqual({
      where: { companyUuid, agentUuid },
      include: { connections: { select: { status: true, lastSeenAt: true } } },
    });
  });

  it("AC#4: derives online=true when ANY linked connection is online + fresh", async () => {
    mockPrisma.agentInstance.findMany.mockResolvedValue([
      makeInstance({
        uuid: "inst-online",
        connections: [
          { status: "offline", agoMs: 0 },
          { status: "online", agoMs: STALE_THRESHOLD_MS - 1 }, // fresh online
        ],
      }),
    ]);
    const [view] = await listInstancesForAgent(companyUuid, agentUuid);
    expect(view.online).toBe(true);
    expect(view).toEqual({
      uuid: "inst-online",
      agentUuid,
      host: "mac.local",
      cwd: "/work",
      online: true,
      createdAt: "2026-06-15T04:00:00.000Z",
      updatedAt: "2026-06-15T04:30:00.000Z",
    });
  });

  it("derives online=false when the only connection is stale (older than threshold)", async () => {
    mockPrisma.agentInstance.findMany.mockResolvedValue([
      makeInstance({ connections: [{ status: "online", agoMs: STALE_THRESHOLD_MS + 1 }] }),
    ]);
    const [view] = await listInstancesForAgent(companyUuid, agentUuid);
    expect(view.online).toBe(false);
  });

  it("treats the staleness boundary as inclusive (exactly at threshold → online)", async () => {
    mockPrisma.agentInstance.findMany.mockResolvedValue([
      makeInstance({ connections: [{ status: "online", agoMs: STALE_THRESHOLD_MS }] }),
    ]);
    const [view] = await listInstancesForAgent(companyUuid, agentUuid);
    expect(view.online).toBe(true);
  });

  it("derives online=false for an instance with no linked connections (never blocks)", async () => {
    mockPrisma.agentInstance.findMany.mockResolvedValue([makeInstance({ connections: [] })]);
    const [view] = await listInstancesForAgent(companyUuid, agentUuid);
    expect(view.online).toBe(false);
  });

  it("derives online=false when a fresh connection's raw status is offline", async () => {
    mockPrisma.agentInstance.findMany.mockResolvedValue([
      makeInstance({ connections: [{ status: "offline", agoMs: 0 }] }),
    ]);
    const [view] = await listInstancesForAgent(companyUuid, agentUuid);
    expect(view.online).toBe(false);
  });

  it("projects a null-cwd instance through with cwd:null", async () => {
    mockPrisma.agentInstance.findMany.mockResolvedValue([
      makeInstance({ cwd: null, connections: [{ status: "online", agoMs: 0 }] }),
    ]);
    const [view] = await listInstancesForAgent(companyUuid, agentUuid);
    expect(view.cwd).toBeNull();
  });

  it("orders online-first, then updatedAt desc (the picker surfaces reachable instances first)", async () => {
    mockPrisma.agentInstance.findMany.mockResolvedValue([
      makeInstance({
        uuid: "offline-new",
        updatedAt: new Date("2026-06-15T04:59:00.000Z"),
        connections: [{ status: "offline", agoMs: 0 }],
      }),
      makeInstance({
        uuid: "online-old",
        updatedAt: new Date("2026-06-15T04:10:00.000Z"),
        connections: [{ status: "online", agoMs: 0 }],
      }),
      makeInstance({
        uuid: "online-new",
        updatedAt: new Date("2026-06-15T04:50:00.000Z"),
        connections: [{ status: "online", agoMs: 0 }],
      }),
    ]);
    const result = await listInstancesForAgent(companyUuid, agentUuid);
    expect(result.map((v) => v.uuid)).toEqual(["online-new", "online-old", "offline-new"]);
    expect(result.map((v) => v.online)).toEqual([true, true, false]);
  });

  it("returns an empty array when the agent has no instances", async () => {
    mockPrisma.agentInstance.findMany.mockResolvedValue([]);
    await expect(listInstancesForAgent(companyUuid, agentUuid)).resolves.toEqual([]);
  });

  it("PROPAGATES a query error (read rule — does not swallow to [])", async () => {
    mockPrisma.agentInstance.findMany.mockRejectedValue(new Error("db down"));
    await expect(listInstancesForAgent(companyUuid, agentUuid)).rejects.toThrow("db down");
    expect(mockLogger.error).not.toHaveBeenCalled();
  });
});
