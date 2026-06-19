// src/services/__tests__/daemon-instruction-injection.integration.test.ts
//
// INTEGRATION CHECKPOINT (子2 — daemon-instruction-injection, final convergence task).
//
// Tasks 1 (server send-side), 2 (deliver_turn delivery), and 3 (frontend) shipped the
// pieces of UI → daemon instruction injection. This test is the convergence point: it
// wires the REAL composition together — NOT isolated mocks of each piece — against ONE
// stateful in-memory prisma fake plus the REAL in-process event bus, mirroring the 子1
// integration harness (daemon-session-conversation.integration.test.ts):
//
//   daemon-instruction.service                 (REAL — sendInstruction /
//                                                createAdHocSessionWithInstruction /
//                                                deliverTurnPing)
//     → notification.service.create            (REAL — the wake chokepoint)
//       → notification-turn bridge             (REAL — maybeCreateTurnForWakeNotification)
//         → daemon-session.service             (REAL — resolveOrCreateSession +
//                                                createPendingTurn + assertContinuable +
//                                                getPendingTurnsForConnection)
//     → daemon-control.service.dispatchControl (REAL — emits the deliver_turn ControlEvent
//                                                on control:{originConnectionUuid})
//   GET /api/daemon/pending-turns route         (REAL handler — the connection-scoped sweep
//                                                read the daemon's backfill drives)
//   POST /api/daemon/turn-advance route         (REAL handler — the daemon advancing a turn)
//
// Daemon side (the .mjs control + sweep path) is driven REAL too: the actual
// `createControlHandler` (control-handler.mjs) receives the live ControlEvent off the
// event bus and, on a Check-1 match, runs `backfill.pendingTurnsOnly` (backfill.mjs) wired
// to a fetch that hits the REAL pending-turns route handler, which feeds the REAL
// EventRouter.dispatchPendingTurn (event-router.mjs) → a stub WakeQueue.enqueue → wake.
// We do NOT spawn a real `claude` process — a true browser+claude headless e2e is NOT
// runnable in this environment (documented as AC5's explicit limitation); the wake itself
// is the injected WakeQueue.enqueue boundary, exactly as the daemon's own unit tests stub
// it. Everything UP TO the wake is the real code path.
//
// Only the leaf I/O is faked: prisma (a stateful store, so every function reads what the
// previous one wrote — the thing per-task mocks cannot prove), the logger (silenced),
// lineage (direct-idea resolution), and the connection registry's online/offline listing
// (so the chokepoint pins an origin). The services + routes + daemon control/sweep are NOT
// mocked, so the seams are genuinely exercised.
//
// The 5 AC threads, end-to-end:
//   (1) Send to an EXISTING idea-anchored session → the human_instruction turn lands on the
//       SAME DaemonSession row (no duplicate (agentUuid,sessionId); seq increments;
//       promptText == submitted text). THE session-key-alignment correctness point.
//   (2) Origin-only delivery → two online connections; the live deliver_turn control event
//       targets ONLY originConnectionUuid; the daemon control-handler ignores a Check-1
//       mismatch (no-op) and on a match drives the connection-scoped pending-turns sweep →
//       dispatchPendingTurn → wake.
//   (3) Durability → a lost live ping; the reconnect pending-turns backfill re-derives + runs
//       the same turn exactly once (shared seen-set dedup).
//   (4) Offline origin → send returns SessionReadOnlyError (route → 409), no turn created,
//       no re-route to the other connection.
//   (5) Ad-hoc create-and-send → server-generated sessionId, session pinned to the chosen
//       connection, first human_instruction turn created; resumable on that connection.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ===== Stateful in-memory prisma fake =====
//
// Supports exactly the query shapes the real code paths under test use. Each model is an
// array of rows; ids/uuids auto-assigned on create. This is the crux of the integration
// test: a SINGLE store the real functions write to and read from in turn.

interface Row {
  [k: string]: unknown;
}

function makeStore() {
  const data = {
    daemonSession: [] as Row[],
    daemonSessionTurn: [] as Row[],
    daemonConnection: [] as Row[],
    daemonExecution: [] as Row[],
    notification: [] as Row[],
    agent: [] as Row[],
  };
  let autoId = 1;
  let autoUuid = 1;
  const nextId = () => autoId++;
  const nextUuid = (prefix: string) => `${prefix}-${String(autoUuid++).padStart(4, "0")}`;
  return { data, nextId, nextUuid };
}

type Store = ReturnType<typeof makeStore>;

// Match a row against a Prisma `where` clause. Supports scalar equality, the
// `{ not: ... }` / `{ in: [...] }` operators, and the nested relation filters the code
// uses (turn.session.*, the owner scope `agent.ownerUuid`).
function matchWhere(store: Store, model: keyof Store["data"], row: Row, where: Row): boolean {
  for (const [key, cond] of Object.entries(where ?? {})) {
    if (cond === undefined) continue;

    // Nested relation filters.
    if (key === "session" && model === "daemonSessionTurn") {
      const session = store.data.daemonSession.find((s) => s.uuid === row.sessionUuid);
      if (!session) return false;
      if (!matchWhere(store, "daemonSession", session, cond as Row)) return false;
      continue;
    }
    if (key === "agent" && model === "daemonSession") {
      // Owner-scope fence: daemonSession.agent.ownerUuid. Resolve the agent row by the
      // session's agentUuid and match the nested condition (only a USER/super_admin
      // caller hits this; agent-key auth uses a flat agentUuid scope).
      const agent = store.data.agent.find((a) => a.uuid === row.agentUuid);
      if (!agent) return false;
      if (!matchWhere(store, "agent", agent, cond as Row)) return false;
      continue;
    }

    const val = row[key];
    if (cond !== null && typeof cond === "object") {
      const c = cond as Row;
      if ("not" in c) {
        if (val === c.not) return false;
        continue;
      }
      if ("in" in c) {
        if (!Array.isArray(c.in) || !(c.in as unknown[]).includes(val)) return false;
        continue;
      }
      // Unknown operator object — treat as no match to surface a gap loudly.
      return false;
    }
    if (val !== cond) return false;
  }
  return true;
}

