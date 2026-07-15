// Integration checkpoint for idea 2ddd1d11 (fix-daemon-conversation-split-cwd-agent):
// the server RE-POINT composed with the UI interrupt match, proven against a REAL Postgres
// through the actual services — not mocks. This is the headless-runnable core of the
// integration task (12743874). The purely-visual legs (clicking Interrupt in a browser,
// two live daemons/agents streaming) still need a human; everything below the browser —
// the DaemonSession row shape after a cross-cwd directed wake, and that the UI's
// executionMatchesSession then resolves that idea's execution — is exercised end-to-end
// here against real DB rows.
//
// WHAT IT PROVES
//   (R1) A directed cross-cwd idea wake RE-POINTS the idea's single canonical DaemonSession
//        (originConnectionUuid moves to the resolved online connection) instead of forking a
//        second `${idea}::${conn}` row. One row, sessionId === idea, directIdeaUuid non-null.
//   (R2) The turn created by that wake lands on the SAME canonical session (no orphan row),
//        so the user's turn and the daemon's later transcript/turn-lifecycle reports (which
//        re-derive the plain idea uuid) share one conversation.
//   (R3) executionMatchesSession (the UI predicate) resolves the daemon's `idea:<X>`
//        execution against that re-pointed session — i.e. interrupt would find the running
//        turn — AND still matches even for a legacy residual `${idea}::${conn}` row.
//
// HOW TO RUN (never touches the live store — gated exactly like the multipath e2e):
//   docker run -d --name chorus-repoint-pg -e POSTGRES_USER=t -e POSTGRES_PASSWORD=t \
//     -e POSTGRES_DB=t -p 127.0.0.1:55445:5432 postgres:16-alpine
//   DATABASE_URL="postgresql://t:t@127.0.0.1:55445/t" npx prisma migrate deploy
//   T4_REAL_DB_URL="postgresql://t:t@127.0.0.1:55445/t" \
//     npx vitest run src/services/__tests__/daemon-conversation-repoint.integration.test.ts
//
// When T4_REAL_DB_URL is NOT set (the default for `pnpm test` / CI), the WHOLE suite is
// skipped — so it never connects to a DB it shouldn't (never touches the live PGlite store).

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { executionMatchesSession } from "@/components/agent-presence/chat/session-execution";

const REAL_DB_URL = process.env.T4_REAL_DB_URL;
const describeReal = REAL_DB_URL ? describe : describe.skip;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let realPrisma: any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let pool: any;

type RegisterConnection = typeof import("@/services/daemon-connection.service")["registerConnection"];
type ParseSelfReport = typeof import("@/services/daemon-connection.service")["parseSelfReport"];
type CreateTurnAndResolveTarget =
  typeof import("@/services/notification-turn")["createTurnAndResolveTarget"];

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let registerConnection: (...args: Parameters<RegisterConnection>) => Promise<any>;
let parseSelfReport: ParseSelfReport;
let createTurnAndResolveTarget: CreateTurnAndResolveTarget;

const companyUuid = "company-rp-0000-0000-000000000001";
const agentUuid = "agent-rp-0000-0000-0000-000000000001";
const HOST = "mac.local";
const CWD_A = "/work/ai-pm";
const CWD_B = "/work/strands";
// A fixed idea uuid so the session key is deterministic (lineage is faked to it below).
const IDEA = "idea-rp00-0000-0000-0000-000000000001";

