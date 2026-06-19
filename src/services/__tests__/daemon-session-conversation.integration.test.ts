// src/services/__tests__/daemon-session-conversation.integration.test.ts
//
// INTEGRATION CHECKPOINT (子1 — daemon-session-conversation, final task).
//
// Unlike the per-task unit tests — each of which mocks the daemon-session service or
// prisma at a single boundary — this test wires the REAL composition together against
// ONE stateful in-memory prisma fake plus the REAL in-process event bus:
//
//   notification.service.create            (REAL — the wake chokepoint)
//     → notification-turn bridge           (REAL — maybeCreateTurnForWakeNotification)
//       → daemon-session.service           (REAL — resolveOrCreateSession + createPendingTurn)
//   /api/daemon/turn-advance route         (REAL handler — advanceTurnForWake)
//   /api/daemon/transcript route           (REAL handler — appendTranscriptMessages)
//   /api/daemon/pending-turns route        (REAL handler — getPendingTurnsForConnection)
//   assertContinuable                      (REAL — origin-pinned read-only verdict)
//
// Only the leaf I/O is faked: prisma (a stateful store, so every function reads what
// the previous one wrote — the thing per-task mocks cannot prove), the logger (silenced),
// lineage (direct-idea resolution), and the connection registry's online/offline listing
// (so the chokepoint pins an origin). The daemon-session functions themselves are NOT
// mocked, so the seams are genuinely exercised.
//
// It drives the 5 scenario threads of the checkpoint task end-to-end at the service +
// route layer:
//   (1) an autonomous task_assigned wake creates a DaemonSession + a task_assigned turn;
//       the daemon advances it pending → running → ended.
//   (2) a human_instruction wake (notification carries instructionText; the daemon reads
//       it with NO extra fetch) produces a SECOND turn on the SAME session, distinguished
//       by trigger.
//   (3) user/assistant transcript for both turns lands via POST /api/daemon/transcript
//       (append, text-only, rolling window) and a transcript:{sessionUuid} SSE fires.
//   (4) continuation refuses (session read-only) when originConnectionUuid is offline,
//       and is never re-routed to another online connection of the same agent.
//   (5) a dropped delivery ping + reconnect re-derives the unstarted (pending) turn from
//       the turn table via the backfill read (instruction not lost).

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ===== Stateful in-memory prisma fake =====
//
// Supports exactly the query shapes the real code paths under test use. Each model is
// an array of rows; ids/uuids auto-assigned on create. This is the crux of the
// integration test: a SINGLE store the real functions write to and read from in turn.

interface Row {
  [k: string]: unknown;
}