// Apply a Prisma `orderBy` (single object or array) to a list. Supports scalar fields
// plus the `session.createdAt` nested order the backfill uses.
function applyOrderBy(store: Store, model: keyof Store["data"], rows: Row[], orderBy: unknown): Row[] {
  if (!orderBy) return rows;
  const orders = Array.isArray(orderBy) ? orderBy : [orderBy];
  return [...rows].sort((a, b) => {
    for (const o of orders as Row[]) {
      for (const [field, dir] of Object.entries(o)) {
        let av: unknown;
        let bv: unknown;
        if (field === "session" && model === "daemonSessionTurn") {
          const sa = store.data.daemonSession.find((s) => s.uuid === a.sessionUuid) ?? {};
          const sb = store.data.daemonSession.find((s) => s.uuid === b.sessionUuid) ?? {};
          const inner = Object.entries(dir as Row)[0];
          av = (sa as Row)[inner[0]];
          bv = (sb as Row)[inner[0]];
          const d2 = inner[1];
          const cmp = compare(av, bv);
          if (cmp !== 0) return d2 === "desc" ? -cmp : cmp;
          continue;
        }
        av = a[field];
        bv = b[field];
        const cmp = compare(av, bv);
        if (cmp !== 0) return dir === "desc" ? -cmp : cmp;
      }
    }
    return 0;
  });
}

// Materialize a Prisma `select` for the one relation the code under test reads through
// it: `daemonSessionTurn.select.session` (the backfill query). Scalar selects are left
// as-is (the services map full rows; extra fields are harmless). Never throws.
function projectSelect(
  store: Store,
  model: keyof Store["data"],
  row: Row,
  select: Row | undefined,
): Row {
  if (!select) return row;
  if (model === "daemonSessionTurn" && select.session) {
    const session = store.data.daemonSession.find((s) => s.uuid === row.sessionUuid);
    const sel = (select.session as Row).select as Row | undefined;
    if (session) {
      if (sel) {
        const picked: Row = {};
        for (const k of Object.keys(sel)) picked[k] = session[k];
        row.session = picked;
      } else {
        row.session = { ...session };
      }
    } else {
      row.session = null;
    }
  }
  return row;
}

function compare(a: unknown, b: unknown): number {
  if (a instanceof Date && b instanceof Date) return a.getTime() - b.getTime();
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "string" && typeof b === "string") return a < b ? -1 : a > b ? 1 : 0;
  return 0;
}

function buildPrismaFake(store: Store) {
  function findMany(model: keyof Store["data"], args: Row = {}) {
    let rows = store.data[model].filter((r) => matchWhere(store, model, r, (args.where as Row) ?? {}));
    rows = applyOrderBy(store, model, rows, args.orderBy);
    if (typeof args.take === "number") rows = rows.slice(0, args.take as number);
    return rows.map((r) => projectSelect(store, model, { ...r }, args.select as Row | undefined));
  }
  function findFirst(model: keyof Store["data"], args: Row = {}) {
    const rows = findMany(model, args);
    return rows.length > 0 ? rows[0] : null;
  }
  function count(model: keyof Store["data"], args: Row = {}) {
    return store.data[model].filter((r) => matchWhere(store, model, r, (args.where as Row) ?? {})).length;
  }

  return {
    daemonSession: {
      upsert: vi.fn(async (args: Row) => {
        const where = (args.where as Row).agentUuid_sessionId as Row;
        const existing = store.data.daemonSession.find(
          (s) => s.agentUuid === where.agentUuid && s.sessionId === where.sessionId,
        );
        if (existing) {
          Object.assign(existing, args.update as Row, { updatedAt: new Date() });
          return { ...existing };
        }
        const now = new Date();
        const row: Row = {
          id: store.nextId(),
          uuid: store.nextUuid("session"),
          status: "active",
          title: null,
          directIdeaUuid: null,
          lastTurnAt: now,
          createdAt: now,
          updatedAt: now,
          ...(args.create as Row),
        };
        store.data.daemonSession.push(row);
        return { ...row };
      }),
      findUnique: vi.fn(async (args: Row) => findFirst("daemonSession", { where: args.where })),
      findFirst: vi.fn(async (args: Row) => findFirst("daemonSession", args)),
      findMany: vi.fn(async (args: Row) => findMany("daemonSession", args)),
      update: vi.fn(async (args: Row) => {
        const row = store.data.daemonSession.find((s) => s.uuid === (args.where as Row).uuid);
        if (!row) throw new Error("session not found for update");
        Object.assign(row, args.data as Row, { updatedAt: new Date() });
        return { ...row };
      }),
    },
    daemonSessionTurn: {
      findFirst: vi.fn(async (args: Row) => findFirst("daemonSessionTurn", args)),
      findUnique: vi.fn(async (args: Row) =>
        findFirst("daemonSessionTurn", { where: args.where }),
      ),
      findMany: vi.fn(async (args: Row) => findMany("daemonSessionTurn", args)),
      create: vi.fn(async (args: Row) => {
        const row: Row = {
          id: store.nextId(),
          uuid: store.nextUuid("turn"),
          promptText: null,
          executionUuid: null,
          startedAt: null,
          endedAt: null,
          createdAt: new Date(),
          ...(args.data as Row),
        };
        store.data.daemonSessionTurn.push(row);
        return { ...row };
      }),
      update: vi.fn(async (args: Row) => {
        const row = store.data.daemonSessionTurn.find((t) => t.uuid === (args.where as Row).uuid);
        if (!row) throw new Error("turn not found for update");
        Object.assign(row, args.data as Row);
        return { ...row };
      }),
    },
    daemonConnection: {
      findFirst: vi.fn(async (args: Row) => findFirst("daemonConnection", args)),
      findMany: vi.fn(async (args: Row) => findMany("daemonConnection", args)),
      count: vi.fn(async (args: Row) => count("daemonConnection", args)),
    },
    daemonExecution: {
      findFirst: vi.fn(async (args: Row) => findFirst("daemonExecution", args)),
    },
    notification: {
      create: vi.fn(async (args: Row) => {
        const row: Row = {
          id: store.nextId(),
          uuid: store.nextUuid("notif"),
          readAt: null,
          archivedAt: null,
          instructionText: null,
          createdAt: new Date(),
          ...(args.data as Row),
        };
        store.data.notification.push(row);
        return { ...row };
      }),
      count: vi.fn(async (args: Row) => count("notification", args)),
      findMany: vi.fn(async (args: Row) => findMany("notification", args)),
    },
    agent: {
      count: vi.fn(async (args: Row) => count("agent", args)),
    },
  };
}

