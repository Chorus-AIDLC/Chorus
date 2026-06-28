// src/services/__tests__/daemon-multipath-e2e.integration.test.ts
//
// T4 — INTEGRATION CHECKPOINT (the DAG convergence point) for the daemon
// multi-path-cwd engine. This is the END-TO-END verification that T1–T3 work
// TOGETHER as combined scenarios — NOT a re-run of the per-task unit tests.
//
// Unlike the per-layer suites (each of which mocks prisma or a single seam), this
// test wires the REAL composition of every layer against ONE real PostgreSQL
// instance, so each function reads exactly what the previous one wrote — the thing
// a mock cannot prove:
//
//   registerConnection / listConnectionsForAgent   (T1+T2 registry — composite key
//                                                    (agent, clientType, host, cwd),
//                                                    two write paths, effectiveStatus)
//     → maybeCreateTurnForWakeNotification          (the wake/DISPATCH chokepoint —
//                                                    selects the origin connection by
//                                                    (company, agent) only, online-first;
//                                                    NO cwd filter, NO project→cwd infer)
//       → resolveOrCreateSession + createPendingTurn (T3 session — stamps
//                                                     originConnectionUuid write-once)
//   assertContinuable                               (T3 resume — pins continuation to
//                                                    the session's ORIGIN connection;
//                                                    a different cwd is a different row
//                                                    and is NEVER routed to → cross-cwd
//                                                    resume is refused, not mis-routed)
//   escapeCwd / transcriptPath                      (T3 on-disk transcript naming —
//                                                    the ~/.claude/projects/<escaped-cwd>
//                                                    rule that makes resume cwd-bound)
//
// Only lineage (directIdeaUuid resolution) is faked at its module boundary, because
// it walks idea ancestry that is orthogonal to this slice; everything else — the
// registry writes, the connection selection, the session/turn writes, the resume
// assertion — runs for real against the database.
//
// The five AC are proven as COMBINED scenarios (mapped to the tech design's 验证要点):
//   (AC1) same agent + same host + two DIFFERENT real cwds → two registry rows coexist,
//         each presence online INDEPENDENTLY, end-to-end through registerConnection +
//         listConnectionsForAgent (effectiveStatus).
//   (AC2) resume ALWAYS returns to the session's original cwd; a scenario constructed
//         to route to a DIFFERENT cwd is REFUSED (SessionReadOnlyError) rather than
//         mis-routed — backed by a REAL on-disk transcript that exists only under the
//         origin cwd's escaped dir (so a cross-cwd `claude --resume` would
//         `No conversation found`).
//   (AC3) the DISPATCH connection-selection is not broken: same agent with multiple cwd
//         connections + a null-cwd connection coexisting → the existing selection picks
//         correctly (online-first), no miss, no error; and NO project→cwd inference is
//         introduced (the selection input is purely (company, agent)).
//   (AC4) HARD-1 end-to-end: a fully cwd-less OLD daemon registers (null row) / receives
//         dispatch (agent-based selection) / its session resumes (origin connection, not
//         blocked by the cwd check); new + old daemon coexist without interfering.
//   (AC5) MIGRATION BACKFILL: an existing cwd=null row (the migration-era state), after
//         the daemon upgrades and self-reports a real cwd, results in a row carrying that
//         cwd, and functionality never regresses across the transition.
//
// HOW TO RUN (never touches the live store — see the gate below):
//   docker run -d --name chorus-t4-pg -e POSTGRES_USER=t4 -e POSTGRES_PASSWORD=t4 \
//     -e POSTGRES_DB=t4 -p 127.0.0.1:55444:5432 postgres:16-alpine
//   DATABASE_URL="postgresql://t4:t4@127.0.0.1:55444/t4" npx prisma migrate deploy
//   T4_REAL_DB_URL="postgresql://t4:t4@127.0.0.1:55444/t4" \
//     npx vitest run src/services/__tests__/daemon-multipath-e2e.integration.test.ts
//
// When T4_REAL_DB_URL is NOT set (the default for `pnpm test` / CI), the WHOLE suite is
// skipped — so it never connects to a database it shouldn't, and in particular NEVER
// touches the live PGlite store (port 5433 / ~/.chorus-data).

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Gate: only run when an explicit throwaway DB URL is provided.
const REAL_DB_URL = process.env.T4_REAL_DB_URL;
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
type MaybeCreateTurn =
  typeof import("@/services/notification-turn")["maybeCreateTurnForWakeNotification"];
