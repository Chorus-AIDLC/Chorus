// src/services/__tests__/daemon-connection-conflict.integration.test.ts
// Integration checkpoint for add-daemon-connection-conflict-skip (Task 5).
//
// Exercises the SERVER half end-to-end against a STATEFUL in-memory prisma fake (so
// it runs in CI without a real Postgres, unlike the T2_REAL_DB_URL-gated suite): the
// REAL `registerConnection` decides conflict vs refresh vs takeover across a sequence
// of registrations, and we assert the persisted rows + returned verdicts. This proves
// the layered truth table holds when state actually accumulates, not just per-call.
//
// Maps to the delta-spec acceptance scenarios:
//   • Scenario A (core bug) → daemon-connection-registry "Registration SHALL skip and
//     signal a conflict …": a live incumbent + a different-process second registration
//     yields a conflict AND the incumbent row is byte-for-byte untouched (write-nothing).
//   • Scenario C → "A stale incumbent is taken over": after the incumbent goes stale,
//     a new process registers (takeover), not a conflict.
//   • Scenario D → "A fresh same-process reconnect refreshes, not conflicts".
//   • cross-clientType + null-cwd exemption rows complete the registry-side coverage.
// Scenarios B (partial-conflict survivor) and E (all-conflict exit) are daemon-process
// behavior and are covered end-to-end in cli/__tests__/daemon-multipath.test.mjs +
// daemon-permission-wiring.test.mjs; the daemon-side `onConflict` consumption of the
// server's `connection_conflict` signal is covered in cli/__tests__/sse-listener.test.mjs.

import { describe, it, expect, beforeEach, vi } from "vitest";

// ===== Stateful in-memory prisma fake =====
// Models just enough of daemonConnection + agentInstance for registerConnection's
// real-cwd path: findMany (conflict probe), upsert (compound-key), findFirst/create/
// update (null-cwd compat). Rows live in module-level arrays reset per test.
interface ConnRow {
  uuid: string;
  companyUuid: string;
  agentUuid: string;
  clientType: string;
  clientVersion: string | null;
  host: string;
  cwd: string | null;
  startedAt: Date | null;
  status: string;
  connectedAt: Date;
  lastSeenAt: Date;
  disconnectedAt: Date | null;
  agentInstanceUuid: string | null;
}