// ===== Module mocks =====
//
// The store + prisma fake are built inside vi.hoisted so they exist when the hoisted
// vi.mock factory below runs (factories are lifted above normal module-scope consts).

const hoisted = vi.hoisted(() => {
  const s = makeStore();
  return { store: s, prismaFake: buildPrismaFake(s) };
});
const store = hoisted.store;
vi.mock("@/lib/prisma", () => ({ prisma: hoisted.prismaFake }));

// Silence the logger; the real event bus is used (in-process EventEmitter, Redis off).
const mockLogger = vi.hoisted(() => {
  const l = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), child: () => l };
  return l;
});
vi.mock("@/lib/logger", () => ({
  default: mockLogger,
  // api-handler.ts (the route wrapper) builds a per-request logger; provide it so the
  // REAL route handlers run.
  createRequestLogger: () => mockLogger,
}));

// Lineage: an idea-anchored session resolves an idea uuid to ITSELF (identity), so the
// chokepoint's derived sessionId equals the session's own sessionId. Everything else → null.
const mockResolveRootIdea = vi.hoisted(() => vi.fn());
vi.mock("@/services/lineage.service", () => ({
  resolveRootIdea: mockResolveRootIdea,
}));

// Connection registry: the chokepoint asks for the agent's online connections to pin an
// origin. We drive online/offline here. STALE_THRESHOLD_MS must be REAL (the session
// service re-exports it and assertContinuable/isConnectionLive compare against it), so
// partially mock.
const mockListConnectionsForAgent = vi.hoisted(() => vi.fn());
vi.mock("@/services/daemon-connection.service", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    listConnectionsForAgent: mockListConnectionsForAgent,
  };
});

// Auth: the route handlers call getAuthContext(request); return a fixed agent context.
const COMPANY = "company-int-0001";
const AGENT = "agent-int-0001";
const mockGetAuthContext = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({ getAuthContext: mockGetAuthContext }));

// ===== Imports under test (REAL — server) =====
import * as instructionService from "@/services/daemon-instruction.service";
import { SessionReadOnlyError } from "@/services/daemon-session.service";
import { eventBus, controlEventName, type ControlEvent } from "@/lib/event-bus";
import { GET as pendingTurnsRouteGET } from "@/app/api/daemon/pending-turns/route";
import { POST as turnAdvanceRoutePOST } from "@/app/api/daemon/turn-advance/route";

// ===== Imports under test (REAL — daemon .mjs side) =====
//
// The daemon CLI is plain ESM with hint-only JSDoc — its opt/return shapes are not full
// TS types (e.g. EventRouter reads `opts.seen` without documenting it; `createBackfill`'s
// return has `pendingTurnsOnly` attached at runtime). At this .ts ↔ .mjs interop boundary
// we re-bind to permissive locals: we are running the REAL functions, only loosening the
// JSDoc-derived static shape that strict TS would otherwise reject.
import { createControlHandler as createControlHandlerRaw } from "../../../cli/control-handler.mjs";
import { createBackfill as createBackfillRaw } from "../../../cli/backfill.mjs";
import { EventRouter as EventRouterRaw } from "../../../cli/event-router.mjs";

/* eslint-disable @typescript-eslint/no-explicit-any */
const createControlHandler = createControlHandlerRaw as (deps: any) => (event: any) => void;
const createBackfill = createBackfillRaw as (
  opts: any,
) => (() => Promise<void>) & { pendingTurnsOnly: (turnUuid?: string) => Promise<void> };
const EventRouter = EventRouterRaw as new (opts: any) => {
  dispatch: (event: any) => void;
  dispatchPendingTurn: (pending: any) => void;
};
/* eslint-enable @typescript-eslint/no-explicit-any */

