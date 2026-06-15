import { describe, it, expect, vi, beforeEach } from "vitest";

// ===== Prisma mock =====
const mockPrisma = vi.hoisted(() => ({
  daemonConnection: {
    upsert: vi.fn(),
    updateMany: vi.fn(),
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
  type SelfReport,
} from "@/services/daemon-connection.service";

// ===== Helpers =====
const companyUuid = "company-0000-0000-0000-000000000001";
const agentUuid = "agent-0000-0000-0000-000000000001";
const connectionUuid = "conn-0000-0000-0000-000000000001";

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
  it("writes an online row for a daemon clientType and returns its uuid", async () => {
    mockPrisma.daemonConnection.upsert.mockResolvedValue({ uuid: connectionUuid });
    const report: SelfReport = {
      clientType: "claude_code",
      clientVersion: "0.11.0",
      host: "mac.local",
      startedAt: new Date("2026-06-15T03:00:00.000Z"),
    };

    const result = await registerConnection(companyUuid, agentUuid, report);

    expect(result).toBe(connectionUuid);
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
    // update branch flips back to online + clears disconnectedAt
    expect(arg.update.status).toBe("online");
    expect(arg.update.disconnectedAt).toBeNull();
    expect(arg.update.companyUuid).toBe(companyUuid);
  });

  it("registers an openclaw clientType", async () => {
    mockPrisma.daemonConnection.upsert.mockResolvedValue({ uuid: connectionUuid });
    const result = await registerConnection(companyUuid, agentUuid, {
      clientType: "openclaw",
      host: "linux-box",
    });
    expect(result).toBe(connectionUuid);
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
    mockPrisma.daemonConnection.upsert.mockResolvedValue({ uuid: connectionUuid });
    const report: SelfReport = { clientType: "claude_code", host: "mac.local" };

    const first = await registerConnection(companyUuid, agentUuid, report);
    const second = await registerConnection(companyUuid, agentUuid, report);

    expect(first).toBe(connectionUuid);
    expect(second).toBe(connectionUuid);
    // Two upsert calls, both keyed on the same composite — never .create.
    expect(mockPrisma.daemonConnection.upsert).toHaveBeenCalledTimes(2);
    const firstWhere = mockPrisma.daemonConnection.upsert.mock.calls[0][0].where;
    const secondWhere = mockPrisma.daemonConnection.upsert.mock.calls[1][0].where;
    expect(firstWhere).toEqual(secondWhere);
  });

  it("defaults a missing host to '' so the composite key stays deterministic", async () => {
    mockPrisma.daemonConnection.upsert.mockResolvedValue({ uuid: connectionUuid });
    await registerConnection(companyUuid, agentUuid, { clientType: "claude_code" });
    const arg = mockPrisma.daemonConnection.upsert.mock.calls[0][0];
    expect(arg.where.agentUuid_clientType_host.host).toBe("");
    expect(arg.create.host).toBe("");
  });

  it("coerces missing clientVersion/startedAt to null", async () => {
    mockPrisma.daemonConnection.upsert.mockResolvedValue({ uuid: connectionUuid });
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
  it("sets status=offline + disconnectedAt, scoped by companyUuid + uuid", async () => {
    mockPrisma.daemonConnection.updateMany.mockResolvedValue({ count: 1 });
    await markDisconnected(companyUuid, connectionUuid);
    expect(mockPrisma.daemonConnection.updateMany).toHaveBeenCalledTimes(1);
    const arg = mockPrisma.daemonConnection.updateMany.mock.calls[0][0];
    expect(arg.where).toEqual({ uuid: connectionUuid, companyUuid });
    expect(arg.data.status).toBe("offline");
    expect(arg.data.disconnectedAt).toBeInstanceOf(Date);
  });

  it("swallows + logs a persistence error (never throws)", async () => {
    mockPrisma.daemonConnection.updateMany.mockRejectedValue(new Error("db down"));
    await expect(markDisconnected(companyUuid, connectionUuid)).resolves.toBeUndefined();
    expect(mockLogger.error).toHaveBeenCalledTimes(1);
  });
});

// ===== touchConnection =====
describe("touchConnection", () => {
  it("bumps lastSeenAt and ensures status=online, scoped by companyUuid + uuid", async () => {
    mockPrisma.daemonConnection.updateMany.mockResolvedValue({ count: 1 });
    await touchConnection(companyUuid, connectionUuid);
    expect(mockPrisma.daemonConnection.updateMany).toHaveBeenCalledTimes(1);
    const arg = mockPrisma.daemonConnection.updateMany.mock.calls[0][0];
    expect(arg.where).toEqual({ uuid: connectionUuid, companyUuid });
    expect(arg.data.status).toBe("online");
    expect(arg.data.lastSeenAt).toBeInstanceOf(Date);
  });

  it("swallows + logs a persistence error (never throws)", async () => {
    mockPrisma.daemonConnection.updateMany.mockRejectedValue(new Error("db down"));
    await expect(touchConnection(companyUuid, connectionUuid)).resolves.toBeUndefined();
    expect(mockLogger.error).toHaveBeenCalledTimes(1);
  });
});