// Hoisted so the vi.mock factory (itself hoisted above imports) can reference it.
// `store` holds the mutable row arrays + uuid counter, reset per test in beforeEach.
const { mockPrisma, mockLogger, store } = vi.hoisted(() => {
  const store: {
    connRows: ConnRow[];
    instanceRows: { uuid: string; companyUuid: string; agentUuid: string; host: string; cwd: string | null }[];
    uuidSeq: number;
  } = { connRows: [], instanceRows: [], uuidSeq: 0 };
  const nextUuid = (p: string) => `${p}-${++store.uuidSeq}`;
  const matchesWhere = (row: Record<string, unknown>, where: Record<string, unknown>): boolean =>
    Object.entries(where).every(([k, v]) => row[k] === v);

  const mockPrisma = {
    daemonConnection: {
      findMany: vi.fn(async ({ where }: { where: Record<string, unknown> }) =>
        store.connRows.filter((r) => matchesWhere(r as unknown as Record<string, unknown>, where)),
      ),
      upsert: vi.fn(
        async ({
          where,
          create,
          update,
        }: {
          where: { agentUuid_clientType_host_cwd: { agentUuid: string; clientType: string; host: string; cwd: string } };
          create: Omit<ConnRow, "uuid">;
          update: Partial<ConnRow>;
        }) => {
          const key = where.agentUuid_clientType_host_cwd;
          const existing = store.connRows.find(
            (r) =>
              r.agentUuid === key.agentUuid &&
              r.clientType === key.clientType &&
              r.host === key.host &&
              r.cwd === key.cwd,
          );
          if (existing) {
            Object.assign(existing, update);
            return { uuid: existing.uuid, connectedAt: existing.connectedAt };
          }
          const row: ConnRow = { uuid: nextUuid("conn"), ...create };
          store.connRows.push(row);
          return { uuid: row.uuid, connectedAt: row.connectedAt };
        },
      ),
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const r = store.connRows.find((row) => matchesWhere(row as unknown as Record<string, unknown>, where));
        return r ? { uuid: r.uuid, connectedAt: r.connectedAt } : null;
      }),
      update: vi.fn(async ({ where, data }: { where: { uuid: string }; data: Partial<ConnRow> }) => {
        const r = store.connRows.find((row) => row.uuid === where.uuid)!;
        Object.assign(r, data);
        return { uuid: r.uuid, connectedAt: r.connectedAt };
      }),
      create: vi.fn(async ({ data }: { data: Omit<ConnRow, "uuid"> }) => {
        const row: ConnRow = { uuid: nextUuid("conn"), ...data };
        store.connRows.push(row);
        return { uuid: row.uuid, connectedAt: row.connectedAt };
      }),
    },
    agentInstance: {
      upsert: vi.fn(async ({ create }: { create: { companyUuid: string; agentUuid: string; host: string; cwd: string | null } }) => {
        const existing = store.instanceRows.find(
          (r) => r.companyUuid === create.companyUuid && r.agentUuid === create.agentUuid && r.host === create.host && r.cwd === create.cwd,
        );
        if (existing) return { uuid: existing.uuid };
        const row = { uuid: nextUuid("inst"), ...create };
        store.instanceRows.push(row);
        return { uuid: row.uuid };
      }),
      findFirst: vi.fn(async ({ where }: { where: Record<string, unknown> }) => {
        const r = store.instanceRows.find((row) => matchesWhere(row as unknown as Record<string, unknown>, where));
        return r ? { uuid: r.uuid } : null;
      }),
      create: vi.fn(async ({ data }: { data: { companyUuid: string; agentUuid: string; host: string; cwd: string | null } }) => {
        const row = { uuid: nextUuid("inst"), ...data };
        store.instanceRows.push(row);
        return { uuid: row.uuid };
      }),
      update: vi.fn(async ({ where }: { where: { uuid: string } }) => ({ uuid: where.uuid })),
    },
  };
  const mockLogger = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() };
  return { mockPrisma, mockLogger, store };
});
vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/logger", () => ({ default: mockLogger }));

import {
  registerConnection,
  isConnectionConflict,
  STALE_THRESHOLD_MS,
  type SelfReport,
} from "@/services/daemon-connection.service";

const companyUuid = "co-1";
const agentUuid = "ag-1";
const host = "mac.local";
const cwd = "/work/alpha";

const report = (over: Partial<SelfReport> = {}): SelfReport => ({
  clientType: "claude_code",
  host,
  cwd,
  startedAt: new Date("2026-06-15T03:00:00.000Z"),
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  store.connRows = [];
  store.instanceRows = [];
  store.uuidSeq = 0;
});

// Terse accessor for the live connection rows (reassigned each test in beforeEach).
const conns = () => store.connRows;