// ===== Fixtures =====
const IDEA = "idea-int-0001";
const TASK = "task-int-0001";
const ORIGIN_CONN = "conn-origin-0001";
const OTHER_CONN = "conn-other-0002";

const agentAuth = { type: "agent" as const, companyUuid: COMPANY, actorUuid: AGENT };

function getReq(url: string): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    method: "GET",
    headers: { authorization: "Bearer cho_test" },
  });
}

function postReq(url: string, body: unknown): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer cho_test" },
    body: JSON.stringify(body),
  });
}

// withErrorHandler-wrapped routes take (request, { params }) — these routes ignore params,
// so an empty resolved-params context satisfies the signature.
const emptyCtx = { params: Promise.resolve({}) };
const pendingTurnsGET = (req: NextRequest) => pendingTurnsRouteGET(req, emptyCtx);
const turnAdvancePOST = (req: NextRequest) => turnAdvanceRoutePOST(req, emptyCtx);

// Seed two online connections for the agent in the store (origin + one other), and the
// agent row itself (so an owner-scoped read can resolve, even though we use agent-key auth).
function seedConnections() {
  const now = new Date();
  store.data.daemonConnection.push(
    {
      id: store.nextId(),
      uuid: ORIGIN_CONN,
      companyUuid: COMPANY,
      agentUuid: AGENT,
      status: "online",
      lastSeenAt: now,
    },
    {
      id: store.nextId(),
      uuid: OTHER_CONN,
      companyUuid: COMPANY,
      agentUuid: AGENT,
      status: "online",
      lastSeenAt: now,
    },
  );
  store.data.agent.push({
    id: store.nextId(),
    uuid: AGENT,
    companyUuid: COMPANY,
    ownerUuid: "user-int-0001",
  });
}

// Pre-create an idea-anchored DaemonSession for the agent (pinned to ORIGIN_CONN) the way
// 子1's chokepoint would have — so AC1/2/4 send to an EXISTING session.
function seedIdeaAnchoredSession(): { uuid: string } {
  const now = new Date();
  const row: Row = {
    id: store.nextId(),
    uuid: store.nextUuid("session"),
    companyUuid: COMPANY,
    agentUuid: AGENT,
    sessionId: IDEA, // idea-anchored: sessionId === directIdeaUuid
    directIdeaUuid: IDEA,
    originConnectionUuid: ORIGIN_CONN,
    status: "active",
    title: null,
    lastTurnAt: now,
    createdAt: now,
    updatedAt: now,
  };
  store.data.daemonSession.push(row);
  return { uuid: row.uuid as string };
}

beforeEach(() => {
  for (const k of Object.keys(store.data) as (keyof Store["data"])[]) {
    store.data[k].length = 0;
  }
  vi.clearAllMocks();

  mockGetAuthContext.mockResolvedValue(agentAuth);
  // An idea uuid resolves to ITSELF (identity) so the chokepoint's derived
  // sessionId == directIdeaUuid == the existing session's sessionId. A task resolves to
  // its direct idea. Anything else → null (ad-hoc).
  mockResolveRootIdea.mockImplementation(async (_company: string, type: string, uuid: string) => {
    if (type === "idea") return { rootIdeaUuid: uuid, directIdeaUuid: uuid };
    if (type === "task" && uuid === TASK) return { rootIdeaUuid: IDEA, directIdeaUuid: IDEA };
    return { rootIdeaUuid: null, directIdeaUuid: null };
  });
  // Both connections online by default (origin-first).
  mockListConnectionsForAgent.mockResolvedValue([
    { uuid: ORIGIN_CONN, agentUuid: AGENT, effectiveStatus: "online" },
    { uuid: OTHER_CONN, agentUuid: AGENT, effectiveStatus: "online" },
  ]);
  seedConnections();
});

// ===== AC1: send to an EXISTING idea-anchored session — session-key alignment =====

describe("AC1 — instruction lands on the SAME idea-anchored DaemonSession (session-key alignment)", () => {
  it("appends a human_instruction turn to the existing session row: no duplicate (agentUuid,sessionId), seq increments, promptText == submitted text", async () => {
    const { uuid: sessionUuid } = seedIdeaAnchoredSession();
    // Pre-existing turn so we PROVE seq increments off the existing row (not seq=1 on a
    // fresh second session — that would be the session-key drift this AC guards against).
    store.data.daemonSessionTurn.push({
      id: store.nextId(),
      uuid: store.nextUuid("turn"),
      sessionUuid,
      seq: 1,
      trigger: "task_assigned",
      promptText: null,
      status: "ended",
      executionUuid: null,
      startedAt: null,
      endedAt: new Date(),
      createdAt: new Date(),
    });

    const INSTRUCTION = "Please also update the changelog.";

    // REAL send: validate → findVisibleSession → assertContinuable (origin online) →
    // notification chokepoint → maybeCreateTurnForWakeNotification → createPendingTurn.
    const { turn } = await instructionService.sendInstruction(agentAuth, {
      sessionUuid,
      instructionText: INSTRUCTION,
    });

    // STILL exactly ONE DaemonSession row for (AGENT, IDEA) — the turn reused it.
    expect(store.data.daemonSession).toHaveLength(1);
    expect(store.data.daemonSession[0].uuid).toBe(sessionUuid);
    expect(store.data.daemonSession[0].sessionId).toBe(IDEA);
    expect(store.data.daemonSession[0].directIdeaUuid).toBe(IDEA);

    // No second (agentUuid, sessionId) row was created.
    const keys = store.data.daemonSession.map((s) => `${s.agentUuid}:${s.sessionId}`);
    expect(keys).toEqual([`${AGENT}:${IDEA}`]);

    // The new turn is on the SAME session, seq=2 (incremented off the seeded turn),
    // trigger human_instruction, promptText == the submitted text (canonical).
    expect(store.data.daemonSessionTurn).toHaveLength(2);
    const newTurn = store.data.daemonSessionTurn[1];
    expect(newTurn.sessionUuid).toBe(sessionUuid);
    expect(newTurn.trigger).toBe("human_instruction");
    expect(newTurn.seq).toBe(2);
    expect(newTurn.status).toBe("pending");
    expect(newTurn.promptText).toBe(INSTRUCTION);

    // The returned view matches the persisted turn (read back from the canonical table).
    expect(turn.sessionUuid).toBe(sessionUuid);
    expect(turn.seq).toBe(2);
    expect(turn.trigger).toBe("human_instruction");
    expect(turn.promptText).toBe(INSTRUCTION);
    expect(turn.status).toBe("pending");

    // The denormalized copy rode the SAME notification the chokepoint created.
    expect(store.data.notification).toHaveLength(1);
    expect(store.data.notification[0].action).toBe("human_instruction");
    expect(store.data.notification[0].instructionText).toBe(INSTRUCTION);
    // Session-key alignment: the notification keyed the idea (identity lineage), NOT a
    // fresh ad-hoc key — entityType "idea", entityUuid the session's directIdeaUuid.
    expect(store.data.notification[0].entityType).toBe("idea");
    expect(store.data.notification[0].entityUuid).toBe(IDEA);
  });
});

