// Integration checkpoint for the daemon `directIdeaUuid` execution-snapshot contract
// (fix-daemon-child-idea-wake-anchor, Task 6 — the Round-1 proposal-reviewer BLOCKER).
//
// WHY this exists: `directIdeaUuid` is threaded across a cross-process, largely UNTYPED
// wire — the CLI daemon's JS emitter (cli/waker.mjs), a hand-maintained OpenClaw wire
// type (packages/openclaw-plugin/src/daemon-rest-client.ts), the server zod schema, the
// Prisma column, the ExecutionView projection, and the chat-UI match predicate. Every
// layer has its own single-layer unit test, but a field-name drift at a seam (the CLI
// emitting `directIdea` instead of `directIdeaUuid`, say) is invisible to `tsc` (the CLI
// is JS) and would pass every per-layer test while the server silently persists
// `directIdeaUuid = null` — re-shipping the exact parent-anchors-the-child bug.
//
// This test ties the layers together so a seam drift FAILS:
//   1. It takes the REAL entry the CLI daemon emits (a live `Waker.buildExecutionSnapshot()`),
//   2. POSTs it through the REAL server route (real zod parse → real
//      `filterValidExecutionEntities` → real `reconcileSnapshot` → real
//      `publishExecutionChange` → real `toExecutionView`), only Prisma/auth/eventBus mocked,
//   3. asserts `directIdeaUuid = child` survived persistence (upsert create + update) AND the
//      published ExecutionView,
//   4. feeds that ExecutionView into the REAL `executionMatchesSession` and asserts it matches
//      the CHILD conversation but NOT the parent — the child-only anchoring regression, and
//   5. guards CLI ↔ OpenClaw field-set parity so the two daemon hosts cannot drift apart.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { NextRequest } from "next/server";

// ===== Mocks (only the infra edges; the whole service + route stay REAL) =====
const mockPrisma = vi.hoisted(() => ({
  daemonExecution: {
    upsert: vi.fn(),
    updateMany: vi.fn(),
    findMany: vi.fn(),
  },
  daemonConnection: {
    count: vi.fn(),
    findMany: vi.fn(),
  },
  task: { findMany: vi.fn() },
  idea: { findMany: vi.fn() },
  proposal: { findMany: vi.fn() },
  document: { findMany: vi.fn() },
  daemonSession: { findMany: vi.fn() },
  daemonSessionTurn: { findMany: vi.fn() },
}));
vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));

const mockLogger = vi.hoisted(() => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }));
// The route runs through withErrorHandler, which calls createRequestLogger — provide it so
// the REAL route module loads (this test deliberately keeps the route unmocked).
vi.mock("@/lib/logger", () => ({
  default: mockLogger,
  createRequestLogger: () => mockLogger,
  getRequestLogger: () => mockLogger,
}));

const mockEventBus = vi.hoisted(() => ({ emit: vi.fn() }));
vi.mock("@/lib/event-bus", () => ({ eventBus: mockEventBus }));

const mockGetAuthContext = vi.hoisted(() => vi.fn());
vi.mock("@/lib/auth", () => ({ getAuthContext: (...a: unknown[]) => mockGetAuthContext(...a) }));

// The route + service are the REAL modules under test (NOT mocked).
import { POST } from "@/app/api/daemon/execution-state/route";
import { executionMatchesSession } from "@/components/agent-presence/chat/session-execution";
// The real CLI daemon emitter — the actual wire producer, not a fixture.
import { Waker } from "../../../cli/waker.mjs";

// ===== Fixtures =====
const companyUuid = "company-0000-0000-0000-000000000001";
const agentUuid = "agent-0000-0000-0000-000000000001";
const connectionUuid = "conn-0000-0000-0000-000000000001";
const taskUuid = "task-0000-0000-0000-0000000000aa";
const childIdea = "idea-child-0000-0000-0000-00000000c1";
const parentIdea = "idea-parent-0000-0000-0000-0000000p2";

const agentAuth = { type: "agent", companyUuid, actorUuid: agentUuid, permissions: [] };