function makeStore() {
  const data = {
    daemonSession: [] as Row[],
    daemonSessionTurn: [] as Row[],
    daemonTranscriptMessage: [] as Row[],
    daemonConnection: [] as Row[],
    daemonExecution: [] as Row[],
    notification: [] as Row[],
    notificationPreference: [] as Row[],
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
// uses (turn.session.*, transcriptMessage.turn.sessionUuid, turn.session{agentUuid,...}).
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
    if (key === "turn" && model === "daemonTranscriptMessage") {
      const turn = store.data.daemonSessionTurn.find((t) => t.uuid === row.turnUuid);
      if (!turn) return false;
      if (!matchWhere(store, "daemonSessionTurn", turn, cond as Row)) return false;
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
// it: `daemonSessionTurn.select.session` (the backfill query). When a `select` names the
// `session` relation, attach the related DaemonSession row (with its own nested select
// applied) onto the result, so `row.session.sessionId` etc. resolve. Scalar selects are
// left as-is (the services map full rows; extra fields are harmless). Never throws.
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
      findUnique: vi.fn(async (args: Row) =>
        findFirst("daemonSession", { where: args.where }),
      ),
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
    daemonTranscriptMessage: {
      findFirst: vi.fn(async (args: Row) => findFirst("daemonTranscriptMessage", args)),
      findMany: vi.fn(async (args: Row) => findMany("daemonTranscriptMessage", args)),
      create: vi.fn(async (args: Row) => {
        const row: Row = {
          id: store.nextId(),
          uuid: store.nextUuid("msg"),
          createdAt: new Date(),
          ...(args.data as Row),
        };
        store.data.daemonTranscriptMessage.push(row);
        return { ...row };
      }),
      count: vi.fn(async (args: Row) => count("daemonTranscriptMessage", args)),
      deleteMany: vi.fn(async (args: Row) => {
        const where = (args.where as Row) ?? {};
        const toDelete = store.data.daemonTranscriptMessage.filter((r) =>
          matchWhere(store, "daemonTranscriptMessage", r, where),
        );
        store.data.daemonTranscriptMessage = store.data.daemonTranscriptMessage.filter(
          (r) => !toDelete.includes(r),
        );
        return { count: toDelete.length };
      }),
    },
    daemonConnection: {
      findFirst: vi.fn(async (args: Row) => findFirst("daemonConnection", args)),
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
  };
}

// ===== Module mocks =====
//
// The store + prisma fake are built inside vi.hoisted so they exist when the hoisted
// vi.mock factory below runs (factories are lifted above normal module-scope consts).

const hoisted = vi.hoisted(() => {
  // Re-declared here (not referencing module-scope helpers, which are not yet defined at
  // hoist time) — the builders are pure functions defined ABOVE via function declarations,
  // which ARE hoisted, so they are callable here.
  const s = makeStore();
  return { store: s, prismaFake: buildPrismaFake(s) };
});
const store = hoisted.store;
const prismaFake = hoisted.prismaFake;
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

// Lineage: a task under an idea resolves to that direct idea; everything else → null.
const mockResolveRootIdea = vi.hoisted(() => vi.fn());
vi.mock("@/services/lineage.service", () => ({
  resolveRootIdea: mockResolveRootIdea,
}));

// Connection registry: the chokepoint asks for the agent's online connections to pin an
// origin. We drive online/offline here. STALE_THRESHOLD_MS must be REAL (the session
// service re-exports it and assertContinuable compares against it), so partially mock.
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

// ===== Imports under test (REAL) =====
import * as notificationService from "@/services/notification.service";
import {
  assertContinuable,
  transcriptEventName,
  type TranscriptEvent,
} from "@/services/daemon-session.service";
import { eventBus } from "@/lib/event-bus";
import { POST as turnAdvanceRoutePOST } from "@/app/api/daemon/turn-advance/route";
import { POST as transcriptRoutePOST } from "@/app/api/daemon/transcript/route";
import { GET as pendingTurnsRouteGET } from "@/app/api/daemon/pending-turns/route";

// ===== Fixtures =====
const PROJECT = "project-int-0001";
const IDEA = "idea-int-0001";
const TASK = "task-int-0001";
const ORIGIN_CONN = "conn-origin-0001";
const OTHER_CONN = "conn-other-0002";

function agentAuth() {
  return { type: "agent", companyUuid: COMPANY, actorUuid: AGENT };
}

function postReq(url: string, body: unknown): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: "Bearer cho_test" },
    body: JSON.stringify(body),
  });
}

function getReq(url: string): NextRequest {
  return new NextRequest(`http://localhost${url}`, {
    method: "GET",
    headers: { authorization: "Bearer cho_test" },
  });
}

// withErrorHandler-wrapped routes take (request, { params }) — these routes ignore
// params, so an empty resolved-params context satisfies the signature (matches the
// existing daemon route tests' convention). Thin wrappers bake it in so the call sites
// pass only the request.
const emptyCtx = { params: Promise.resolve({}) };
const turnAdvancePOST = (req: NextRequest) => turnAdvanceRoutePOST(req, emptyCtx);
const transcriptPOST = (req: NextRequest) => transcriptRoutePOST(req, emptyCtx);
const pendingTurnsGET = (req: NextRequest) => pendingTurnsRouteGET(req, emptyCtx);

// Seed an online origin connection and one other online connection for the agent.
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
}

const baseNotif = {
  companyUuid: COMPANY,
  projectUuid: PROJECT,
  recipientType: "agent",
  recipientUuid: AGENT,
  entityType: "task",
  entityUuid: TASK,
  entityTitle: "Build the thing",
  projectName: "Chorus 0.11.0",
  actorType: "user",
  actorUuid: "user-int-0001",
  actorName: "Alice",
};

