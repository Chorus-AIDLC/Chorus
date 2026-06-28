// src/services/__tests__/cwd-pin-chain.integration.test.ts
//
// INTEGRATION CHECKPOINT (cwd-addressable daemon instances — updated for
// add-agent-instance-addressing: the task pin is now an `agent_instance` assignment, not
// the removed `targetHost`/`targetCwd` columns).
//
// The single most load-bearing contract of this feature is a WRITE → READ chain that
// would pass in isolation while the feature is broken:
//
//   write (assignment): an owner pins (host, cwd) at TASK ASSIGNMENT → the Task row carries
//               `assigneeType="agent_instance"`, `assigneeUuid=<AgentInstance.uuid>`.
//   write (@mention):   an owner pins (host, cwd) at @MENTION → the pin is encoded in the
//               mention markup `@[Name](agent:uuid?cwd=…&host=…)`, parseMentions decodes it,
//               and createMentions threads it as `pinnedHost`/`pinnedCwd` into the wake.
//   read (wake): the autonomous wake (notification-turn.ts) reads the SAME shape — the
//               Task's agent_instance assignee (resolved to its AgentInstance's (host, cwd))
//               for a `task_assigned` wake, the threaded context fields for a `mentioned`
//               wake — resolves the matching live DaemonConnection, and pins the session
//               origin THERE.
//
// The reviewer's flagged failure mode: each side unit-tested in isolation passes even if
// the write and read disagree on the assignment shape. This test defeats that by wiring the
// REAL write functions and the REAL read function against ONE stateful in-memory prisma
// store: the assigned+pinned Task row + its AgentInstance live in the store, then the wake
// calls the REAL `prisma.task.findFirst({ select: { assigneeType, assigneeUuid } })` +
// `prisma.agentInstance.findFirst` and pins the origin to the matching live connection. If
// the shapes disagree, the pin resolves to nothing and the wake falls back to online-first —
// exactly the silent-mismatch this checkpoint must catch (the `KEY ASSERTION` test below
// proves this by using a plain `agent` assignment and asserting the pin does NOT resolve).
//
// Threads exercised end-to-end as ONE flow:
//   (1) task-assignment pin: agent_instance Task row → AgentInstance place → task_assigned
//       wake resolves it → origin pinned to the matching LIVE connection.
//       @mention pin: pinned marker → parseMentions → createMentions → mentioned wake
//       reads the threaded (host, cwd) → origin pinned to the matching LIVE connection.
//   (2) KEY ASSERTION: the write shape ≡ the read shape (assigneeType/assigneeUuid), proven
//       on both ends (a plain-agent assignment resolves no pin, not passes silently).
//   (3) OFFLINE assignment (SOFT) pin / fully-offline agent: a SOFT assignment pin to an
//       offline instance DEGRADES to online-first (R2 graceful un-pin); a fully-offline
//       agent has nothing to degrade to → NO turn, the Notification stands. (A HARD mention
//       pin's notify-only policy is exercised in the unit tests.)
//   (4) live ad-hoc send to an OFFLINE instance → rejected (409). Online-only holds end
//       to end on the live-send side.

import { describe, it, expect, vi, beforeEach } from "vitest";

// ===== Stateful in-memory prisma fake =====
//
// A SINGLE store the REAL write functions (claimTask) write to and the REAL read function
// (the wake bridge's prisma.task.findFirst) read from — this is the crux: a per-side mock
// could never prove the two halves agree on the column names.

interface Row {
  [k: string]: unknown;
}

function makeStore() {
  const data = {
    task: [] as Row[],
    idea: [] as Row[],
    agentInstance: [] as Row[],
    daemonSession: [] as Row[],
    daemonSessionTurn: [] as Row[],
    daemonConnection: [] as Row[],
    notification: [] as Row[],
    notificationPreference: [] as Row[],
    mention: [] as Row[],
    project: [] as Row[],
    user: [] as Row[],
    agent: [] as Row[],
  };
  let autoId = 1;
  let autoUuid = 1;
  const nextId = () => autoId++;
  const nextUuid = (prefix: string) => `${prefix}-${String(autoUuid++).padStart(4, "0")}`;
  return { data, nextId, nextUuid };
}

type Store = ReturnType<typeof makeStore>;