// ===== AC2: origin-only delivery — live control event targets ONLY the origin =====

describe("AC2 — origin-only live delivery: the deliver_turn control event targets ONLY originConnectionUuid; the daemon control-handler ignores a Check-1 mismatch and on a match runs ONLY the announced turn", () => {
  it("emits one deliver_turn carrying the PRECISE turnUuid on control:{ORIGIN_CONN} (never on control:{OTHER_CONN}); the REAL control-handler dispatches ONLY that turn — never a stale pending turn on the same connection (multi-wake regression)", async () => {
    const { uuid: sessionUuid } = seedIdeaAnchoredSession();

    // Multi-wake regression guard: a STALE, never-consumed human_instruction turn already
    // sits pending on this same connection's session. The OLD connection-wide sweep would
    // have woken it too on any fresh send; precise delivery must leave it untouched.
    store.data.daemonSessionTurn.push({
      id: store.nextId(),
      uuid: "stale-pending-turn",
      sessionUuid,
      seq: 1,
      trigger: "human_instruction",
      promptText: "an older instruction that was never run",
      status: "pending",
      executionUuid: null,
      startedAt: null,
      endedAt: null,
      createdAt: new Date(),
    });

    // Capture every control event on BOTH connections' channels off the REAL event bus.
    const originEvents: ControlEvent[] = [];
    const otherEvents: ControlEvent[] = [];
    eventBus.on(controlEventName(ORIGIN_CONN), (e: ControlEvent) => originEvents.push(e));
    eventBus.on(controlEventName(OTHER_CONN), (e: ControlEvent) => otherEvents.push(e));

    const INSTRUCTION = "Run the deploy.";

    // --- The daemon-side composition (driven REAL, only the wake boundary stubbed) ---
    // A shared seen set across router + backfill (the real idempotency contract).
    const seen = new Set<string>();
    const enqueued: { key: string; n: Row }[] = [];
    // The WakeQueue is the injected boundary: enqueue(key, task) records the wake instead
    // of spawning a real `claude` (a true headless e2e is not runnable here — see file
    // header / AC5 note). We also RUN the task so the wake's body is exercised.
    const queue = {
      enqueue: (key: string, task: () => Promise<void>) => {
        enqueued.push({ key, n: {} });
        // Fire-and-forget the wake body (no real subprocess; the waker.wake stub just
        // records its args). Errors are swallowed like the real queue would log them.
        void task();
      },
    };
    const wokeWith: Row[] = [];
    const waker = {
      // dispatchPendingTurn reconstructs the wake's session anchor directly from the
      // turn — record what it would wake with.
      keyFor: vi.fn(),
      markQueued: vi.fn(),
      wake: vi.fn(async (n: Row) => {
        wokeWith.push(n);
      }),
    };
    const router = new EventRouter({
      mcpClient: { callTool: vi.fn(async () => ({ notifications: [] })) },
      waker,
      queue,
      wakeActions: new Set(["human_instruction"]),
      seen,
      logger: { info() {}, warn() {}, error() {} },
    });

    // The pending-turns sweep is the REAL backfill.pendingTurnsOnly, fetching through the
    // REAL pending-turns route handler (origin-pinned, connection-scoped). fetchImpl maps
    // the daemon's HTTP read onto the in-process route.
    const fetchImpl = async (endpoint: string) => {
      const url = new URL(endpoint);
      const res = await pendingTurnsGET(getReq(`${url.pathname}${url.search}`));
      return {
        ok: res.status >= 200 && res.status < 300,
        status: res.status,
        json: () => res.json(),
      };
    };
    const backfill = createBackfill({
      mcpClient: { callTool: vi.fn(async () => ({ notifications: [] })) },
      dispatch: (e: { type: string; notificationUuid: string }) => router.dispatch(e),
      seen,
      logger: { info() {}, warn() {}, error() {} },
      url: "http://localhost",
      apiKey: "cho_test",
      getConnectionUuid: () => ORIGIN_CONN,
      dispatchPendingTurn: (t: Row) => router.dispatchPendingTurn(t),
      fetchImpl,
    });

    // The REAL control-handler wired to the REAL sweep, forwarding the precise turnUuid
    // exactly as the daemon does (deliverTurn(turnUuid) → backfill.pendingTurnsOnly(turnUuid)).
    const onControlOrigin = createControlHandler({
      waker: { executions: new Map() },
      getConnectionUuid: () => ORIGIN_CONN,
      deliverTurn: (turnUuid?: string) => backfill.pendingTurnsOnly(turnUuid),
      logger: { info() {}, warn() {}, error() {} },
    });
    // A SECOND daemon (the OTHER connection) with its OWN control-handler + sweep. If the
    // server fanned the wake agent-wide, this daemon would also sweep — proving the
    // origin-only property requires it to NOT be driven.
    const otherSwept = vi.fn();
    const onControlOther = createControlHandler({
      waker: { executions: new Map() },
      getConnectionUuid: () => OTHER_CONN,
      deliverTurn: otherSwept,
      logger: { info() {}, warn() {}, error() {} },
    });

    // --- Server: REAL send → emits the origin-only deliver_turn control event ---
    const { turn } = await instructionService.sendInstruction(agentAuth, {
      sessionUuid,
      instructionText: INSTRUCTION,
    });

    // The live delivery targeted ONLY the origin connection's channel, carrying the PRECISE
    // turnUuid just created (so the daemon runs ONLY this turn, not a connection-wide sweep).
    expect(originEvents).toHaveLength(1);
    expect(originEvents[0]).toEqual({
      type: "control",
      command: "deliver_turn",
      targetConnectionUuid: ORIGIN_CONN,
      turnUuid: turn.uuid,
    });
    // No instruction text / no entity on the wire (the daemon reads the turn by uuid).
    expect(originEvents[0]).not.toHaveProperty("entityType");
    expect(originEvents[0]).not.toHaveProperty("instructionText");
    // The OTHER connection of the SAME agent was NEVER pinged.
    expect(otherEvents).toHaveLength(0);

    // --- Daemon: feed the live ControlEvent to BOTH handlers ---
    // The OTHER daemon would only receive its own channel's events (which is empty), but
    // also verify Check-1: even if the origin's event reached the wrong handler, the
    // connection mismatch makes it a no-op.
    onControlOther(originEvents[0]); // Check-1 MISMATCH on the OTHER daemon → no-op
    expect(otherSwept).not.toHaveBeenCalled();

    onControlOrigin(originEvents[0]); // Check-1 MATCH on the origin daemon → sweep

    // The sweep is async (fetch → route → dispatchPendingTurn → enqueue → wake). Settle.
    await new Promise((r) => setTimeout(r, 0));
    await new Promise((r) => setTimeout(r, 0));

    // The origin daemon dispatched EXACTLY ONE turn — the freshly-created one — through the
    // WakeQueue → wake, anchored on the idea session. The stale pending turn on the SAME
    // connection was NOT woken (the multi-wake bug would have produced two wakes here).
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].key).toBe(`idea:${IDEA}`);
    expect(wokeWith).toHaveLength(1);
    expect(wokeWith[0].action).toBe("human_instruction");
    expect(wokeWith[0].entityType).toBe("idea");
    expect(wokeWith[0].entityUuid).toBe(IDEA);
    expect(wokeWith[0].instructionText).toBe(INSTRUCTION);
    // And the woken turn is the NEW one, not the stale leftover.
    expect(wokeWith[0].instructionText).not.toBe("an older instruction that was never run");
  });
});