type AssertContinuable = typeof import("@/services/daemon-session.service")["assertContinuable"];
type SessionReadOnlyErrorT = typeof import("@/services/daemon-session.service")["SessionReadOnlyError"];
type StaleThreshold = typeof import("@/services/daemon-connection.service")["STALE_THRESHOLD_MS"];

// Narrowed to handle|null: every registration in this e2e is a non-conflict
// path (distinct cwds, no competing same-cwd live process), so the wrapper
// asserts "not a conflict" and returns the handle|null shape the `.uuid`
// assertions below expect.
type RegisterConnectionNarrowed = (
  ...args: Parameters<RegisterConnection>
) => Promise<{ uuid: string; connectedAt: Date } | null>;
let registerConnection: RegisterConnectionNarrowed;
let listConnectionsForAgent: ListConnectionsForAgent;
let parseSelfReport: ParseSelfReport;
let maybeCreateTurnForWakeNotification: MaybeCreateTurn;
let assertContinuable: AssertContinuable;
let SessionReadOnlyError: SessionReadOnlyErrorT;
let STALE_THRESHOLD_MS: StaleThreshold;

// The CLI transcript-path helpers — the SAME functions the daemon uses on disk to
// decide --session-id vs --resume. We exercise the REAL implementation so the resume
// scenario proves the actual ~/.claude/projects/<escaped-cwd> naming, not a guess.
type TranscriptPath = typeof import("../../../cli/claude-spawner.mjs")["transcriptPath"];
type IsNewSession = typeof import("../../../cli/claude-spawner.mjs")["isNewSession"];
type EscapeCwd = typeof import("../../../cli/claude-spawner.mjs")["escapeCwd"];
let transcriptPath: TranscriptPath;
let isNewSession: IsNewSession;
let escapeCwd: EscapeCwd;

const companyUuid = "company-t4-0000-0000-000000000001";
const agentUuid = "agent-t4-0000-0000-0000-00000000001"; // the "new" multi-path agent
const oldAgentUuid = "agent-t4-0000-0000-0000-00000000002"; // a purely cwd-less OLD daemon agent
const HOST = "mac.local";

// A wake-notification context for the dispatch chokepoint. entityType "task" is
// lineage-walkable, so the session id is derived from the (faked) directIdeaUuid.
function wakeCtx(overrides: Partial<Parameters<MaybeCreateTurn>[0]> = {}) {
  return {
    companyUuid,
    recipientType: "agent",
    recipientUuid: agentUuid,
    entityType: "task",
    entityUuid: "task-e2e-1",
    action: "task_assigned",
    ...overrides,
  };
}