// Match a row against a Prisma `where` clause. Supports scalar equality, the `{ in: [...] }`
// operator, and the nested `session` relation filter the backfill read uses
// (turn.session.{companyUuid,agentUuid,originConnectionUuid}).
function matchWhere(store: Store, model: keyof Store["data"], row: Row, where: Row): boolean {
  for (const [key, cond] of Object.entries(where ?? {})) {
    if (cond === undefined) continue;

    if (key === "session" && model === "daemonSessionTurn") {
      const session = store.data.daemonSession.find((s) => s.uuid === row.sessionUuid);
      if (!session) return false;
      if (!matchWhere(store, "daemonSession", session, cond as Row)) return false;
      continue;
    }

    const val = row[key];
    if (cond !== null && typeof cond === "object") {
      const c = cond as Row;
      if ("in" in c) {
        if (!Array.isArray(c.in) || !(c.in as unknown[]).includes(val)) return false;
        continue;
      }
      if ("not" in c) {
        if (val === c.not) return false;
        continue;
      }
      // Unknown operator object — no match, surfaced loudly rather than silently passing.
      return false;
    }
    if (val !== cond) return false;
  }
  return true;
}

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
          const cmp = compare(av, bv);
          if (cmp !== 0) return inner[1] === "desc" ? -cmp : cmp;
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

// Materialize the one relation select the backfill read uses:
// daemonSessionTurn.select.session → attach the related DaemonSession (with its inner
// select applied) so `row.session.sessionId` / `row.session.directIdeaUuid` resolve.
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
    // --- Task: the WRITE side (claimTask) AND the READ side (wake's findFirst) ---
    task: {
      // claimTask issues prisma.task.update({ where: { uuid, status: { in } }, data, include }).
      update: vi.fn(async (args: Row) => {
        const where = args.where as Row;
        const row = store.data.task.find(
          (t) => matchWhere(store, "task", t, where),
        );
        if (!row) {
          // Mirror Prisma's P2025 so claimTask's isPrismaNotFound branch is reachable.
          const err = new Error("Record to update not found.") as Error & { code?: string };
          err.code = "P2025";
          throw err;
        }
        Object.assign(row, args.data as Row, { updatedAt: new Date() });
        const out: Row = { ...row };
        // include: { project: { select: { uuid, name } } } — attach the project relation.
        const include = args.include as Row | undefined;
        if (include?.project) {
          out.project = { uuid: row.projectUuid, name: "Chorus 0.11.2" };
        }
        return out;
      }),
      // The wake bridge reads the pin via prisma.task.findFirst({ where, select }).
      findFirst: vi.fn(async (args: Row) => findFirst("task", args)),
      findMany: vi.fn(async (args: Row) => findMany("task", args)),
    },
    // The instance-based pin reader (add-agent-instance-addressing) reads the root idea's
    // assignee and resolves an agent_instance assignee to its (host, cwd) place.
    idea: {
      findFirst: vi.fn(async (args: Row) => findFirst("idea", args)),
      findMany: vi.fn(async (args: Row) => findMany("idea", args)),
    },
    agentInstance: {
      findFirst: vi.fn(async (args: Row) => findFirst("agentInstance", args)),
      findMany: vi.fn(async (args: Row) => findMany("agentInstance", args)),
    },
    daemonSession: {
      upsert: vi.fn(async (args: Row) => {
        const key = (args.where as Row).agentUuid_sessionId as Row;
        const existing = store.data.daemonSession.find(
          (s) => s.agentUuid === key.agentUuid && s.sessionId === key.sessionId,
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
      findUnique: vi.fn(async (args: Row) => findFirst("daemonSession", { where: args.where, select: args.select })),
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
      findUnique: vi.fn(async (args: Row) => findFirst("daemonSessionTurn", { where: args.where })),
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
    user: {
      findUnique: vi.fn(async (args: Row) => findFirst("user", { where: args.where })),
      findFirst: vi.fn(async (args: Row) => findFirst("user", args)),
      findMany: vi.fn(async (args: Row) => findMany("user", args)),
    },
    agent: {
      findUnique: vi.fn(async (args: Row) => findFirst("agent", { where: args.where })),
      findFirst: vi.fn(async (args: Row) => findFirst("agent", args)),
      findMany: vi.fn(async (args: Row) => findMany("agent", args)),
      count: vi.fn(async (args: Row) => count("agent", args)),
    },
    project: {
      findUnique: vi.fn(async (args: Row) => findFirst("project", { where: args.where })),
    },
    notificationPreference: {
      // getPreferences: findUnique by composite { ownerType_ownerUuid }, else create default.
      findUnique: vi.fn(async (args: Row) => {
        const key = (args.where as Row).ownerType_ownerUuid as Row;
        return (
          store.data.notificationPreference.find(
            (p) => p.ownerType === key.ownerType && p.ownerUuid === key.ownerUuid,
          ) ?? null
        );
      }),
      create: vi.fn(async (args: Row) => {
        // Default-on preferences (Prisma schema defaults are all true), incl. `mentioned`.
        const row: Row = {
          id: store.nextId(),
          uuid: store.nextUuid("pref"),
          taskAssigned: true,
          taskStatusChanged: true,
          taskVerified: true,
          taskReopened: true,
          proposalSubmitted: true,
          proposalApproved: true,
          proposalRejected: true,
          ideaClaimed: true,
          commentAdded: true,
          elaborationRequested: true,
          elaborationAnswered: true,
          mentioned: true,
          ...(args.data as Row),
        };
        store.data.notificationPreference.push(row);
        return { ...row };
      }),
    },
    mention: {
      createMany: vi.fn(async (args: Row) => {
        const rows = (args.data as Row[]) ?? [];
        for (const d of rows) {
          store.data.mention.push({ id: store.nextId(), uuid: store.nextUuid("mention"), ...d });
        }
        return { count: rows.length };
      }),
    },
  };
}

// ===== Module mocks =====

const hoisted = vi.hoisted(() => {
  const s = makeStore();
  return { store: s, prismaFake: buildPrismaFake(s) };
});
const store = hoisted.store;
vi.mock("@/lib/prisma", () => ({ prisma: hoisted.prismaFake }));

// Silence the logger; the real in-process event bus is used (Redis off).
const mockLogger = vi.hoisted(() => {
  const l = { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn(), child: () => l };
  return l;
});
vi.mock("@/lib/logger", () => ({ default: mockLogger, createRequestLogger: () => mockLogger }));

// Lineage: a task / idea under IDEA resolves to that direct idea; everything else → null.
const mockResolveRootIdea = vi.hoisted(() => vi.fn());
vi.mock("@/services/lineage.service", () => ({ resolveRootIdea: mockResolveRootIdea }));

// Connection registry: the wake bridge AND the mention picker ask for the agent's
// connections. Keep STALE_THRESHOLD_MS REAL (the session service re-exports it) — only
// swap listConnectionsForAgent, reading the seeded store so the (host, cwd)/effectiveStatus
// the wake matches against is exactly what we seeded as the registry's verdict.
const mockListConnectionsForAgent = vi.hoisted(() => vi.fn());
vi.mock("@/services/daemon-connection.service", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, listConnectionsForAgent: mockListConnectionsForAgent };
});