describe("conflict integration checkpoint (real registerConnection over a stateful store)", () => {
  it("Scenario A: a live incumbent + a different-process second registration → conflict, incumbent row UNTOUCHED", async () => {
    // First daemon registers and is heartbeating (fresh).
    const first = await registerConnection(companyUuid, agentUuid, report({ startedAt: new Date("2026-06-15T03:00:00.000Z") }));
    expect(isConnectionConflict(first)).toBe(false);
    expect(conns()).toHaveLength(1);
    const incumbent = { ...conns()[0] }; // snapshot

    // Second daemon, SAME (agent, host, cwd), DIFFERENT startedAt → conflict.
    const second = await registerConnection(companyUuid, agentUuid, report({ startedAt: new Date("2026-06-15T09:00:00.000Z") }));
    expect(isConnectionConflict(second)).toBe(true);
    expect(second).toEqual({ conflict: true, host, cwd });

    // Write-nothing: still exactly one row, byte-for-byte unchanged.
    expect(conns()).toHaveLength(1);
    expect(conns()[0]).toEqual(incumbent);
    // A structured warn was emitted; no error path.
    expect(mockLogger.warn).toHaveBeenCalledTimes(1);
    expect(mockLogger.error).not.toHaveBeenCalled();
  });

  it("Scenario A (cross-clientType): a fresh claude_code incumbent makes a codex registration a conflict (no 2nd row)", async () => {
    await registerConnection(companyUuid, agentUuid, report({ clientType: "claude_code", startedAt: new Date("2026-06-15T03:00:00.000Z") }));
    const second = await registerConnection(companyUuid, agentUuid, report({ clientType: "codex", startedAt: new Date("2026-06-15T09:00:00.000Z") }));
    expect(isConnectionConflict(second)).toBe(true);
    expect(conns()).toHaveLength(1);
    expect(conns()[0].clientType).toBe("claude_code");
  });

  it("Scenario D: the SAME process reconnecting (startedAt unchanged) refreshes the row — never a conflict", async () => {
    const started = new Date("2026-06-15T03:00:00.000Z");
    const first = await registerConnection(companyUuid, agentUuid, report({ startedAt: started }));
    expect(isConnectionConflict(first)).toBe(false);
    const firstUuid = conns()[0].uuid;

    // Same startedAt → reconnect refresh. Still one row, same uuid.
    const again = await registerConnection(companyUuid, agentUuid, report({ startedAt: started }));
    expect(isConnectionConflict(again)).toBe(false);
    expect(conns()).toHaveLength(1);
    expect(conns()[0].uuid).toBe(firstUuid);
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  it("Scenario C: a STALE incumbent is taken over by a new process — not misjudged as a conflict (crash-restart)", async () => {
    await registerConnection(companyUuid, agentUuid, report({ startedAt: new Date("2026-06-15T03:00:00.000Z") }));
    // Simulate the first daemon crashing: its row goes stale (lastSeenAt well past the threshold).
    conns()[0].lastSeenAt = new Date(Date.now() - STALE_THRESHOLD_MS - 60_000);

    // Restart with a fresh process identity → takeover (refresh of the same compound-key row).
    const restart = await registerConnection(companyUuid, agentUuid, report({ startedAt: new Date("2026-06-15T12:00:00.000Z") }));
    expect(isConnectionConflict(restart)).toBe(false);
    expect(conns()).toHaveLength(1);
    expect(conns()[0].status).toBe("online");
    expect(mockLogger.warn).not.toHaveBeenCalled();
  });

  it("null-cwd (old daemon) is exempt: detection findMany never runs, reconnect refreshes the null row", async () => {
    const oldReport = report({ cwd: null, startedAt: null });
    const a = await registerConnection(companyUuid, agentUuid, oldReport);
    expect(isConnectionConflict(a)).toBe(false);
    // A second old-daemon report with a DIFFERENT startedAt would conflict on the real-cwd
    // path, but the null branch is exempt: it reuses the single null row, no conflict.
    const b = await registerConnection(companyUuid, agentUuid, report({ cwd: null, startedAt: new Date("2026-06-15T09:00:00.000Z") }));
    expect(isConnectionConflict(b)).toBe(false);
    expect(conns().filter((r) => r.cwd === null)).toHaveLength(1);
    // The conflict probe (findMany) is real-cwd-only — never consulted for cwd=null.
    expect(mockPrisma.daemonConnection.findMany).not.toHaveBeenCalled();
  });

  it("a different AGENT at the same host+cwd never collides (scope is per-agent)", async () => {
    await registerConnection(companyUuid, agentUuid, report({ startedAt: new Date("2026-06-15T03:00:00.000Z") }));
    const other = await registerConnection(companyUuid, "ag-2", report({ startedAt: new Date("2026-06-15T09:00:00.000Z") }));
    expect(isConnectionConflict(other)).toBe(false);
    expect(conns()).toHaveLength(2);
  });
});