// ===== AC3: durability — lost live ping recovered by reconnect backfill, run once =====

describe("AC3 — durability: a lost live ping is recovered by the reconnect pending-turns backfill and the turn runs exactly once (shared seen-set dedup)", () => {
  it("the turn was persisted before the (dropped) ping; reconnect backfill re-derives it and dispatchPendingTurn runs it once; a second backfill is a no-op", async () => {
    const { uuid: sessionUuid } = seedIdeaAnchoredSession();
    const INSTRUCTION = "Re-run after the dropped ping.";

    // --- Server: REAL send creates the pending turn. We SIMULATE the live ping being lost
    //     by simply not driving the control-handler with the emitted event. ---
    await instructionService.sendInstruction(agentAuth, {
      sessionUuid,
      instructionText: INSTRUCTION,
    });
    // The pending human_instruction turn IS persisted (the durable record).
    expect(store.data.daemonSessionTurn).toHaveLength(1);
    expect(store.data.daemonSessionTurn[0].status).toBe("pending");
    expect(store.data.daemonSessionTurn[0].trigger).toBe("human_instruction");
    expect(store.data.daemonSessionTurn[0].promptText).toBe(INSTRUCTION);

    // --- Daemon: the REAL reconnect backfill re-derives the turn from the turn table via
    //     the REAL pending-turns route → REAL dispatchPendingTurn. Shared seen set. ---
    const seen = new Set<string>();
    const enqueued: string[] = [];
    const queue = {
      enqueue: (key: string, task: () => Promise<void>) => {
        enqueued.push(key);
        void task();
      },
    };
    const wokeWith: Row[] = [];
    const waker = {
      keyFor: vi.fn(),
      markQueued: vi.fn(),
      wake: vi.fn(async (n: Row) => {
        wokeWith.push(n);
      }),
    };
    const router = new EventRouter({
      mcpClient: { callTool: vi.fn(async () => ({ notifications: [] })) },
      waker,
      queue,
      wakeActions: new Set(["human_instruction"]),
      seen,
      logger: { info() {}, warn() {}, error() {} },
    });
    const fetchImpl = async (endpoint: string) => {
      const url = new URL(endpoint);
      const res = await pendingTurnsGET(getReq(`${url.pathname}${url.search}`));
      return {
        ok: res.status >= 200 && res.status < 300,
        status: res.status,
        json: () => res.json(),
      };
    };
    // The full reconnect backfill (notifications + pending turns), sharing the seen set.
    const backfill = createBackfill({
      mcpClient: { callTool: vi.fn(async () => ({ notifications: [] })) },
      dispatch: (e: { type: string; notificationUuid: string }) => router.dispatch(e),
      seen,
      logger: { info() {}, warn() {}, error() {} },
      url: "http://localhost",
      apiKey: "cho_test",
      getConnectionUuid: () => ORIGIN_CONN,
      dispatchPendingTurn: (t: Row) => router.dispatchPendingTurn(t),
      fetchImpl,
    });

    // Reconnect #1: re-derives + runs the missed instruction exactly once.
    await backfill();
    await new Promise((r) => setTimeout(r, 0));
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0]).toBe(`idea:${IDEA}`);
    expect(wokeWith).toHaveLength(1);
    expect(wokeWith[0].instructionText).toBe(INSTRUCTION);

    // Reconnect #2 (a storm): the SAME turn is observed again but the shared seen set
    // (keyed turn:{uuid}) makes the second observation a no-op — run AT MOST once.
    await backfill();
    await new Promise((r) => setTimeout(r, 0));
    expect(enqueued).toHaveLength(1); // still exactly one
    expect(wokeWith).toHaveLength(1);

    // And had the live ping NOT been lost — a deliver_turn sweep observing the same turn
    // after the backfill already ran it is ALSO a no-op (same seen set).
    const onControl = createControlHandler({
      waker: { executions: new Map() },
      getConnectionUuid: () => ORIGIN_CONN,
      deliverTurn: () => backfill.pendingTurnsOnly(),
      logger: { info() {}, warn() {}, error() {} },
    });
    onControl({ type: "control", command: "deliver_turn", targetConnectionUuid: ORIGIN_CONN });
    await new Promise((r) => setTimeout(r, 0));
    expect(enqueued).toHaveLength(1);
    expect(wokeWith).toHaveLength(1);
  });
});

