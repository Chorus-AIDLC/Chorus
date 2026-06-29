// src/services/__tests__/daemon-connection-registration.integration.test.ts
//
// REAL-POSTGRES INTEGRATION TEST for T2 (握手自报 cwd + 注册按含 cwd 的键 upsert).
//
// Unlike the unit test (which mocks prisma and asserts the *call shapes*), this
// test runs the REAL `registerConnection` service against a REAL PostgreSQL
// instance, because the whole point of T2 is behavior that a mock cannot prove:
//   - Postgres treats every NULL as DISTINCT in a UNIQUE index, so two
//     (agent, clientType, host, NULL) rows do NOT collide; and
//   - Prisma types the compound-unique `where` field as non-null, so a NULL cwd
//     cannot be targeted in an upsert at all.
// Both facts are exactly why the old-daemon (cwd=null) path is findFirst→update/
// create rather than a compound-key upsert, and they are only observable against
// a genuine database.
//
// It proves the four T2 acceptance scenarios end to end at the service layer:
//   (1) a new daemon that reports cwd → one row carrying that cwd;
//   (2) the SAME agent + SAME host with TWO DIFFERENT cwds → two INDEPENDENT
//       rows, each with its own presence (the overwrite-bug fix);
//   (3) an OLD daemon that does NOT report cwd → a single cwd=null row, and a
//       reconnect REUSES that row (no null-row pileup), behaving as before;
//   (4) a new daemon (with cwd) and an old daemon (cwd=null) under the SAME
//       agent + host COEXIST as two distinct rows without interfering.
//
// HOW TO RUN (never touches the live store):
//   docker run -d --name chorus-t2-pg -e POSTGRES_USER=t2 -e POSTGRES_PASSWORD=t2 \
//     -e POSTGRES_DB=t2 -p 55433:5432 postgres:16-alpine
//   DATABASE_URL="postgresql://t2:t2@127.0.0.1:55433/t2" npx prisma migrate deploy
//   T2_REAL_DB_URL="postgresql://t2:t2@127.0.0.1:55433/t2" \
//     npx vitest run src/services/__tests__/daemon-connection-registration.integration.test.ts
//
// When T2_REAL_DB_URL is NOT set (the default for `pnpm test` / CI), the whole
// suite is skipped — so it never connects to a database it shouldn't, and in
// particular never touches the live PGlite store (port 5433 / ~/.chorus-data).

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";

// Gate: only run when an explicit throwaway DB URL is provided.
const REAL_DB_URL = process.env.T2_REAL_DB_URL;
const describeReal = REAL_DB_URL ? describe : describe.skip;

// The real generated Prisma client is imported by ABSOLUTE filesystem path so it
// bypasses the vitest alias that points "@/generated/prisma/client" at a stub
// (see vitest.config.ts). We deliberately want the REAL client here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let realPrisma: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let pool: any;

// Lazily-imported real service functions (imported AFTER the prisma mock is wired).
type RegisterConnection = typeof import("@/services/daemon-connection.service")["registerConnection"];
type ListConnectionsForAgent =
  typeof import("@/services/daemon-connection.service")["listConnectionsForAgent"];
type ParseSelfReport = typeof import("@/services/daemon-connection.service")["parseSelfReport"];
// Narrowed to the handle|null result: every scenario in THIS file is a
// non-conflict registration (reports carry no startedAt, so a null-vs-null
// incumbent refreshes rather than conflicts). The wrapper asserts that and
// returns the handle|null shape so existing `.uuid` assertions keep compiling.
type RegisterConnectionNarrowed = (
  ...args: Parameters<RegisterConnection>
) => Promise<{ uuid: string; connectedAt: Date } | null>;
let registerConnection: RegisterConnectionNarrowed;
let listConnectionsForAgent: ListConnectionsForAgent;
let parseSelfReport: ParseSelfReport;

const companyUuid = "company-it-0000-0000-000000000001";
const agentUuid = "agent-it-0000-0000-0000-00000000001";
const otherAgentUuid = "agent-it-0000-0000-0000-00000000002";