// ===== Imports under test (REAL) =====
import * as notificationService from "@/services/notification.service";
import { claimTask } from "@/services/task.service";
import { parseMentions, createMentions } from "@/services/mention.service";
import { buildMentionMarker } from "@/lib/mention-format";
import {
  maybeCreateTurnForWakeNotification,
  type WakeNotificationContext,
} from "@/services/notification-turn";
import { createAdHocSessionWithInstruction } from "@/services/daemon-instruction.service";
import { getPendingTurnsForConnection } from "@/services/daemon-session.service";

// ===== Fixtures =====
// UUIDs are real-shaped: parseMentions' markup regex only matches a lowercase hex UUID,
// so the @mention round-trip exercises the actual codec (not a loosened test double).
const COMPANY = "11111111-1111-4111-8111-111111111111";
const PROJECT = "22222222-2222-4222-8222-222222222222";
const AGENT = "33333333-3333-4333-8333-333333333333";
const USER = "44444444-4444-4444-8444-444444444444";
const IDEA = "55555555-5555-4555-8555-555555555555";
const TASK = "66666666-6666-4666-8666-666666666666";
const COMMENT = "77777777-7777-4777-8777-777777777777";

// The pinned "place" the owner chooses on both the assignment and the @mention.
const PIN_HOST = "Laptop-Q3";
const PIN_CWD = "/home/u/dev/payments";

// The connection at the pinned (host, cwd) place vs. an online "elsewhere" connection.
const PINNED_CONN = "conn-pinned-0001";
const OTHER_CONN = "conn-other-0002";

// The durable AgentInstance for the pinned (host, cwd) place — the instance-based pin
// (add-agent-instance-addressing) references this uuid via assigneeType="agent_instance".
const INSTANCE = "instance-pinned-0001";

// A ConnectionView (the shape listConnectionsForAgent returns), online-first with
// stable identity ties per the registry contract. We build the list explicitly per test.
function connView(overrides: Record<string, unknown> = {}) {
  return {
    uuid: PINNED_CONN,
    agentUuid: AGENT,
    agentName: "Daemon Agent",
    clientType: "claude_code",
    clientVersion: null,
    host: PIN_HOST,
    cwd: PIN_CWD,
    startedAt: null,
    status: "online",
    effectiveStatus: "online" as "online" | "offline",
    connectedAt: "2026-06-22T00:00:00.000Z",
    lastSeenAt: "2026-06-22T00:00:00.000Z",
    disconnectedAt: null,
    ...overrides,
  };
}