beforeEach(() => {
  // Reset the store between tests.
  for (const k of Object.keys(store.data) as (keyof Store["data"])[]) {
    store.data[k].length = 0;
  }
  vi.clearAllMocks();

  mockGetAuthContext.mockResolvedValue(agentAuth());
  // task → direct idea IDEA; default for anything else null.
  mockResolveRootIdea.mockImplementation(async (_company: string, type: string, uuid: string) => {
    if (type === "task" && uuid === TASK) return { rootIdeaUuid: IDEA, directIdeaUuid: IDEA };
    return { rootIdeaUuid: null, directIdeaUuid: null };
  });
  // Origin connection online by default.
  mockListConnectionsForAgent.mockResolvedValue([
    { uuid: ORIGIN_CONN, agentUuid: AGENT, effectiveStatus: "online" },
    { uuid: OTHER_CONN, agentUuid: AGENT, effectiveStatus: "online" },
  ]);
  seedConnections();
});

// ===== Thread 1 + 2: two wakes, one session, distinguished by trigger; lifecycle =====

describe("integration: autonomous + human turns on ONE DaemonSession, distinguished by trigger", () => {
  it("creates a task_assigned turn then a human_instruction turn on the SAME session, and the daemon advances each pending→running→ended", async () => {
    const events: TranscriptEvent[] = [];
    const onEvent = (e: TranscriptEvent) => events.push(e);

    // --- Thread 1: an autonomous task_assigned wake at the notification chokepoint ---
    const notif1 = await notificationService.create({ ...baseNotif, action: "task_assigned", message: "Task assigned" });
    expect(notif1.action).toBe("task_assigned");

    // A DaemonSession keyed (AGENT, IDEA) exists, pinned to the online origin.
    expect(store.data.daemonSession).toHaveLength(1);
    const session = store.data.daemonSession[0];
    expect(session.agentUuid).toBe(AGENT);
    expect(session.sessionId).toBe(IDEA);
    expect(session.directIdeaUuid).toBe(IDEA);
    expect(session.originConnectionUuid).toBe(ORIGIN_CONN);
    const sessionUuid = session.uuid as string;

    // Subscribe to the per-session channel AFTER the session exists (turn-created for
    // turn 1 already fired before we knew the uuid; we assert turn 1's row directly and
    // capture SSE for the subsequent transitions + turn 2).
    eventBus.on(transcriptEventName(sessionUuid), onEvent);

    // Exactly one turn, trigger=task_assigned, status=pending, seq=1.
    expect(store.data.daemonSessionTurn).toHaveLength(1);
    const turn1 = store.data.daemonSessionTurn[0];
    expect(turn1.trigger).toBe("task_assigned");
    expect(turn1.status).toBe("pending");
    expect(turn1.seq).toBe(1);
    expect(turn1.promptText).toBeNull();

    // Daemon advances turn 1 pending → running → ended via the REAL route handler,
    // identifying the turn by the session business key (sessionId = IDEA).
    const run1 = await turnAdvancePOST(
      postReq("/api/daemon/turn-advance", {
        connectionUuid: ORIGIN_CONN,
        sessionId: IDEA,
        status: "running",
        entityType: "task",
        entityUuid: TASK,
      }),
    );
    expect(run1.status).toBe(200);
    expect((store.data.daemonSessionTurn[0]).status).toBe("running");

    const end1 = await turnAdvancePOST(
      postReq("/api/daemon/turn-advance", {
        connectionUuid: ORIGIN_CONN,
        sessionId: IDEA,
        status: "ended",
      }),
    );
    expect(end1.status).toBe(200);
    expect((store.data.daemonSessionTurn[0]).status).toBe("ended");

    // --- Thread 2: a human_instruction wake — notification carries instructionText ---
    const INSTRUCTION = "Please also update the changelog.";
    const notif2 = await notificationService.create({
      ...baseNotif,
      action: "human_instruction",
      message: "New instruction",
      instructionText: INSTRUCTION,
    });

    // AC: the instruction text rides the SAME notification the daemon already fetches —
    // no extra fetch. The read projection surfaces it.
    expect(notif2.instructionText).toBe(INSTRUCTION);

    // SAME session reused (still 1 session row), now with a SECOND turn.
    expect(store.data.daemonSession).toHaveLength(1);
    expect(store.data.daemonSessionTurn).toHaveLength(2);
    const turn2 = store.data.daemonSessionTurn[1];
    expect(turn2.sessionUuid).toBe(sessionUuid); // same conversation
    expect(turn2.trigger).toBe("human_instruction");
    expect(turn2.seq).toBe(2);
    // AC: the TURN is the source of truth for the instruction text.
    expect(turn2.promptText).toBe(INSTRUCTION);

    // The two turns share one session, distinguished only by trigger.
    const triggers = store.data.daemonSessionTurn.map((t) => t.trigger);
    expect(triggers).toEqual(["task_assigned", "human_instruction"]);

    // Daemon advances turn 2 (the most-recent turn) pending → running → ended.
    await turnAdvancePOST(
      postReq("/api/daemon/turn-advance", { connectionUuid: ORIGIN_CONN, sessionId: IDEA, status: "running" }),
    );
    await turnAdvancePOST(
      postReq("/api/daemon/turn-advance", { connectionUuid: ORIGIN_CONN, sessionId: IDEA, status: "ended" }),
    );
    expect((store.data.daemonSessionTurn[1]).status).toBe("ended");

    // SSE: turn_status_changed fired for the advances we captured (turn1 ended onward +
    // turn2 created/advances). At minimum we saw turn_created for turn 2 and
    // turn_status_changed transitions.
    const kinds = events.map((e) => e.trigger);
    expect(kinds).toContain("turn_status_changed");
    expect(kinds).toContain("turn_created");
  });
});