describeReal("registerConnection — REAL Postgres (cwd-aware registry)", () => {
  beforeAll(async () => {
    // Build a REAL PrismaClient pointed at the throwaway DB, then make the
    // service's `@/lib/prisma` import resolve to it. The logger is silenced.
    const { PrismaClient } = await import(
      /* @vite-ignore */ "../../generated/prisma/client"
    );
    const { PrismaPg } = await import("@prisma/adapter-pg");
    const pg = (await import("pg")).default;

    pool = new pg.Pool({ connectionString: REAL_DB_URL });
    const adapter = new PrismaPg(pool);
    realPrisma = new PrismaClient({ adapter });

    vi.doMock("@/lib/prisma", () => ({ prisma: realPrisma }));
    vi.doMock("@/lib/logger", () => ({
      default: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
    }));

    const svc = await import("@/services/daemon-connection.service");
    registerConnection = async (...args) => {
      const result = await svc.registerConnection(...args);
      if (svc.isConnectionConflict(result)) {
        throw new Error(`unexpected conflict result in a non-conflict test: ${JSON.stringify(result)}`);
      }
      return result;
    };
    listConnectionsForAgent = svc.listConnectionsForAgent;
    parseSelfReport = svc.parseSelfReport;

    // Seed the two Company + Agent rows the FK relations require. The schema uses
    // relationMode="prisma" (no DB FKs), but the read projection joins agent.name,
    // so the agent rows must exist for listConnectionsForAgent to resolve names.
    await realPrisma.company.upsert({
      where: { uuid: companyUuid },
      create: { uuid: companyUuid, name: "IT Co" },
      update: {},
    });
    for (const [uuid, name] of [
      [agentUuid, "IT Agent"],
      [otherAgentUuid, "IT Agent 2"],
    ] as const) {
      await realPrisma.agent.upsert({
        where: { uuid },
        create: { uuid, companyUuid, name, roles: [], permissions: [] },
        update: {},
      });
    }
  });

  afterAll(async () => {
    if (realPrisma) {
      await realPrisma.daemonConnection.deleteMany({ where: { companyUuid } });
      await realPrisma.agent.deleteMany({ where: { companyUuid } });
      await realPrisma.company.deleteMany({ where: { uuid: companyUuid } });
      await realPrisma.$disconnect();
    }
    if (pool) await pool.end();
  });

  beforeEach(async () => {
    // Each test starts from an empty connection table (scoped to our company).
    await realPrisma.daemonConnection.deleteMany({ where: { companyUuid } });
  });

  // ---- Scenario 1: new daemon reports cwd → a cwd row ----
  it("(1) a new daemon that reports cwd lands exactly one row carrying that cwd", async () => {
    const report = parseSelfReport(
      new URLSearchParams({
        clientType: "claude_code",
        host: "mac.local",
        cwd: "/work/alpha",
      }),
    );
    expect(report.cwd).toBe("/work/alpha");

    const handle = await registerConnection(companyUuid, agentUuid, report);
    expect(handle).not.toBeNull();

    const rows = await realPrisma.daemonConnection.findMany({ where: { companyUuid, agentUuid } });
    expect(rows).toHaveLength(1);
    expect(rows[0].cwd).toBe("/work/alpha");
    expect(rows[0].host).toBe("mac.local");
    expect(rows[0].status).toBe("online");
  });

  // ---- Scenario 2: two different cwds coexist (the overwrite-bug fix) ----
  it("(2) SAME agent + SAME host + TWO DIFFERENT cwds → two independent rows, each its own presence", async () => {
    const a = await registerConnection(
      companyUuid,
      agentUuid,
      parseSelfReport(
        new URLSearchParams({ clientType: "claude_code", host: "mac.local", cwd: "/work/a" }),
      ),
    );
    const b = await registerConnection(
      companyUuid,
      agentUuid,
      parseSelfReport(
        new URLSearchParams({ clientType: "claude_code", host: "mac.local", cwd: "/work/b" }),
      ),
    );

    // Two DISTINCT connection generations (different uuids) — neither overwrote
    // the other. Before the fix, the second registration would have updated the
    // first's single (agent, clientType, host) row.
    expect(a).not.toBeNull();
    expect(b).not.toBeNull();
    expect(a!.uuid).not.toBe(b!.uuid);

    const views = await listConnectionsForAgent(companyUuid, agentUuid);
    expect(views).toHaveLength(2);
    const byCwd = Object.fromEntries(views.map((v) => [v.cwd, v]));
    // Each cwd has its own row with its own independent presence.
    expect(byCwd["/work/a"]).toBeTruthy();
    expect(byCwd["/work/b"]).toBeTruthy();
    expect(byCwd["/work/a"].uuid).not.toBe(byCwd["/work/b"].uuid);
    expect(byCwd["/work/a"].effectiveStatus).toBe("online");
    expect(byCwd["/work/b"].effectiveStatus).toBe("online");

    // Marking ONE cwd's row offline (via a direct status flip) does not touch the
    // other — presence is genuinely independent per cwd.
    await realPrisma.daemonConnection.update({
      where: { uuid: byCwd["/work/a"].uuid },
      data: { status: "offline", disconnectedAt: new Date() },
    });
    const after = await listConnectionsForAgent(companyUuid, agentUuid);
    const afterByCwd = Object.fromEntries(after.map((v) => [v.cwd, v]));
    expect(afterByCwd["/work/a"].effectiveStatus).toBe("offline");
    expect(afterByCwd["/work/b"].effectiveStatus).toBe("online");
  });

  // ---- Scenario 3: old daemon (no cwd) → single null row; reconnect no pileup ----
  it("(3) an OLD daemon (no cwd) lands a single cwd=null row, and reconnect REUSES it (no pileup)", async () => {
    // No cwd param → an old daemon. parseSelfReport yields cwd:null.
    const report = parseSelfReport(
      new URLSearchParams({ clientType: "claude_code", host: "mac.local" }),
    );
    expect(report.cwd).toBeNull();

    const first = await registerConnection(companyUuid, agentUuid, report);
    expect(first).not.toBeNull();

    let rows = await realPrisma.daemonConnection.findMany({ where: { companyUuid, agentUuid } });
    expect(rows).toHaveLength(1);
    expect(rows[0].cwd).toBeNull();

    // Reconnect three more times. A naive cwd=null upsert would ACCUMULATE a new
    // NULL row each time (Postgres NULLs never collide). The compatibility path
    // must REUSE the same row instead.
    const second = await registerConnection(companyUuid, agentUuid, report);
    const third = await registerConnection(companyUuid, agentUuid, report);
    const fourth = await registerConnection(companyUuid, agentUuid, report);

    rows = await realPrisma.daemonConnection.findMany({ where: { companyUuid, agentUuid } });
    expect(rows).toHaveLength(1); // STILL one row — no null-row pileup.
    // Same physical row reused across every reconnect.
    expect(first!.uuid).toBe(second!.uuid);
    expect(second!.uuid).toBe(third!.uuid);
    expect(third!.uuid).toBe(fourth!.uuid);
    expect(rows[0].uuid).toBe(first!.uuid);
    expect(rows[0].status).toBe("online");
  });

  // Empirical confirmation of the FINDING that motivates the null-compat path:
  // two raw NULL-cwd inserts do NOT collide on the composite unique index. This
  // is the exact behavior the service code must work around.
  it("(3b) [empirical] two raw cwd=NULL rows do NOT dedup on the composite unique index (Postgres NULL is distinct)", async () => {
    const base = {
      companyUuid,
      agentUuid,
      clientType: "claude_code",
      host: "mac.local",
      cwd: null,
      status: "online",
    };
    await realPrisma.daemonConnection.create({ data: base });
    // A SECOND identical (agent, clientType, host, NULL) row inserts WITHOUT a
    // unique-constraint violation — proving NULL is treated as distinct.
    await expect(
      realPrisma.daemonConnection.create({ data: base }),
    ).resolves.toBeTruthy();
    const rows = await realPrisma.daemonConnection.findMany({ where: { companyUuid, agentUuid } });
    expect(rows).toHaveLength(2);
  });

  // ---- Scenario 4: new + old daemons coexist under the same agent+host ----
  it("(4) a new daemon (cwd) and an old daemon (cwd=null) under the SAME agent+host coexist without interfering", async () => {
    const oldReport = parseSelfReport(
      new URLSearchParams({ clientType: "claude_code", host: "mac.local" }),
    );
    const newReport = parseSelfReport(
      new URLSearchParams({ clientType: "claude_code", host: "mac.local", cwd: "/work/new" }),
    );

    const oldHandle = await registerConnection(companyUuid, agentUuid, oldReport);
    const newHandle = await registerConnection(companyUuid, agentUuid, newReport);

    expect(oldHandle).not.toBeNull();
    expect(newHandle).not.toBeNull();
    expect(oldHandle!.uuid).not.toBe(newHandle!.uuid);

    const views = await listConnectionsForAgent(companyUuid, agentUuid);
    expect(views).toHaveLength(2);
    // Order-independent: one row is the old daemon's null cwd, one is the new
    // daemon's "/work/new" — they coexist as two distinct rows.
    const cwds = views.map((v) => v.cwd);
    expect(cwds).toContain(null);
    expect(cwds).toContain("/work/new");

    // Old daemon reconnecting does NOT disturb the new daemon's cwd row.
    await registerConnection(companyUuid, agentUuid, oldReport);
    const after = await listConnectionsForAgent(companyUuid, agentUuid);
    expect(after).toHaveLength(2);
    const afterCwds = after.map((v) => v.cwd);
    expect(afterCwds).toContain(null);
    expect(afterCwds).toContain("/work/new");
  });
});