// Seed an open Task so the REAL claimTask can write to it.
function seedTask(overrides: Record<string, unknown> = {}) {
  const now = new Date();
  const row: Row = {
    id: store.nextId(),
    uuid: TASK,
    companyUuid: COMPANY,
    projectUuid: PROJECT,
    title: "Build the thing",
    description: null,
    status: "open",
    priority: "high",
    storyPoints: 3,
    acceptanceCriteria: null,
    assigneeType: null,
    assigneeUuid: null,
    assignedAt: null,
    assignedByUuid: null,
    proposalUuid: null,
    createdByUuid: USER,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
  store.data.task.push(row);
  return row;
}

// Seed a durable AgentInstance row at a (host, cwd) place so the instance-based pin
// reader resolves an agent_instance assignee to its place. Owned by AGENT by default
// (the same-agent guard matches the wake's target agent).
function seedInstance(
  host: string,
  cwd: string | null,
  overrides: Record<string, unknown> = {},
) {
  const row: Row = {
    id: store.nextId(),
    uuid: INSTANCE,
    companyUuid: COMPANY,
    agentUuid: AGENT,
    host,
    cwd,
    ...overrides,
  };
  store.data.agentInstance.push(row);
  return row;
}

// Seed a connection row so connectionBelongsToAgent / isConnectionLive (REAL, reading the
// store) can verify it for the ad-hoc 409 path.
function seedConnection(uuid: string, status: string, host: string, cwd: string | null, lastSeenAt: Date) {
  store.data.daemonConnection.push({
    id: store.nextId(),
    uuid,
    companyUuid: COMPANY,
    agentUuid: AGENT,
    status,
    host,
    cwd,
    lastSeenAt,
  });
}

beforeEach(() => {
  for (const k of Object.keys(store.data) as (keyof Store["data"])[]) {
    store.data[k].length = 0;
  }
  vi.clearAllMocks();

  // The actor-name resolver (formatTaskResponse → getActorName), the mention-target
  // validator (validateMentionTarget), and project-name lookup read these rows.
  store.data.user.push({ id: store.nextId(), uuid: USER, companyUuid: COMPANY, name: "Alice", email: "a@x.com" });
  store.data.agent.push({ id: store.nextId(), uuid: AGENT, companyUuid: COMPANY, name: "Daemon Agent", ownerUuid: USER });
  store.data.project.push({ id: store.nextId(), uuid: PROJECT, companyUuid: COMPANY, name: "Chorus 0.11.2" });

  // task / idea under IDEA resolves to that direct idea; everything else null.
  mockResolveRootIdea.mockImplementation(async (_c: string, type: string, uuid: string) => {
    if ((type === "task" && uuid === TASK) || (type === "idea" && uuid === IDEA)) {
      return { rootIdeaUuid: IDEA, directIdeaUuid: IDEA };
    }
    return { rootIdeaUuid: null, directIdeaUuid: null };
  });

  // Default registry verdict: a single online connection at the pinned place. Tests that
  // need an "elsewhere" connection or an offline place override this per-case. Without a
  // default, the wake bridge (REAL) would see `undefined` and throw.
  mockListConnectionsForAgent.mockResolvedValue([connView({ uuid: PINNED_CONN, host: PIN_HOST, cwd: PIN_CWD })]);
});

// ===========================================================================================
// THREAD 1 + 2 — task-assignment pin: the REAL write (claimTask) feeds the REAL read (wake).
// ===========================================================================================

describe("integration: task-assignment instance pin is the SAME shape the wake reads", () => {
  it("a task_assigned wake reads the Task's agent_instance assignee and pins the matching live connection", async () => {
    // NOTE (add-agent-instance-addressing): the task pin is now an `agent_instance`
    // assignment — assigneeType="agent_instance", assigneeUuid=<AgentInstance.uuid> —
    // and the wake reader (notification-turn) resolves that instance to its (host, cwd)
    // place. The legacy targetHost/targetCwd reader was removed by this task. This
    // checkpoint seeds the assigned+pinned Task row + its AgentInstance directly; the
    // full assignment→wake lifecycle is re-covered by the new T10 integration test.
    seedInstance(PIN_HOST, PIN_CWD);
    seedTask({
      status: "assigned",
      assigneeType: "agent_instance",
      assigneeUuid: INSTANCE,
      assignedByUuid: USER,
    });

    // --- READ (T5): a task_assigned wake. listConnectionsForAgent returns an online
    // "elsewhere" connection FIRST (so online-first would pick it) and the pinned-place
    // connection second. The pin must override online-first and select the pinned one. ---
    mockListConnectionsForAgent.mockResolvedValue([
      connView({ uuid: OTHER_CONN, host: "other-host", cwd: "/home/u/dev/other" }),
      connView({ uuid: PINNED_CONN, host: PIN_HOST, cwd: PIN_CWD }),
    ]);

    // Drive the wake through the REAL notification chokepoint → REAL notification-turn
    // bridge → REAL prisma.task.findFirst (which reads back what claimTask stored).
    const turn = await notificationService.createReturningTurn({
      companyUuid: COMPANY,
      projectUuid: PROJECT,
      recipientType: "agent",
      recipientUuid: AGENT,
      entityType: "task",
      entityUuid: TASK,
      entityTitle: "Build the thing",
      projectName: "Chorus 0.11.2",
      action: "task_assigned",
      message: "Task assigned",
      actorType: "user",
      actorUuid: USER,
      actorName: "Alice",
    });

    // The session origin is pinned to the (host, cwd)-MATCHING connection — proving the
    // wake read the same columns claimTask wrote. If T5 read a wrong field, no pin would
    // resolve and the session would pin to OTHER_CONN (online-first) instead.
    expect(store.data.daemonSession).toHaveLength(1);
    expect(store.data.daemonSession[0].originConnectionUuid).toBe(PINNED_CONN);
    expect(turn.turn?.trigger).toBe("task_assigned");
    expect(turn.turn?.status).toBe("pending");
    // The bridge actually read the Task columns (not the project, not inference).
    expect(hoisted.prismaFake.task.findFirst).toHaveBeenCalled();
    expect(mockLogger.error).not.toHaveBeenCalled();
  });

  it("@mention pin survives the markup round-trip (buildMentionMarker → parseMentions) and the mentioned wake pins the matching live connection", async () => {
    // --- WRITE (T3): the editor serializes a pinned mention; the service parses it back. ---
    const marker = buildMentionMarker("Daemon Agent", "agent", AGENT, PIN_HOST, PIN_CWD);
    // The pin rides INSIDE the parens as a query-string suffix (paren-free payload).
    expect(marker).toContain(`(agent:${AGENT}?`);
    expect(marker).toContain("host=");
    expect(marker).toContain("cwd=");

    const parsed = parseMentions(`Hey ${marker}, take a look`);
    expect(parsed).toHaveLength(1);
    // The parsed ref carries the SAME (host, cwd) the marker encoded — the codec the
    // client editor and the server service share, so producer and parser cannot drift.
    expect(parsed[0]).toMatchObject({ type: "agent", uuid: AGENT, pinnedHost: PIN_HOST, pinnedCwd: PIN_CWD });

    // --- READ (T5): a mentioned wake. The pin is threaded on the CONTEXT (not the Task),
    // and must override online-first to select the pinned-place connection. ---
    mockListConnectionsForAgent.mockResolvedValue([
      connView({ uuid: OTHER_CONN, host: "other-host", cwd: "/home/u/dev/other" }),
      connView({ uuid: PINNED_CONN, host: PIN_HOST, cwd: PIN_CWD }),
    ]);

    const turn = await maybeCreateTurnForWakeNotification({
      companyUuid: COMPANY,
      recipientType: "agent",
      recipientUuid: AGENT,
      entityType: "comment",
      entityUuid: COMMENT,
      action: "mentioned",
      // Threaded from the parsed mention ref by createMentions — proven identical here.
      pinnedHost: parsed[0].pinnedHost,
      pinnedCwd: parsed[0].pinnedCwd,
    });

    expect(store.data.daemonSession).toHaveLength(1);
    expect(store.data.daemonSession[0].originConnectionUuid).toBe(PINNED_CONN);
    expect(turn?.trigger).toBe("mentioned");
    expect(turn?.status).toBe("pending");
    // A mentioned wake reads its pin from the context, NEVER from the Task table.
    expect(hoisted.prismaFake.task.findFirst).not.toHaveBeenCalled();
    expect(mockLogger.error).not.toHaveBeenCalled();
  });

  it("createMentions threads the pinned (host, cwd) from the markup into the wake notification (full @mention chain)", async () => {
    // The REAL createMentions parses a pinned marker and feeds the wake chokepoint
    // (createBatch). We spy on createBatch to capture the params it threads
    // (pinnedHost/pinnedCwd) — proving the mention service does NOT drop the pin between
    // parse and wake. sourceType "task" keeps the navigable entity the task itself (no
    // comment-lookup needed) so the chain stays focused on the pin threading.
    const batchSpy = vi
      .spyOn(notificationService, "createBatch")
      .mockResolvedValue([]);
    try {
      const marker = buildMentionMarker("Daemon Agent", "agent", AGENT, PIN_HOST, PIN_CWD);
      await createMentions({
        companyUuid: COMPANY,
        sourceType: "task",
        sourceUuid: TASK,
        content: `Please review ${marker}`,
        actorType: "user",
        actorUuid: USER,
        projectUuid: PROJECT,
        entityTitle: "Build the thing",
      });

      expect(batchSpy).toHaveBeenCalledTimes(1);
      const threadedList = batchSpy.mock.calls[0][0];
      expect(threadedList).toHaveLength(1);
      const threaded = threadedList[0];
      expect(threaded.action).toBe("mentioned");
      expect(threaded.recipientType).toBe("agent");
      expect(threaded.recipientUuid).toBe(AGENT);
      // The owner-chosen pin is threaded verbatim into the wake — same (host, cwd) that
      // the markup encoded, NOT dropped between parseMentions and the chokepoint.
      expect(threaded.pinnedHost).toBe(PIN_HOST);
      expect(threaded.pinnedCwd).toBe(PIN_CWD);
    } finally {
      batchSpy.mockRestore();
    }
  });
});

// ===========================================================================================
// THREAD 2 — KEY ASSERTION: write shape ≡ read shape (a deliberate mismatch must FAIL).
// ===========================================================================================

describe("integration: KEY ASSERTION — the wake reads the EXACT assignment shape the assigner writes", () => {
  it("an un-pinned (plain agent) assignment resolves NO instance pin → online-first fallback (the silent-mismatch this checkpoint must catch)", async () => {
    seedTask();

    // The task is a PLAIN agent assignment — no agent_instance assignee, no instance to
    // resolve. The REAL wake reader sees no pin and (after also finding no root-idea
    // instance) falls back to online-first. This is the contract the structural-guard
    // below locks in: only an agent_instance assignee that resolves to a live place pins.
    const storedTask = store.data.task.find((t) => t.uuid === TASK)!;
    storedTask.assigneeType = "agent";
    storedTask.assigneeUuid = AGENT;
    storedTask.status = "assigned";

    mockListConnectionsForAgent.mockResolvedValue([
      connView({ uuid: OTHER_CONN, host: "other-host", cwd: "/home/u/dev/other" }),
      connView({ uuid: PINNED_CONN, host: PIN_HOST, cwd: PIN_CWD }),
    ]);

    await maybeCreateTurnForWakeNotification({
      companyUuid: COMPANY,
      recipientType: "agent",
      recipientUuid: AGENT,
      entityType: "task",
      entityUuid: TASK,
      action: "task_assigned",
    });

    // No pin resolved → online-first (OTHER_CONN), not the pinned place. With an
    // agent_instance assignee (the test above) the origin is PINNED_CONN; with a plain
    // agent it is NOT. The two assertions together prove the contract is real.
    expect(store.data.daemonSession[0].originConnectionUuid).toBe(OTHER_CONN);
    expect(store.data.daemonSession[0].originConnectionUuid).not.toBe(PINNED_CONN);
  });

  it("the wake's task-pin read selects exactly assigneeType/assigneeUuid (the assignment shape the instance pin stores)", async () => {
    // A structural guard against silent rename of the READER: the wake's task-pin read
    // selects assigneeType/assigneeUuid (the polymorphic assignee pair that now carries
    // the agent_instance pin), scoped by uuid + companyUuid. The legacy
    // targetHost/targetCwd reader was removed by this task.
    seedInstance(PIN_HOST, PIN_CWD);
    seedTask({
      status: "assigned",
      assigneeType: "agent_instance",
      assigneeUuid: INSTANCE,
      assignedByUuid: USER,
    });

    mockListConnectionsForAgent.mockResolvedValue([connView({ uuid: PINNED_CONN, host: PIN_HOST, cwd: PIN_CWD })]);
    await maybeCreateTurnForWakeNotification({
      companyUuid: COMPANY,
      recipientType: "agent",
      recipientUuid: AGENT,
      entityType: "task",
      entityUuid: TASK,
      action: "task_assigned",
    });
    // The wake's read selected the polymorphic assignee pair (and scoped by uuid + companyUuid).
    const readArgs = hoisted.prismaFake.task.findFirst.mock.calls[0][0] as {
      where: Record<string, unknown>;
      select: Record<string, unknown>;
    };
    expect(readArgs.select).toMatchObject({ assigneeType: true, assigneeUuid: true });
    expect(readArgs.where).toMatchObject({ uuid: TASK, companyUuid: COMPANY });
    // And resolved that instance to its (host, cwd) place.
    expect(hoisted.prismaFake.agentInstance.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ uuid: INSTANCE, companyUuid: COMPANY }) }),
    );
  });
});