describeReal("daemon conversation re-point — REAL Postgres (idea 2ddd1d11 integration checkpoint)", () => {
  beforeAll(async () => {
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
    // Fake ONLY lineage so the wake's entity resolves to our fixed idea (the session anchor).
    vi.doMock("@/services/lineage.service", () => ({
      resolveRootIdea: async () => ({
        rootIdeaUuid: IDEA,
        directIdeaUuid: IDEA,
        lineage: [],
        resolvedVia: "via_proposal",
      }),
    }));
    // Neutralize the directed-delivery ping (no event bus in this harness) — the durable
    // row state is what we assert, exactly as the multipath e2e does.
    vi.doMock("@/services/daemon-instruction.service", () => ({
      deliverTurnPing: () => {},
    }));

    const connSvc = await import("@/services/daemon-connection.service");
    registerConnection = connSvc.registerConnection as typeof registerConnection;
    parseSelfReport = connSvc.parseSelfReport;

    const bridge = await import("@/services/notification-turn");
    createTurnAndResolveTarget = bridge.createTurnAndResolveTarget;

    await realPrisma.company.upsert({
      where: { uuid: companyUuid },
      create: { uuid: companyUuid, name: "RP Co" },
      update: {},
    });
    await realPrisma.agent.upsert({
      where: { uuid: agentUuid },
      create: { uuid: agentUuid, companyUuid, name: "RP Agent", roles: [], permissions: [] },
      update: {},
    });
  });

  afterAll(async () => {
    if (realPrisma) {
      const sessions = await realPrisma.daemonSession.findMany({
        where: { companyUuid },
        select: { uuid: true },
      });
      const uuids = sessions.map((s: { uuid: string }) => s.uuid);
      if (uuids.length) {
        await realPrisma.daemonSessionTurn.deleteMany({ where: { sessionUuid: { in: uuids } } });
      }
      await realPrisma.daemonSession.deleteMany({ where: { companyUuid } });
      await realPrisma.daemonConnection.deleteMany({ where: { companyUuid } });
      await realPrisma.agent.deleteMany({ where: { companyUuid } });
      await realPrisma.company.deleteMany({ where: { uuid: companyUuid } });
      await realPrisma.$disconnect();
    }
    if (pool) await pool.end();
  });

  beforeEach(async () => {
    const sessions = await realPrisma.daemonSession.findMany({
      where: { companyUuid },
      select: { uuid: true },
    });
    const uuids = sessions.map((s: { uuid: string }) => s.uuid);
    if (uuids.length) {
      await realPrisma.daemonSessionTurn.deleteMany({ where: { sessionUuid: { in: uuids } } });
    }
    await realPrisma.daemonSession.deleteMany({ where: { companyUuid } });
    await realPrisma.daemonConnection.deleteMany({ where: { companyUuid } });
  });

  async function register(cwd: string) {
    const sp = new URLSearchParams({ clientType: "claude_code", host: HOST, cwd });
    return registerConnection(companyUuid, agentUuid, parseSelfReport(sp));
  }

  it("a directed cross-cwd wake RE-POINTS the one canonical session — no `::` fork — and the UI match resolves its execution", async () => {
    // Two online cwd instances of the same agent. cwd A owns the idea's conversation.
    const connA = await register(CWD_A);
    const connB = await register(CWD_B);
    expect(connA!.uuid).not.toBe(connB!.uuid);

    // (1) First wake, un-pinned → online-first lands on the idea's canonical session on
    // whichever connection is online-first. Force it onto A by pinning A.
    await createTurnAndResolveTarget({
      companyUuid,
      recipientType: "agent",
      recipientUuid: agentUuid,
      entityType: "idea",
      entityUuid: IDEA,
      action: "mentioned",
      pinnedHost: HOST,
      pinnedCwd: CWD_A,
    });

    let sessions = await realPrisma.daemonSession.findMany({ where: { companyUuid } });
    expect(sessions).toHaveLength(1);
    expect(sessions[0].sessionId).toBe(IDEA);
    expect(sessions[0].directIdeaUuid).toBe(IDEA);
    expect(sessions[0].originConnectionUuid).toBe(connA!.uuid);
    const canonicalUuid = sessions[0].uuid;

    // (2) A directed cross-cwd wake resolves to cwd B (a DIFFERENT connection than the
    // idea's existing session origin). It MUST re-point the SAME row, not fork.
    await createTurnAndResolveTarget({
      companyUuid,
      recipientType: "agent",
      recipientUuid: agentUuid,
      entityType: "idea",
      entityUuid: IDEA,
      action: "mentioned",
      pinnedHost: HOST,
      pinnedCwd: CWD_B,
    });

    sessions = await realPrisma.daemonSession.findMany({ where: { companyUuid } });
    // STILL exactly one session — no `${idea}::${conn}` fork row was created.
    expect(sessions).toHaveLength(1);
    expect(sessions[0].uuid).toBe(canonicalUuid);
    expect(sessions[0].sessionId).toBe(IDEA);
    expect(sessions[0].directIdeaUuid).toBe(IDEA);
    // Re-pointed to the resolved online origin (cwd B).
    expect(sessions[0].originConnectionUuid).toBe(connB!.uuid);
    // No residual `::` session anywhere.
    expect(
      sessions.some((s: { sessionId: string }) => s.sessionId.includes("::")),
    ).toBe(false);

    // (3) Both wakes' turns landed on the ONE canonical session (no orphan turn on a
    // second row) — user turn + AI reports share the conversation.
    const turns = await realPrisma.daemonSessionTurn.findMany({
      where: { sessionUuid: canonicalUuid },
    });
    expect(turns.length).toBeGreaterThanOrEqual(2);

    // (4) The UI interrupt predicate resolves the daemon's `idea:<IDEA>` execution against
    // the re-pointed session — i.e. Interrupt would find the running turn on this thread.
    const uiSession = {
      sessionId: sessions[0].sessionId,
      directIdeaUuid: sessions[0].directIdeaUuid,
    };
    expect(
      executionMatchesSession(
        { entityType: "idea", entityUuid: IDEA, directIdeaUuid: IDEA },
        uiSession,
      ),
    ).toBe(true);
  });

  it("a legacy residual `${idea}::${conn}` row (directIdeaUuid=null) is still matched by the UI predicate (fix-forward heal)", async () => {
    // Simulate a pre-fix residual row created by the OLD fork behavior: seed it directly,
    // then prove the UI predicate recovers the idea from the `::` prefix so its Interrupt
    // reaches the idea's execution — with NO migration of the row.
    const connA = await register(CWD_A);
    const residualSessionId = `${IDEA}::${connA!.uuid}`;
    await realPrisma.daemonSession.create({
      data: {
        companyUuid,
        agentUuid,
        sessionId: residualSessionId,
        directIdeaUuid: null,
        originConnectionUuid: connA!.uuid,
        status: "active",
      },
    });

    const row = await realPrisma.daemonSession.findFirst({
      where: { companyUuid, sessionId: residualSessionId },
      select: { sessionId: true, directIdeaUuid: true },
    });
    expect(row.directIdeaUuid).toBeNull();

    // The UI predicate recovers idea from the `::` prefix and matches the daemon's idea exec.
    expect(
      executionMatchesSession(
        { entityType: "idea", entityUuid: IDEA, directIdeaUuid: IDEA },
        { sessionId: row.sessionId, directIdeaUuid: row.directIdeaUuid },
      ),
    ).toBe(true);
    // A different idea does not match the residual row.
    expect(
      executionMatchesSession(
        { entityType: "idea", entityUuid: "idea-OTHER", directIdeaUuid: "idea-OTHER" },
        { sessionId: row.sessionId, directIdeaUuid: row.directIdeaUuid },
      ),
    ).toBe(false);
  });
});