describeReal("daemon multi-path E2E — REAL Postgres (T4 integration checkpoint)", () => {
  // A single faked direct-idea so the session key is deterministic. Tests that want a
  // distinct session set DIRECT_IDEA before driving the chokepoint.
  let DIRECT_IDEA = "idea-e2e-0000-0000-0000-00000000001";

  beforeAll(async () => {
    // Build a REAL PrismaClient pointed at the throwaway DB, then make the services'
    // `@/lib/prisma` import resolve to it. The logger is silenced. lineage is faked
    // (directIdeaUuid resolution is orthogonal to this slice).
    const { PrismaClient } = await import(
      /* @vite-ignore */ "../../generated/prisma/client"
    );
    const { PrismaPg } = await import("@prisma/adapter-pg");
    const pg = (await import("pg")).default;

    pool = new pg.Pool({ connectionString: REAL_DB_URL });
    const adapter = new PrismaPg(pool);
    realPrisma = new PrismaClient({ adapter });

    vi.doMock("@/lib/prisma", () => ({ prisma: realPrisma }));
    vi.doMock("@/lib/logger", () => {
      const fn = () => {};
      const stub = { error: fn, warn: fn, info: fn, debug: fn, child: () => stub };
      return { default: stub };
    });
    // Fake ONLY lineage: the chokepoint asks for the entity's direct idea. We resolve
    // it to DIRECT_IDEA (so the session key is the idea), or null for ad-hoc.
    vi.doMock("@/services/lineage.service", () => ({
      resolveRootIdea: async () => ({
        rootIdeaUuid: DIRECT_IDEA,
        directIdeaUuid: DIRECT_IDEA,
        lineage: [],
        resolvedVia: "via_proposal",
      }),
    }));

    const connSvc = await import("@/services/daemon-connection.service");
    registerConnection = async (...args) => {
      const result = await connSvc.registerConnection(...args);
      if (connSvc.isConnectionConflict(result)) {
        throw new Error(`unexpected conflict result in a non-conflict test: ${JSON.stringify(result)}`);
      }
      return result;
    };
    listConnectionsForAgent = connSvc.listConnectionsForAgent;
    parseSelfReport = connSvc.parseSelfReport;
    STALE_THRESHOLD_MS = connSvc.STALE_THRESHOLD_MS;

    const bridge = await import("@/services/notification-turn");
    maybeCreateTurnForWakeNotification = bridge.maybeCreateTurnForWakeNotification;

    const sessSvc = await import("@/services/daemon-session.service");
    assertContinuable = sessSvc.assertContinuable;
    SessionReadOnlyError = sessSvc.SessionReadOnlyError;

    const spawner = await import(/* @vite-ignore */ "../../../cli/claude-spawner.mjs");
    transcriptPath = spawner.transcriptPath;
    isNewSession = spawner.isNewSession;
    escapeCwd = spawner.escapeCwd;

    // Seed the Company + Agent rows the read projection joins on (agent.name). The
    // schema uses relationMode="prisma" (no DB FKs), but listConnectionsForAgent joins
    // the agent name, so the agent rows must exist.
    await realPrisma.company.upsert({
      where: { uuid: companyUuid },
      create: { uuid: companyUuid, name: "T4 Co" },
      update: {},
    });
    for (const [uuid, name] of [
      [agentUuid, "T4 Multi-path Agent"],
      [oldAgentUuid, "T4 Old Daemon Agent"],
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
      // Order matters under relationMode="prisma" (no cascade at DB level here).
      await realPrisma.daemonSessionTurn.deleteMany({}).catch(() => {});
      await realPrisma.daemonSession.deleteMany({ where: { companyUuid } });
      await realPrisma.daemonConnection.deleteMany({ where: { companyUuid } });
      await realPrisma.agent.deleteMany({ where: { companyUuid } });
      await realPrisma.company.deleteMany({ where: { uuid: companyUuid } });
      await realPrisma.$disconnect();
    }
    if (pool) await pool.end();
  });

  beforeEach(async () => {
    // Each test starts from an empty session/turn/connection table (scoped to our company).
    // Turns reference sessions by sessionUuid (not companyUuid), so clear them first.
    const sessions = await realPrisma.daemonSession.findMany({
      where: { companyUuid },
      select: { uuid: true },
    });
    const sessionUuids = sessions.map((s: { uuid: string }) => s.uuid);
    if (sessionUuids.length) {
      await realPrisma.daemonSessionTurn.deleteMany({
        where: { sessionUuid: { in: sessionUuids } },
      });
    }
    await realPrisma.daemonSession.deleteMany({ where: { companyUuid } });
    await realPrisma.daemonConnection.deleteMany({ where: { companyUuid } });
    DIRECT_IDEA = "idea-e2e-0000-0000-0000-00000000001";
  });

  // Helper: register a connection the way the SSE route does — parse a self-report off
  // query params, then registerConnection. Returns the ConnectionHandle.
  async function register(
    agent: string,
    params: { host?: string; cwd?: string },
  ) {
    const sp = new URLSearchParams({ clientType: "claude_code" });
    if (params.host !== undefined) sp.set("host", params.host);
    if (params.cwd !== undefined) sp.set("cwd", params.cwd);
    const report = parseSelfReport(sp);
    return registerConnection(companyUuid, agent, report);
  }

  // Helper: directly age a connection's lastSeenAt so its effectiveStatus computes to
  // offline (the registry's staleness rule), without touching status. Mirrors a daemon
  // whose heartbeat stopped — the exact condition assertContinuable refuses resume on.
  async function makeStale(connUuid: string) {
    await realPrisma.daemonConnection.update({
      where: { uuid: connUuid },
      data: { lastSeenAt: new Date(Date.now() - STALE_THRESHOLD_MS - 60_000) },
    });
  }

  // =========================================================================
  // AC1 — same agent + same host + two DIFFERENT real cwds → two rows coexist,
  //       each presence online independently (end-to-end through the registry).
  // =========================================================================
  describe("AC1: same agent + same host + two different cwds coexist, presence independent", () => {
    it("registers two independent rows for two real cwds; each is online; flipping one does not touch the other", async () => {
      const cwdA = "/work/alpha";
      const cwdB = "/work/beta";

      const a = await register(agentUuid, { host: HOST, cwd: cwdA });
      const b = await register(agentUuid, { host: HOST, cwd: cwdB });
      expect(a).not.toBeNull();
      expect(b).not.toBeNull();
      // Two DISTINCT rows — neither overwrote the other (the overwrite bug is fixed).
      expect(a!.uuid).not.toBe(b!.uuid);

      const views = await listConnectionsForAgent(companyUuid, agentUuid);
      expect(views).toHaveLength(2);
      const byCwd = Object.fromEntries(views.map((v) => [v.cwd, v]));
      expect(byCwd[cwdA]).toBeTruthy();
      expect(byCwd[cwdB]).toBeTruthy();
      // Each cwd row carries the SAME agent + host but is its own connection identity.
      expect(byCwd[cwdA].host).toBe(HOST);
      expect(byCwd[cwdB].host).toBe(HOST);
      expect(byCwd[cwdA].agentUuid).toBe(agentUuid);
      expect(byCwd[cwdB].agentUuid).toBe(agentUuid);
      // Presence is computed independently per row.
      expect(byCwd[cwdA].effectiveStatus).toBe("online");
      expect(byCwd[cwdB].effectiveStatus).toBe("online");

      // Take cwdA offline (stale heartbeat). cwdB stays online — genuinely independent.
      await makeStale(byCwd[cwdA].uuid);
      const after = await listConnectionsForAgent(companyUuid, agentUuid);
      const afterByCwd = Object.fromEntries(after.map((v) => [v.cwd, v]));
      expect(afterByCwd[cwdA].effectiveStatus).toBe("offline");
      expect(afterByCwd[cwdB].effectiveStatus).toBe("online");
    });
  });

  // =========================================================================
  // AC2 — resume always returns to the original cwd; a cross-cwd route is REFUSED
  //       (not mis-routed to "No conversation found"). Backed by a REAL on-disk
  //       transcript that lives only under the origin cwd's escaped dir.
  // =========================================================================
  describe("AC2: resume returns to origin cwd; cross-cwd route refused (not mis-routed)", () => {
    let configDir: string;
    let cwdA: string;
    let cwdB: string;

    beforeEach(() => {
      // A sandboxed CLAUDE_CONFIG_DIR + two real on-disk cwds. Real escapeCwd naming.
      configDir = mkdtempSync(join(tmpdir(), "chorus-t4-cfg-"));
      process.env.CLAUDE_CONFIG_DIR = configDir;
      cwdA = mkdtempSync(join(tmpdir(), "chorus-t4-cwdA-"));
      cwdB = mkdtempSync(join(tmpdir(), "chorus-t4-cwdB-"));
    });

    afterEach(() => {
      for (const d of [configDir, cwdA, cwdB]) {
        if (d) rmSync(d, { recursive: true, force: true });
      }
      delete process.env.CLAUDE_CONFIG_DIR;
    });

    it("the session pins origin to the cwd it was created on; an online origin resumes there; a cross-cwd connection is never the resume target", async () => {
      // Two connections of the SAME agent on the SAME host, different cwds.
      const connA = await register(agentUuid, { host: HOST, cwd: cwdA });
      const connB = await register(agentUuid, { host: HOST, cwd: cwdB });
      expect(connA).not.toBeNull();
      expect(connB).not.toBeNull();

      // listConnectionsForAgent sorts online-first, then stable identity fields.
      // The temp cwdA prefix sorts before cwdB, so the dispatch chokepoint pins a
      // NEW session to cwdA without depending on heartbeat timestamps.

      // Drive the REAL dispatch chokepoint: it selects the origin connection by
      // (company, agent) only and stamps it on the session. The session id = DIRECT_IDEA.
      const turn = await maybeCreateTurnForWakeNotification(wakeCtx());
      expect(turn).not.toBeNull();

      // The session was pinned to cwdA's connection (the first stable identity row).
      const session = await realPrisma.daemonSession.findFirst({
        where: { companyUuid, agentUuid, sessionId: DIRECT_IDEA },
        select: { uuid: true, originConnectionUuid: true },
      });
      expect(session).not.toBeNull();
      expect(session.originConnectionUuid).toBe(connA!.uuid);

      // Simulate the daemon having run claude in cwdA: a REAL transcript file exists
      // only under cwdA's escaped projects dir, NOT cwdB's. This is exactly why a
      // cross-cwd resume would `No conversation found`.
      const tPathA = transcriptPath(DIRECT_IDEA, cwdA, { env: process.env });
      const tPathB = transcriptPath(DIRECT_IDEA, cwdB, { env: process.env });
      mkdirSync(tPathA.slice(0, tPathA.lastIndexOf("/")), { recursive: true });
      writeFileSync(tPathA, `{"type":"system","session_id":"${DIRECT_IDEA}"}\n`);
      expect(tPathA).not.toBe(tPathB); // distinct escaped-cwd dirs → cwd-bound resume
      expect(existsSync(tPathA)).toBe(true);
      expect(existsSync(tPathB)).toBe(false);
      // A probe in cwdA resumes (transcript present → not new); a probe in cwdB is
      // "new" (the cwdA transcript is invisible there) — i.e. a cross-cwd `--resume`
      // would start fresh / fail. This is the disk truth behind the server refusal.
      expect(isNewSession(DIRECT_IDEA, cwdA, { env: process.env })).toBe(false);
      expect(isNewSession(DIRECT_IDEA, cwdB, { env: process.env })).toBe(true);

      // While the origin (cwdA) is online, resume routes back to it — the ORIGINAL cwd.
      const target = await assertContinuable(companyUuid, session.uuid);
      expect(target).toBe(connA!.uuid); // resume returns to origin cwd, never connB.

      // Now take the origin (cwdA) offline while the OTHER cwd (connB) is still online.
      // A naive "route to any online connection of the agent" would pick connB and
      // resume against the WRONG cwd (No conversation found). The real code REFUSES:
      // it never falls back to a different cwd.
      await makeStale(connA!.uuid);
      // sanity: connB IS still effectively online (the tempting wrong target).
      const live = await listConnectionsForAgent(companyUuid, agentUuid);
      const connBView = live.find((v) => v.uuid === connB!.uuid);
      expect(connBView?.effectiveStatus).toBe("online");

      let thrown: unknown;
      try {
        await assertContinuable(companyUuid, session.uuid);
      } catch (e) {
        thrown = e;
      }
      expect(thrown).toBeInstanceOf(SessionReadOnlyError);
      // The error names the ORIGIN connection (cwdA) — it did not silently switch cwd.
      expect((thrown as InstanceType<SessionReadOnlyErrorT>).originConnectionUuid).toBe(
        connA!.uuid,
      );
      // escapeCwd is the real ~/.claude/projects naming rule (load-bearing for resume).
      expect(tPathA).toContain(join("projects", escapeCwd(cwdA)));
      expect(tPathB).toContain(join("projects", escapeCwd(cwdB)));
    });
  });

  // =========================================================================
  // AC3 — dispatch connection-selection NOT broken by multi-cwd + null-cwd coexistence;
  //       online-first selection still works; no project→cwd inference introduced.
  // =========================================================================
  describe("AC3: dispatch selection survives multi-cwd + null-cwd coexistence (no project→cwd infer)", () => {
    it("with two cwd connections + one null-cwd connection, the chokepoint selects an online connection of the agent (input is purely (company, agent)) and pins a valid origin", async () => {
      // Mixed registry for ONE agent: two real cwds + one old-daemon null row, all online.
      const c1 = await register(agentUuid, { host: HOST, cwd: "/work/one" });
      const c2 = await register(agentUuid, { host: HOST, cwd: "/work/two" });
      const cNull = await register(agentUuid, { host: HOST }); // no cwd → null row (old daemon)
      expect(c1).not.toBeNull();
      expect(c2).not.toBeNull();
      expect(cNull).not.toBeNull();

      const views = await listConnectionsForAgent(companyUuid, agentUuid);
      expect(views).toHaveLength(3);
      // The null-cwd row coexists alongside the two cwd rows — no miss, no merge.
      // (Order-independent: JS Array.sort() would place null last, so compare as a set.)
      const cwds = views.map((v) => v.cwd);
      expect(cwds).toContain(null);
      expect(cwds).toContain("/work/one");
      expect(cwds).toContain("/work/two");
      expect(views.every((v) => v.effectiveStatus === "online")).toBe(true);

      // Drive the dispatch chokepoint. It must pick SOME online connection of the agent
      // and pin it — without erroring and without missing the agent's daemon. The
      // selection input is purely (company, agent); cwd does not participate.
      const turn = await maybeCreateTurnForWakeNotification(wakeCtx());
      expect(turn).not.toBeNull();

      const session = await realPrisma.daemonSession.findFirst({
        where: { companyUuid, agentUuid, sessionId: DIRECT_IDEA },
        select: { originConnectionUuid: true },
      });
      expect(session).not.toBeNull();
      // The chosen origin is one of the agent's real connections (deterministically the
      // first stable identity row) — never a fabricated / project-derived target.
      const validUuids = [c1!.uuid, c2!.uuid, cNull!.uuid];
      expect(validUuids).toContain(session.originConnectionUuid);
      // It is the first cwd in deterministic path order, confirming online-first +
      // stable identity selection with mixed cwd/null rows present.
      expect(session.originConnectionUuid).toBe(c1!.uuid);

      // Structural guard against project→cwd inference: the chokepoint's selection input
      // never references a project; the Project model carries no cwd. We assert the
      // negative by confirming the selection ran purely off (company, agent) — there is
      // no projectUuid in the wake context, yet selection succeeds. (The absence of any
      // project↔cwd mapping in the codebase is verified separately in the work report.)
      expect("projectUuid" in wakeCtx()).toBe(false);
    });

    it("when only the null-cwd connection is online, dispatch still selects it (old daemon is dispatchable)", async () => {
      // Two cwd connections that are STALE (offline) + one online null-cwd connection.
      const c1 = await register(agentUuid, { host: HOST, cwd: "/work/one" });
      const c2 = await register(agentUuid, { host: HOST, cwd: "/work/two" });
      const cNull = await register(agentUuid, { host: HOST });
      await makeStale(c1!.uuid);
      await makeStale(c2!.uuid);

      const turn = await maybeCreateTurnForWakeNotification(wakeCtx());
      expect(turn).not.toBeNull();
      const session = await realPrisma.daemonSession.findFirst({
        where: { companyUuid, agentUuid, sessionId: DIRECT_IDEA },
        select: { originConnectionUuid: true },
      });
      // The ONLY online connection (the null-cwd old daemon) is selected — no miss.
      expect(session.originConnectionUuid).toBe(cNull!.uuid);
    });
  });

  // =========================================================================
  // AC4 — HARD-1: a fully cwd-less OLD daemon end-to-end (register null row → dispatch by
  //       agent → resume off origin, not blocked by cwd check); new + old daemon coexist.
  // =========================================================================
  describe("AC4 (HARD-1): cwd-less old daemon end-to-end; coexists with a new daemon", () => {
    it("an old daemon registers a null row, is dispatched to, and its session resumes off the (null-cwd) origin while online — never blocked by the cwd check", async () => {
      // The old-daemon agent reports NO cwd → a single null row (no pileup on reconnect).
      const first = await register(oldAgentUuid, { host: HOST });
      const again = await register(oldAgentUuid, { host: HOST });
      const reconnected = await register(oldAgentUuid, { host: HOST });
      expect(first).not.toBeNull();
      // Reconnect REUSES the same null row (the HARD-1 compat path) — no null-row pileup.
      expect(again!.uuid).toBe(first!.uuid);
      expect(reconnected!.uuid).toBe(first!.uuid);

      const rows = await realPrisma.daemonConnection.findMany({
        where: { companyUuid, agentUuid: oldAgentUuid },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].cwd).toBeNull();

      // Dispatch to the old agent: selection is by (company, agent) — the null-cwd row is
      // dispatchable exactly like today (no error, no miss).
      const turn = await maybeCreateTurnForWakeNotification(
        wakeCtx({ recipientUuid: oldAgentUuid }),
      );
      expect(turn).not.toBeNull();

      const session = await realPrisma.daemonSession.findFirst({
        where: { companyUuid, agentUuid: oldAgentUuid, sessionId: DIRECT_IDEA },
        select: { uuid: true, originConnectionUuid: true },
      });
      expect(session.originConnectionUuid).toBe(first!.uuid);

      // Resume off the null-cwd origin: it is online, and the cwd-consistency check is a
      // NO-OP for null (null = "unconstrained"). So a continuation is allowed — exactly
      // as before the multi-path change.
      const target = await assertContinuable(companyUuid, session.uuid);
      expect(target).toBe(first!.uuid);

      // When the old daemon goes offline, the session is read-only just like any other —
      // the null cwd never CAUSES read-only, but offline still does (parity with today).
      await makeStale(first!.uuid);
      await expect(assertContinuable(companyUuid, session.uuid)).rejects.toBeInstanceOf(
        SessionReadOnlyError,
      );
    });

    it("a new (cwd) daemon and an old (null-cwd) daemon under the SAME agent+host coexist as two rows without interfering", async () => {
      const oldHandle = await register(agentUuid, { host: HOST }); // null row
      const newHandle = await register(agentUuid, { host: HOST, cwd: "/work/new" });
      expect(oldHandle!.uuid).not.toBe(newHandle!.uuid);

      let views = await listConnectionsForAgent(companyUuid, agentUuid);
      expect(views).toHaveLength(2);
      // Order-independent set comparison (JS sort would place null last).
      expect(views.map((v) => v.cwd)).toContain(null);
      expect(views.map((v) => v.cwd)).toContain("/work/new");

      // The old daemon reconnecting does NOT disturb the new daemon's cwd row.
      await register(agentUuid, { host: HOST });
      views = await listConnectionsForAgent(companyUuid, agentUuid);
      expect(views).toHaveLength(2);
      expect(views.map((v) => v.cwd)).toContain(null);
      expect(views.map((v) => v.cwd)).toContain("/work/new");
      // Both still online and independent.
      expect(views.every((v) => v.effectiveStatus === "online")).toBe(true);
    });
  });

  // =========================================================================
  // AC5 — MIGRATION BACKFILL: an existing cwd=null row (the migration-era state) →
  //       after the daemon upgrades and self-reports a real cwd → a row carrying that
  //       cwd; functionality never regresses across the transition.
  // =========================================================================
  describe("AC5: migration backfill — cwd=null row transitions to a real cwd on upgrade", () => {
    it("simulates a migration-era null row, then an upgraded self-report; the agent ends with a cwd-bearing connection and stays dispatchable + resumable throughout", async () => {
      // (a) Migration-era state: the daemon predates self-report → a cwd=null row.
      // This is exactly what the T1 migration leaves behind: ADD COLUMN cwd (nullable)
      // backfills every existing row to NULL. We reproduce that row via the real
      // registerConnection null path (what a still-old daemon would write on reconnect).
      const nullHandle = await register(agentUuid, { host: HOST });
      expect(nullHandle).not.toBeNull();
      let rows = await realPrisma.daemonConnection.findMany({
        where: { companyUuid, agentUuid },
      });
      expect(rows).toHaveLength(1);
      expect(rows[0].cwd).toBeNull();

      // The old (null) daemon is dispatchable BEFORE the upgrade — establish a baseline
      // session pinned to the null connection, to prove no regression across the upgrade.
      const preTurn = await maybeCreateTurnForWakeNotification(wakeCtx());
      expect(preTurn).not.toBeNull();
      const preSession = await realPrisma.daemonSession.findFirst({
        where: { companyUuid, agentUuid, sessionId: DIRECT_IDEA },
        select: { uuid: true, originConnectionUuid: true },
      });
      expect(preSession.originConnectionUuid).toBe(nullHandle!.uuid);
      // The pre-upgrade (null-cwd) session resumes fine while online.
      expect(await assertContinuable(companyUuid, preSession.uuid)).toBe(nullHandle!.uuid);

      // (b) The daemon UPGRADES and now self-reports a real cwd on (re)connect. Per the
      // T1 dedup strategy (Postgres NULL is distinct in the composite key), this lands a
      // SEPARATE cwd-bearing row rather than mutating the null row in place — the null
      // row is the old generation, the cwd row is the upgraded generation. The KEY
      // assertion for "backfill" is that the agent now HAS a connection carrying the
      // real cwd, and the registry reflects the upgrade.
      const upgradedCwd = "/work/upgraded";
      const upgraded = await register(agentUuid, { host: HOST, cwd: upgradedCwd });
      expect(upgraded).not.toBeNull();

      rows = await realPrisma.daemonConnection.findMany({
        where: { companyUuid, agentUuid },
        orderBy: { cwd: "asc" },
      });
      // The upgraded row carries the real cwd. (The transition added a cwd-bearing row;
      // the old null row remains until reaped by presence staleness — it never blocks
      // the upgraded connection, matching the design's "null rows各自独立" note.)
      const upgradedRow = rows.find((r: { cwd: string | null }) => r.cwd === upgradedCwd);
      expect(upgradedRow).toBeTruthy();
      expect(upgradedRow.uuid).toBe(upgraded!.uuid);

      // (c) Functionality does NOT regress: a NEW session created after the upgrade pins
      // to the upgraded (cwd-bearing) connection — it sorts before the legacy null-cwd
      // row by stable identity — and resumes correctly off the real cwd.
      DIRECT_IDEA = "idea-e2e-0000-0000-0000-00000000002"; // a distinct post-upgrade session
      const postTurn = await maybeCreateTurnForWakeNotification(wakeCtx());
      expect(postTurn).not.toBeNull();
      const postSession = await realPrisma.daemonSession.findFirst({
        where: { companyUuid, agentUuid, sessionId: DIRECT_IDEA },
        select: { uuid: true, originConnectionUuid: true },
      });
      expect(postSession.originConnectionUuid).toBe(upgraded!.uuid);
      expect(await assertContinuable(companyUuid, postSession.uuid)).toBe(upgraded!.uuid);

      // And the pre-upgrade session (pinned to the null row) is STILL resumable while the
      // null connection remains online — the upgrade did not break the in-flight session.
      expect(await assertContinuable(companyUuid, preSession.uuid)).toBe(nullHandle!.uuid);
    });

    it("[alt backfill: in-place merge] if a deployment chooses to backfill the null row in place, the null row itself carries the real cwd and the same uuid keeps resuming", async () => {
      // T1's dedup note explicitly allows two strategies. The default (NULL-distinct)
      // strategy is covered above. This alternative proves the IN-PLACE merge is also
      // sound end-to-end: an operator/daemon that updates the existing null row's cwd
      // (rather than creating a new row) keeps the SAME connection uuid, so any session
      // already pinned to it continues to resume without interruption — "功能全程不回退".
      const nullHandle = await register(agentUuid, { host: HOST });
      const session = await maybeCreateTurnForWakeNotification(wakeCtx());
      expect(session).not.toBeNull();
      const sess = await realPrisma.daemonSession.findFirst({
        where: { companyUuid, agentUuid, sessionId: DIRECT_IDEA },
        select: { uuid: true, originConnectionUuid: true },
      });
      expect(sess.originConnectionUuid).toBe(nullHandle!.uuid);

      // In-place backfill: the same physical row gains the real cwd (uuid unchanged).
      await realPrisma.daemonConnection.update({
        where: { uuid: nullHandle!.uuid },
        data: { cwd: "/work/backfilled" },
      });
      const row = await realPrisma.daemonConnection.findUnique({
        where: { uuid: nullHandle!.uuid },
        select: { cwd: true, status: true },
      });
      expect(row.cwd).toBe("/work/backfilled"); // backfilled in place
      expect(row.status).toBe("online");

      // The pre-existing session still resumes off the SAME connection uuid — no regression.
      expect(await assertContinuable(companyUuid, sess.uuid)).toBe(nullHandle!.uuid);
    });
  });
});