// ===== AC4: offline origin — send is read-only (409), no turn, no re-route =====

describe("AC4 — offline origin: send returns read-only (route → 409), creates no turn, and is never re-routed to the agent's other online connection", () => {
  it("throws SessionReadOnlyError (origin-pinned), creates NO turn/notification, emits NO control event on the other connection", async () => {
    const { uuid: sessionUuid } = seedIdeaAnchoredSession();

    // Take the ORIGIN connection offline (stale lastSeenAt past STALE_THRESHOLD_MS); the
    // OTHER connection of the same agent stays online.
    const origin = store.data.daemonConnection.find((c) => c.uuid === ORIGIN_CONN)!;
    origin.lastSeenAt = new Date(Date.now() - 10 * 60_000);

    // Capture control events on BOTH channels to prove NO re-route ping is emitted.
    const originEvents: ControlEvent[] = [];
    const otherEvents: ControlEvent[] = [];
    eventBus.on(controlEventName(ORIGIN_CONN), (e: ControlEvent) => originEvents.push(e));
    eventBus.on(controlEventName(OTHER_CONN), (e: ControlEvent) => otherEvents.push(e));

    // The send refuses with a read-only verdict pinned to the (offline) origin.
    await expect(
      instructionService.sendInstruction(agentAuth, {
        sessionUuid,
        instructionText: "should be blocked",
      }),
    ).rejects.toMatchObject({
      code: "session_read_only",
      originConnectionUuid: ORIGIN_CONN,
    });
    // The thrown error is the typed 子1 SessionReadOnlyError the route maps to 409.
    await instructionService
      .sendInstruction(agentAuth, { sessionUuid, instructionText: "again" })
      .catch((err) => {
        expect(err).toBeInstanceOf(SessionReadOnlyError);
      });

    // NO turn and NO notification were created (the gate is before any mutation).
    expect(store.data.daemonSessionTurn).toHaveLength(0);
    expect(store.data.notification).toHaveLength(0);
    // History (the session row) survives — read-only, not deleted.
    expect(store.data.daemonSession).toHaveLength(1);

    // And the instruction was NEVER routed to ANY connection (no live ping at all).
    expect(originEvents).toHaveLength(0);
    expect(otherEvents).toHaveLength(0);
  });
});

// ===== AC5: ad-hoc create-and-send — server sessionId, pinned origin, first turn =====