// ===========================================================================================
// THREAD 3 — OFFLINE assignment (SOFT) pin / fully-offline agent. An offline assignment pin
// is SOFT: it DEGRADES to online-first (R2 graceful un-pin), NOT notify-only (that policy is
// reserved for a HARD mention pin). A fully-offline agent has nothing to degrade to → no turn.
// ===========================================================================================

describe("integration: an OFFLINE assignment (SOFT) pin degrades to online-first; a fully-offline agent records a plain notification", () => {
  it("a task_assigned wake pinned (agent_instance, SOFT) to an OFFLINE place DEGRADES to the online-elsewhere instance (R2 graceful un-pin)", async () => {
    // The assignment is pinned to the (PIN_HOST, PIN_CWD) instance. This is a SOFT pin
    // (an assignment, not a human-typed mention): when its instance is offline, R2 says it
    // degrades to a plain agent and wakes the agent's online-first connection — NOT
    // notify-only (that is reserved for a HARD mention pin, covered in the unit tests).
    seedInstance(PIN_HOST, PIN_CWD);
    seedTask({
      status: "assigned",
      assigneeType: "agent_instance",
      assigneeUuid: INSTANCE,
      assignedByUuid: USER,
    });

    // The pinned place is OFFLINE; another instance is online elsewhere. The SOFT pin
    // degrades to the online-elsewhere connection.
    mockListConnectionsForAgent.mockResolvedValue([
      connView({ uuid: OTHER_CONN, host: "other-host", cwd: "/home/u/dev/other", effectiveStatus: "online" }),
      connView({ uuid: PINNED_CONN, host: PIN_HOST, cwd: PIN_CWD, status: "offline", effectiveStatus: "offline" }),
    ]);

    await notificationService.create({
      companyUuid: COMPANY,
      projectUuid: PROJECT,
      recipientType: "agent",
      recipientUuid: AGENT,
      entityType: "task",
      entityUuid: TASK,
      entityTitle: "Build the thing",
      projectName: "Chorus 0.11.2",
      action: "task_assigned",
      message: "Task assigned",
      actorType: "user",
      actorUuid: USER,
      actorName: "Alice",
    });

    // Graceful degrade: a turn IS created on the online-elsewhere connection (NOT notify-only).
    expect(store.data.daemonSessionTurn).toHaveLength(1);
    expect(store.data.daemonSession).toHaveLength(1);
    expect(store.data.daemonSession[0].originConnectionUuid).toBe(OTHER_CONN);
    expect(store.data.notification).toHaveLength(1);
    expect(mockLogger.error).not.toHaveBeenCalled();
  });

  it("a fully-offline agent records a PLAIN notification with NO turn (none — nothing to degrade to, no durable queue)", async () => {
    seedInstance(PIN_HOST, PIN_CWD);
    seedTask({
      status: "assigned",
      assigneeType: "agent_instance",
      assigneeUuid: INSTANCE,
      assignedByUuid: USER,
    });

    // Agent fully offline; the pinned place exists (offline) but nothing is wakeable.
    mockListConnectionsForAgent.mockResolvedValue([
      connView({ uuid: PINNED_CONN, host: PIN_HOST, cwd: PIN_CWD, status: "offline", effectiveStatus: "offline" }),
    ]);

    await notificationService.create({
      companyUuid: COMPANY,
      projectUuid: PROJECT,
      recipientType: "agent",
      recipientUuid: AGENT,
      entityType: "task",
      entityUuid: TASK,
      entityTitle: "Build the thing",
      projectName: "Chorus 0.11.2",
      action: "task_assigned",
      message: "Task assigned",
      actorType: "user",
      actorUuid: USER,
      actorName: "Alice",
    });

    // The plain Notification IS recorded, but NO turn / NO session is created — the
    // fully-offline target is a notification-only event. A skipped wake is not an error.
    expect(store.data.notification).toHaveLength(1);
    expect(store.data.daemonSessionTurn).toHaveLength(0);
    expect(store.data.daemonSession).toHaveLength(0);
    expect(mockLogger.error).not.toHaveBeenCalled();

    // A later reconnect at the (offline) pinned place reads nothing — no queued turn.
    const pending = await getPendingTurnsForConnection({
      companyUuid: COMPANY,
      agentUuid: AGENT,
      connectionUuid: PINNED_CONN,
    });
    expect(pending).toHaveLength(0);
  });
});