function postRequest(body: unknown): NextRequest {
  return new NextRequest(new URL("http://localhost:3000/api/daemon/execution-state"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// Produce the EXACT snapshot entry the CLI daemon emits for a child-idea wake, from a live
// Waker — so a rename in cli/waker.mjs's buildExecutionSnapshot is caught here, not masked.
function cliEmittedChildIdeaEntry() {
  const waker = new Waker({
    creds: { url: "https://c", apiKey: "cho_x" },
    lineage: { resolve: async () => ({ rootIdeaUuid: parentIdea, directIdeaUuid: childIdea }) },
    spawner: { wake: async () => ({ sessionId: childIdea, exitCode: 0, isNew: true }) },
  });
  // Attribution as keyFor would thread it for a task under a derived (child) idea.
  waker.markQueued(
    { entityType: "task", entityUuid: taskUuid },
    `idea:${childIdea}`,
    { rootIdeaUuid: parentIdea, directIdeaUuid: childIdea },
  );
  const snapshot = waker.buildExecutionSnapshot();
  return snapshot[0];
}

describe("directIdeaUuid end-to-end wire contract (integration checkpoint)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAuthContext.mockResolvedValue(agentAuth);

    // connectionBelongsToAgent → owns it.
    mockPrisma.daemonConnection.count.mockResolvedValue(1);
    // filterRowsByLiveConnection → connection online.
    mockPrisma.daemonConnection.findMany.mockResolvedValue([
      { uuid: connectionUuid, status: "online", lastSeenAt: new Date() },
    ]);
    // Entity + idea existence (filterValidExecutionEntities validity + enrichment titles).
    mockPrisma.task.findMany.mockResolvedValue([
      { uuid: taskUuid, title: "Child task", projectUuid: "proj-1" },
    ]);
    mockPrisma.idea.findMany.mockResolvedValue([
      { uuid: parentIdea, title: "Parent idea", projectUuid: "proj-1" },
    ]);
    // reconcileSnapshot's "end absent" active-row query (has a `select`) → none to end.
    // getExecutionsForConnection's read query (no `select`) → the just-persisted row,
    // carrying directIdeaUuid = child, so the REAL toExecutionView projects it.
    mockPrisma.daemonExecution.findMany.mockImplementation(async (args: { select?: unknown }) => {
      if (args?.select) return []; // reconcile active-rows sweep
      return [
        {
          id: 1,
          uuid: "exec-1",
          agentUuid,
          connectionUuid,
          entityType: "task",
          entityUuid: taskUuid,
          rootIdeaUuid: parentIdea,
          directIdeaUuid: childIdea,
          status: "running",
          interruptedReason: null,
          startedAt: new Date("2026-07-14T00:00:00.000Z"),
          createdAt: new Date("2026-07-14T00:00:00.000Z"),
          updatedAt: new Date("2026-07-14T00:00:00.000Z"),
        },
      ];
    });
    mockPrisma.daemonExecution.updateMany.mockResolvedValue({ count: 0 });
    mockPrisma.daemonExecution.upsert.mockResolvedValue({});
  });

  it("carries directIdeaUuid from the real CLI emit → zod → reconcile → toExecutionView → match", async () => {
    const entry = cliEmittedChildIdeaEntry();
    // Sanity: the live CLI emitter actually produced the field with the child value
    // (guards the daemon-side seam — a rename here fails immediately).
    expect(entry).toHaveProperty("directIdeaUuid", childIdea);
    expect(entry.rootIdeaUuid).toBe(parentIdea);

    // Drive the REAL route: real zod parse + real filter + real reconcile + real publish.
    const res = await POST(postRequest({ connectionUuid, executions: [entry] }), {
      params: Promise.resolve({}),
    });
    expect(res.status).toBe(200);

    // (a) Persistence hop: the upsert on BOTH arms carries directIdeaUuid = child, distinct
    //     from rootIdeaUuid = parent. If zod stripped the field or the CLI emitted the wrong
    //     key, this is null here.
    expect(mockPrisma.daemonExecution.upsert).toHaveBeenCalledTimes(1);
    const upArg = mockPrisma.daemonExecution.upsert.mock.calls[0][0];
    expect(upArg.create.directIdeaUuid).toBe(childIdea);
    expect(upArg.create.rootIdeaUuid).toBe(parentIdea);
    expect(upArg.update.directIdeaUuid).toBe(childIdea);
    expect(upArg.update.rootIdeaUuid).toBe(parentIdea);

    // (b) Projection hop: publishExecutionChange emitted an ExecutionView (via the REAL
    //     toExecutionView) carrying directIdeaUuid = child.
    expect(mockEventBus.emit).toHaveBeenCalledTimes(1);
    const event = mockEventBus.emit.mock.calls[0][1] as {
      executions: Array<{
        entityType: string;
        entityUuid: string;
        directIdeaUuid: string | null;
        rootIdeaUuid: string | null;
      }>;
    };
    expect(event.executions).toHaveLength(1);
    const view = event.executions[0];
    expect(view.directIdeaUuid).toBe(childIdea);
    expect(view.rootIdeaUuid).toBe(parentIdea);

    // (c) Match hop: the emitted ExecutionView matches the CHILD conversation and NOT the
    //     parent — the whole point of the fix (child-only anchoring, no parent bleed).
    expect(executionMatchesSession(view, { sessionId: childIdea, directIdeaUuid: childIdea })).toBe(true);
    expect(executionMatchesSession(view, { sessionId: parentIdea, directIdeaUuid: parentIdea })).toBe(false);
  });

  it("cross-host parity: the CLI and OpenClaw snapshot emitters expose the SAME field set (incl. directIdeaUuid)", () => {
    // CLI keys: from the LIVE emitter (runtime truth).
    const cliKeys = Object.keys(cliEmittedChildIdeaEntry()).sort();

    // OpenClaw keys: parsed from its buildExecutionSnapshot source (a separately-published
    // package that cannot be imported here — same rationale as the wake-parity guard). We
    // extract the `<key>: e.<field>` mappings inside its buildExecutionSnapshot().
    const HERE = path.dirname(fileURLToPath(import.meta.url));
    const openclawClient = path.resolve(
      HERE, "..", "..", "..", "packages", "openclaw-plugin", "src", "daemon-client.ts",
    );
    const src = readFileSync(openclawClient, "utf8");
    const start = src.indexOf("buildExecutionSnapshot()");
    expect(start, "buildExecutionSnapshot not found in OpenClaw daemon-client.ts").toBeGreaterThan(-1);
    const body = src.slice(start, src.indexOf("}", src.indexOf(".map((e) => ({", start)));
    const openclawKeys = [...body.matchAll(/(\w+):\s*e\.\w+/g)].map((m) => m[1]).sort();

    // Both hosts MUST include directIdeaUuid...
    expect(cliKeys).toContain("directIdeaUuid");
    expect(openclawKeys).toContain("directIdeaUuid");
    // ...and expose the identical field set, so one host adding/renaming a field without the
    // other fails this guard (the server zod is nullish-tolerant and would not catch it).
    expect(openclawKeys).toEqual(cliKeys);
  });
});