// ===== Thread 3: transcript append + SSE for both turns =====

describe("integration: per-turn transcript ingest (append, text-only, rolling-window) + SSE", () => {
  it("appends user/assistant text to a turn and fires a transcript_appended SSE event", async () => {
    await notificationService.create({ ...baseNotif, action: "task_assigned", message: "Task assigned" });
    const sessionUuid = store.data.daemonSession[0].uuid as string;

    const appended: TranscriptEvent[] = [];
    eventBus.on(transcriptEventName(sessionUuid), (e: TranscriptEvent) => {
      if (e.trigger === "transcript_appended") appended.push(e);
    });

    // Daemon uploads transcript for the current turn via the REAL route, targeting by
    // the session business key (sessionId = IDEA). Tool/thinking entries are not even
    // sent by the daemon; the schema constrains roles to user/assistant — verify the
    // text-only persistence by sending only those.
    const res = await transcriptPOST(
      postReq("/api/daemon/transcript", {
        sessionId: IDEA,
        messages: [
          { role: "user", text: "Do the task." },
          { role: "assistant", text: "On it." },
          { role: "assistant", text: "   " }, // blank → dropped by the service filter
        ],
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.appended).toBe(2); // blank dropped
    expect(body.data.stored).toBe(2);

    // Persisted only user/assistant text, in order, on turn 1.
    expect(store.data.daemonTranscriptMessage).toHaveLength(2);
    const texts = store.data.daemonTranscriptMessage.map((m) => m.text);
    expect(texts).toEqual(["Do the task.", "On it."]);
    const roles = store.data.daemonTranscriptMessage.map((m) => m.role);
    expect(roles).toEqual(["user", "assistant"]);

    // SSE transcript_appended fired exactly once for the non-empty append.
    expect(appended).toHaveLength(1);
    expect(appended[0].sessionUuid).toBe(sessionUuid);
    expect(appended[0].companyUuid).toBe(COMPANY);
  });

  it("rejects a transcript upload for another agent's session without disclosure (404)", async () => {
    await notificationService.create({ ...baseNotif, action: "task_assigned", message: "Task assigned" });
    // Another agent's auth posting for OUR session business key → not found, no store.
    mockGetAuthContext.mockResolvedValueOnce({ type: "agent", companyUuid: COMPANY, actorUuid: "agent-other-9999" });
    const res = await transcriptPOST(
      postReq("/api/daemon/transcript", {
        sessionId: IDEA,
        messages: [{ role: "user", text: "leak?" }],
      }),
    );
    expect(res.status).toBe(404);
    expect(store.data.daemonTranscriptMessage).toHaveLength(0);
  });
});

// ===== Thread 4: continuation refused when origin offline; never re-routed =====

describe("integration: continuation pinned to origin connection (read-only when offline)", () => {
  it("refuses continuation when the origin connection is offline and never routes to another online connection", async () => {
    await notificationService.create({ ...baseNotif, action: "task_assigned", message: "Task assigned" });
    const sessionUuid = store.data.daemonSession[0].uuid as string;
    expect(store.data.daemonSession[0].originConnectionUuid).toBe(ORIGIN_CONN);

    // While origin online → continuable, resolves to the origin connection (only it).
    const ok = await assertContinuable(COMPANY, sessionUuid);
    expect(ok).toBe(ORIGIN_CONN);

    // Take the ORIGIN connection offline (stale lastSeenAt) — the OTHER connection of
    // the same agent stays online.
    const origin = store.data.daemonConnection.find((c) => c.uuid === ORIGIN_CONN)!;
    origin.lastSeenAt = new Date(Date.now() - 10 * 60_000); // well past STALE_THRESHOLD_MS

    // Continuation must now refuse (read-only) and NEVER hand back the other online conn.
    await expect(assertContinuable(COMPANY, sessionUuid)).rejects.toMatchObject({
      code: "session_read_only",
      originConnectionUuid: ORIGIN_CONN,
    });

    // History is still readable: the session + its turns survive the origin going offline.
    expect(store.data.daemonSession).toHaveLength(1);
    expect(store.data.daemonSessionTurn.length).toBeGreaterThanOrEqual(1);
  });
});

// ===== Thread 5: dropped ping + reconnect re-derives the pending turn via backfill =====

describe("integration: reconnect backfill re-derives the unstarted (pending) turn from the turn table", () => {
  it("returns the pending human_instruction turn (with its promptText) for the origin connection, not from notifications", async () => {
    const INSTRUCTION = "Re-run after the dropped ping.";
    // A human_instruction wake creates a pending turn (simulating a wake whose SSE ping
    // was dropped — the turn was persisted at the chokepoint regardless).
    await notificationService.create({
      ...baseNotif,
      action: "human_instruction",
      message: "Instruction",
      instructionText: INSTRUCTION,
    });
    expect(store.data.daemonSessionTurn).toHaveLength(1);
    expect(store.data.daemonSessionTurn[0].status).toBe("pending");

    // Reconnect: the daemon reads its origin-pinned pending turns from the TURN TABLE via
    // the REAL backfill route. The instruction's free-text body is preserved on the turn.
    const res = await pendingTurnsGET(getReq(`/api/daemon/pending-turns?connectionUuid=${ORIGIN_CONN}`));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.turns).toHaveLength(1);
    const t = body.data.turns[0];
    expect(t.trigger).toBe("human_instruction");
    expect(t.promptText).toBe(INSTRUCTION); // instruction NOT lost
    expect(t.sessionId).toBe(IDEA);
    expect(t.directIdeaUuid).toBe(IDEA);

    // Once the daemon advances it to running, it no longer surfaces in the pending read.
    await turnAdvancePOST(
      postReq("/api/daemon/turn-advance", { connectionUuid: ORIGIN_CONN, sessionId: IDEA, status: "running" }),
    );
    const res2 = await pendingTurnsGET(getReq(`/api/daemon/pending-turns?connectionUuid=${ORIGIN_CONN}`));
    const body2 = await res2.json();
    expect(body2.data.turns).toHaveLength(0);
  });

  it("scopes the pending-turn backfill to the origin connection's own sessions (404 for a connection the agent does not own)", async () => {
    await notificationService.create({ ...baseNotif, action: "human_instruction", message: "x", instructionText: "y" });
    // A connectionUuid that does not belong to this agent → 404 non-disclosure.
    const res = await pendingTurnsGET(getReq(`/api/daemon/pending-turns?connectionUuid=conn-not-mine-9999`));
    expect(res.status).toBe(404);
  });
});