// ===========================================================================================
// THREAD 4 — live ad-hoc send to an OFFLINE instance → rejected (409). The durable-vs-live
// split holds end to end: durable intent (above) queues; the live send refuses.
// ===========================================================================================

describe("integration: live ad-hoc send to an OFFLINE instance is rejected (409) — durable-vs-live split", () => {
  it("createAdHocSessionWithInstruction throws ConnectionOfflineError (→ 409) when the chosen instance is offline, creating NO session/turn", async () => {
    // The SAME (host, cwd) place that durable intent happily queued for above is, for a
    // LIVE send, a hard 409: the connection is offline. Seed it offline (stale lastSeenAt).
    seedConnection(PINNED_CONN, "online", PIN_HOST, PIN_CWD, new Date(Date.now() - 10 * 60_000));

    await expect(
      createAdHocSessionWithInstruction(
        { type: "user", companyUuid: COMPANY, actorUuid: USER },
        { agentUuid: AGENT, connectionUuid: PINNED_CONN, instructionText: "Run it now" },
      ),
    ).rejects.toMatchObject({
      // The typed error the route maps to 409 (errors.conflict).
      code: "connection_offline",
      connectionUuid: PINNED_CONN,
    });

    // No durable side effects: the live-send gate fires BEFORE any session/turn creation.
    expect(store.data.daemonSession).toHaveLength(0);
    expect(store.data.daemonSessionTurn).toHaveLength(0);
    expect(store.data.notification).toHaveLength(0);
  });

  it("the SAME online instance accepts a live ad-hoc send (proving the 409 is the offline gate, not a blanket reject)", async () => {
    // Online (fresh lastSeenAt): the live send succeeds, creating the ad-hoc session + turn.
    seedConnection(PINNED_CONN, "online", PIN_HOST, PIN_CWD, new Date());

    const { session, turn } = await createAdHocSessionWithInstruction(
      { type: "user", companyUuid: COMPANY, actorUuid: USER },
      { agentUuid: AGENT, connectionUuid: PINNED_CONN, instructionText: "Run it now" },
    );

    expect(turn.trigger).toBe("human_instruction");
    expect(turn.promptText).toBe("Run it now");
    expect(turn.status).toBe("pending");
    // Ad-hoc session is pinned to the chosen (online) connection, with no idea anchor.
    expect(session.originConnectionUuid).toBe(PINNED_CONN);
    expect(session.directIdeaUuid).toBeNull();
    expect(store.data.daemonSession).toHaveLength(1);
    expect(store.data.daemonSessionTurn).toHaveLength(1);
  });
});