describe("AC5 — ad-hoc create-and-send: server-generated sessionId, session pinned to the chosen connection, first human_instruction turn created and resumable on that connection", () => {
  it("creates a NEW ad-hoc DaemonSession (directIdeaUuid null) pinned to the chosen online connection with a server sessionId, the first turn, an origin-only deliver_turn, and the turn is resumable via the connection-scoped pending-turns read", async () => {
    // No pre-existing session — this is the from-scratch path.
    expect(store.data.daemonSession).toHaveLength(0);

    const originEvents: ControlEvent[] = [];
    const otherEvents: ControlEvent[] = [];
    eventBus.on(controlEventName(ORIGIN_CONN), (e: ControlEvent) => originEvents.push(e));
    eventBus.on(controlEventName(OTHER_CONN), (e: ControlEvent) => otherEvents.push(e));

    const INSTRUCTION = "Bootstrap a fresh session and do X.";

    // REAL ad-hoc: validate → callerOwnsAgent (agent-key self) → connectionBelongsToAgent →
    // isConnectionLive → server generates sessionId → resolveOrCreateSession (pinned) →
    // chokepoint (ad-hoc-keyed) → first turn → origin-only deliver_turn ping.
    const { session, turn } = await instructionService.createAdHocSessionWithInstruction(
      agentAuth,
      { agentUuid: AGENT, connectionUuid: ORIGIN_CONN, instructionText: INSTRUCTION },
    );

    // Exactly one NEW session, ad-hoc (directIdeaUuid null), pinned to the chosen origin,
    // with a SERVER-generated sessionId (a uuid, NOT an idea/task id we supplied).
    expect(store.data.daemonSession).toHaveLength(1);
    const row = store.data.daemonSession[0];
    expect(row.directIdeaUuid).toBeNull();
    expect(row.originConnectionUuid).toBe(ORIGIN_CONN);
    expect(typeof row.sessionId).toBe("string");
    expect(row.sessionId).not.toBe(IDEA);
    expect(row.sessionId).not.toBe(TASK);
    expect(row.sessionId).not.toBe(""); // server is the sole generator
    expect(session.uuid).toBe(row.uuid);
    expect(session.directIdeaUuid).toBeNull();
    expect(session.originConnectionUuid).toBe(ORIGIN_CONN);
    const generatedSessionId = row.sessionId as string;

    // The first turn: human_instruction, seq=1, pending, promptText == the text.
    expect(store.data.daemonSessionTurn).toHaveLength(1);
    expect(turn.trigger).toBe("human_instruction");
    expect(turn.seq).toBe(1);
    expect(turn.status).toBe("pending");
    expect(turn.promptText).toBe(INSTRUCTION);

    // The chokepoint keyed the ad-hoc session OUTSIDE the lineage set (no idea walk):
    // entityType = AD_HOC_ENTITY_TYPE, entityUuid = the server-generated sessionId.
    expect(store.data.notification).toHaveLength(1);
    expect(store.data.notification[0].entityType).toBe(instructionService.AD_HOC_ENTITY_TYPE);
    expect(store.data.notification[0].entityUuid).toBe(generatedSessionId);
    expect(store.data.notification[0].instructionText).toBe(INSTRUCTION);

    // Origin-only live delivery: ping ONLY the chosen connection, never the other.
    expect(originEvents).toHaveLength(1);
    expect(originEvents[0].command).toBe("deliver_turn");
    expect(originEvents[0].targetConnectionUuid).toBe(ORIGIN_CONN);
    expect(otherEvents).toHaveLength(0);

    // RESUMABLE on that connection: the daemon's connection-scoped pending-turns read
    // (REAL route handler) surfaces the new turn with its anchor + free-text body, so the
    // origin daemon can `claude --resume <sessionId>` it.
    const res = await pendingTurnsGET(
      getReq(`/api/daemon/pending-turns?connectionUuid=${ORIGIN_CONN}`),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.turns).toHaveLength(1);
    const pending = body.data.turns[0];
    expect(pending.trigger).toBe("human_instruction");
    expect(pending.promptText).toBe(INSTRUCTION);
    expect(pending.sessionId).toBe(generatedSessionId); // the --resume anchor
    expect(pending.directIdeaUuid).toBeNull();

    // It is pinned to ORIGIN_CONN: the OTHER connection's pending-turns read sees nothing.
    const resOther = await pendingTurnsGET(
      getReq(`/api/daemon/pending-turns?connectionUuid=${OTHER_CONN}`),
    );
    const bodyOther = await resOther.json();
    expect(bodyOther.data.turns).toHaveLength(0);

    // Driving the daemon advance for the ad-hoc session (by its business key = sessionId)
    // moves the turn off pending — proving the ad-hoc anchor the daemon would use resolves.
    await turnAdvancePOST(
      postReq("/api/daemon/turn-advance", {
        connectionUuid: ORIGIN_CONN,
        sessionId: generatedSessionId,
        status: "running",
      }),
    );
    expect(store.data.daemonSessionTurn[0].status).toBe("running");
    const resAfter = await pendingTurnsGET(
      getReq(`/api/daemon/pending-turns?connectionUuid=${ORIGIN_CONN}`),
    );
    const bodyAfter = await resAfter.json();
    expect(bodyAfter.data.turns).toHaveLength(0); // no longer pending
  });

  it("refuses an OFFLINE chosen connection (read-only/409) — no session, no turn, no ping", async () => {
    // Take the chosen connection offline.
    const origin = store.data.daemonConnection.find((c) => c.uuid === ORIGIN_CONN)!;
    origin.lastSeenAt = new Date(Date.now() - 10 * 60_000);

    const originEvents: ControlEvent[] = [];
    eventBus.on(controlEventName(ORIGIN_CONN), (e: ControlEvent) => originEvents.push(e));

    await expect(
      instructionService.createAdHocSessionWithInstruction(agentAuth, {
        agentUuid: AGENT,
        connectionUuid: ORIGIN_CONN,
        instructionText: "blocked — offline connection",
      }),
    ).rejects.toBeInstanceOf(instructionService.ConnectionOfflineError);

    expect(store.data.daemonSession).toHaveLength(0);
    expect(store.data.daemonSessionTurn).toHaveLength(0);
    expect(store.data.notification).toHaveLength(0);
    expect(originEvents).toHaveLength(0);
  });
});