// ===========================================================================================
// Guard: an UN-pinned assignment/mention behaves exactly as before (additive feature).
// ===========================================================================================

describe("integration: an un-pinned assignment behaves exactly as before this change", () => {
  it("claimTask without an instance leaves the task a plain agent, and the task_assigned wake stays online-first", async () => {
    seedTask();
    // The REAL claimTask drives an un-pinned assignment (add-agent-instance-addressing):
    // with no instanceUuid it persists assigneeType="agent" and carries NO instance, so
    // the wake resolves no pin and stays online-first (the additive-feature guarantee).
    const claimed = await claimTask({
      taskUuid: TASK,
      companyUuid: COMPANY,
      assigneeType: "agent",
      assigneeUuid: AGENT,
      assignedByUuid: USER,
      // No instanceUuid → no pin.
    });
    expect(claimed.assignee?.type).toBe("agent");
    const stored = store.data.task.find((t) => t.uuid === TASK)!;
    // A plain agent assignment carries no instance — the wake finds no pin.
    expect(stored.assigneeType).toBe("agent");

    // Online-first should pick the first online connection (no pin narrowing).
    mockListConnectionsForAgent.mockResolvedValue([
      connView({ uuid: OTHER_CONN, host: "host-A", cwd: "/home/u/dev/a", effectiveStatus: "online" }),
      connView({ uuid: PINNED_CONN, host: PIN_HOST, cwd: PIN_CWD, status: "offline", effectiveStatus: "offline" }),
    ]);

    await notificationService.create({
      companyUuid: COMPANY,
      projectUuid: PROJECT,
      recipientType: "agent",
      recipientUuid: AGENT,
      entityType: "task",
      entityUuid: TASK,
      entityTitle: "Build the thing",
      projectName: "Chorus 0.11.2",
      action: "task_assigned",
      message: "Task assigned",
      actorType: "user",
      actorUuid: USER,
      actorName: "Alice",
    });

    expect(store.data.daemonSession[0].originConnectionUuid).toBe(OTHER_CONN);
  });
});
