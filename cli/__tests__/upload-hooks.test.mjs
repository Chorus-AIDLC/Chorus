// cli/__tests__/upload-hooks.test.mjs
// Covers daemon-execution-state spec step 3: the execution-state upload hook
// builds a snapshot from real WakeQueue/waker state and POSTs it to
// /api/daemon/execution-state on each wake lifecycle transition (enqueue → wake
// start → wake finish), against a FAKE server (injected fetch). Also asserts the
// fire-and-forget contract: an upload failure is logged and never throws into
// the wake path; and that uploads are skipped until the connectionUuid is known.
import { describe, it, expect, vi } from "vitest";
import {
  createExecutionUploadHooks,
  createNoopUploadHooks,
} from "../upload-hooks.mjs";
import { Waker } from "../waker.mjs";
import { EventRouter } from "../event-router.mjs";
import { WakeQueue } from "../wake-queue.mjs";
import { WAKE_ACTIONS } from "../prompts.mjs";

const silent = { info() {}, warn() {}, error() {} };

const TASK_NOTIF = {
  uuid: "notif-1",
  projectUuid: "proj-1",
  entityType: "task",
  entityUuid: "task-1",
  entityTitle: "Build the thing",
  action: "task_assigned",
  message: "",
  actorType: "user",
  actorUuid: "user-1",
  actorName: "Alice",
};

/** A fake server: records every POST body and answers ok unless told otherwise. */
function fakeServer({ ok = true, status = 200 } = {}) {
  const posts = [];
  const fetchImpl = vi.fn(async (url, init) => {
    posts.push({ url: String(url), init, body: JSON.parse(init.body) });
    return { ok, status, async json() { return { success: ok, data: { reconciled: 0 } }; } };
  });
  return { posts, fetchImpl };
}

/** Wait for the chained fire-and-forget uploads to settle. */
async function flush() {
  for (let i = 0; i < 5; i++) await Promise.resolve();
  await new Promise((r) => setTimeout(r, 0));
}

describe("createExecutionUploadHooks snapshot upload", () => {
  it("POSTs the connectionUuid + snapshot to /api/daemon/execution-state with Bearer creds", async () => {
    const { posts, fetchImpl } = fakeServer();
    const snapshot = [
      { entityType: "task", entityUuid: "task-1", rootIdeaUuid: "root-1", status: "running", startedAt: "2026-06-16T00:00:00.000Z" },
      { entityType: "idea", entityUuid: "idea-2", rootIdeaUuid: null, status: "queued", startedAt: null },
    ];
    const hooks = createExecutionUploadHooks({
      url: "https://chorus.example/",
      apiKey: "cho_secret",
      getConnectionUuid: () => "conn-9",
      getSnapshot: () => snapshot,
      logger: silent,
      fetchImpl,
    });

    hooks.onExecutionChange();
    await flush();

    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const { url, init, body } = posts[0];
    expect(url).toBe("https://chorus.example/api/daemon/execution-state");
    expect(init.method).toBe("POST");
    expect(init.headers).toMatchObject({
      Authorization: "Bearer cho_secret",
      "Content-Type": "application/json",
    });
    expect(body).toEqual({ connectionUuid: "conn-9", executions: snapshot });
  });

  it("skips the upload while the connectionUuid is not yet known (no POST, not an error)", async () => {
    const { fetchImpl } = fakeServer();
    const warns = [];
    const hooks = createExecutionUploadHooks({
      url: "https://c",
      apiKey: "k",
      getConnectionUuid: () => null, // handshake hasn't reported it yet
      getSnapshot: () => [{ entityType: "task", entityUuid: "t", rootIdeaUuid: null, status: "queued", startedAt: null }],
      logger: { ...silent, warn: (m) => warns.push(m) },
      fetchImpl,
    });

    hooks.onExecutionChange();
    await flush();

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(warns).toEqual([]); // not-yet-registered is a normal state, not a logged failure
  });

  it("a network failure is logged (no silent error) and never throws", async () => {
    const warns = [];
    const fetchImpl = vi.fn(async () => {
      throw new Error("ECONNREFUSED");
    });
    const hooks = createExecutionUploadHooks({
      url: "https://c",
      apiKey: "k",
      getConnectionUuid: () => "conn-1",
      getSnapshot: () => [],
      logger: { ...silent, warn: (m) => warns.push(m) },
      fetchImpl,
    });

    // Synchronous, non-throwing call (fire-and-forget).
    expect(() => hooks.onExecutionChange()).not.toThrow();
    await flush();

    expect(warns.join("")).toMatch(/upload request failed/i);
  });

  it("a non-2xx response is logged and non-fatal", async () => {
    const warns = [];
    const { fetchImpl } = fakeServer({ ok: false, status: 404 });
    const hooks = createExecutionUploadHooks({
      url: "https://c",
      apiKey: "k",
      getConnectionUuid: () => "conn-1",
      getSnapshot: () => [],
      logger: { ...silent, warn: (m) => warns.push(m) },
      fetchImpl,
    });

    hooks.onExecutionChange();
    await flush();

    expect(warns.join("")).toMatch(/returned 404/);
  });

  it("a snapshot-build error is logged and does not POST", async () => {
    const warns = [];
    const { fetchImpl } = fakeServer();
    const hooks = createExecutionUploadHooks({
      url: "https://c",
      apiKey: "k",
      getConnectionUuid: () => "conn-1",
      getSnapshot: () => {
        throw new Error("registry exploded");
      },
      logger: { ...silent, warn: (m) => warns.push(m) },
      fetchImpl,
    });

    hooks.onExecutionChange();
    await flush();

    expect(fetchImpl).not.toHaveBeenCalled();
    expect(warns.join("")).toMatch(/snapshot build failed/i);
  });
});

describe("createNoopUploadHooks", () => {
  it("has a no-op onExecutionChange that does nothing and does not throw", () => {
    const hooks = createNoopUploadHooks();
    expect(typeof hooks.onExecutionChange).toBe("function");
    expect(() => hooks.onExecutionChange()).not.toThrow();
  });
});

// ===== Waker snapshot from real lifecycle =====

// A canonical lowercase UUID for the deterministic session id (direct idea).
const DIRECT_IDEA = "11111111-1111-4111-8111-111111111111";

function makeWaker(hooks, overrides = {}) {
  const spawner =
    overrides.spawner ??
    {
      wake: vi.fn(async ({ sessionId, onMessage }) => {
        onMessage?.({ type: "system", session_id: sessionId });
        return { sessionId, exitCode: 0, isNew: true };
      }),
    };
  const lineage =
    overrides.lineage ??
    { resolve: vi.fn(async () => ({ rootIdeaUuid: "root-1", directIdeaUuid: DIRECT_IDEA })) };
  const writeMcpConfigFn = vi.fn(() => ({ path: "/tmp/m.json", cleanup: vi.fn() }));
  const waker = new Waker({
    creds: { url: "https://c", apiKey: "cho_x" },
    lineage,
    spawner,
    cwd: "/work/dir",
    hooks,
    logger: silent,
    writeMcpConfigFn,
    // Disk probe stubbed → always "new"; these tests don't exercise resume.
    isNewSessionFn: () => true,
  });
  return { waker, spawner };
}

// Attribution object as keyFor would produce it, for a given resolved root idea.
// The wake/markQueued calls below thread this so the snapshot reports the root.
function attrib(rootIdeaUuid, directIdeaUuid = DIRECT_IDEA) {
  return { key: `idea:${directIdeaUuid}`, rootIdeaUuid, directIdeaUuid };
}

describe("Waker.buildExecutionSnapshot from lifecycle transitions", () => {
  it("markQueued → queued entry; wake start → running+startedAt; wake finish → removed", async () => {
    const changes = [];
    const hooks = { ...createNoopUploadHooks(), onExecutionChange: () => changes.push("change") };
    const { waker } = makeWaker(hooks);

    // Enqueue: marks the task queued and emits a snapshot.
    waker.markQueued(TASK_NOTIF, `idea:${DIRECT_IDEA}`, attrib("root-1"));
    expect(waker.buildExecutionSnapshot()).toEqual([
      { entityType: "task", entityUuid: "task-1", rootIdeaUuid: "root-1", status: "queued", startedAt: null },
    ]);
    expect(changes).toHaveLength(1);

    // Run the wake. While running, the snapshot shows running + a startedAt.
    let snapshotDuringRun;
    const { waker: waker2 } = makeWaker(hooks, {
      spawner: {
        wake: vi.fn(async ({ sessionId }) => {
          snapshotDuringRun = waker2.buildExecutionSnapshot();
          return { sessionId, exitCode: 0, isNew: true };
        }),
      },
    });
    waker2.markQueued(TASK_NOTIF, `idea:${DIRECT_IDEA}`, attrib("root-1"));
    await waker2.wake(TASK_NOTIF, `idea:${DIRECT_IDEA}`, attrib("root-1"));

    expect(snapshotDuringRun).toHaveLength(1);
    expect(snapshotDuringRun[0]).toMatchObject({ entityType: "task", entityUuid: "task-1", rootIdeaUuid: "root-1", status: "running" });
    expect(snapshotDuringRun[0].startedAt).toBeTruthy();
    expect(Number.isNaN(Date.parse(snapshotDuringRun[0].startedAt))).toBe(false);

    // After the wake finishes, the task has left the active set.
    expect(waker2.buildExecutionSnapshot()).toEqual([]);
  });

  it("fires onExecutionChange on enqueue, on wake start, and on wake finish", async () => {
    const changes = [];
    const hooks = { ...createNoopUploadHooks(), onExecutionChange: () => changes.push(Date.now()) };
    const { waker } = makeWaker(hooks);

    waker.markQueued(TASK_NOTIF, `idea:${DIRECT_IDEA}`, attrib("root-1")); // enqueue → 1
    await waker.wake(TASK_NOTIF, `idea:${DIRECT_IDEA}`, attrib("root-1")); // start → +1, finish → +1

    expect(changes.length).toBe(3);
  });

  it("a failing wake still removes the task and emits a finish snapshot (non-fatal)", async () => {
    const changes = [];
    const hooks = { ...createNoopUploadHooks(), onExecutionChange: () => changes.push("c") };
    const { waker } = makeWaker(hooks, {
      spawner: { wake: vi.fn(async () => { throw new Error("spawn boom"); }) },
    });

    waker.markQueued(TASK_NOTIF, `idea:${DIRECT_IDEA}`, attrib("root-1"));
    await expect(waker.wake(TASK_NOTIF, `idea:${DIRECT_IDEA}`, attrib("root-1"))).resolves.toBeUndefined();
    // queued + running + finish = 3 changes; task removed after finish.
    expect(changes.length).toBe(3);
    expect(waker.buildExecutionSnapshot()).toEqual([]);
  });

  it("an IDEA wake (@-mention/elaboration under an idea) IS tracked as an idea resource", async () => {
    // This is the core fix: previously only entityType==="task" was recorded, so
    // @mentioning an agent under an idea woke + ran Claude but produced ZERO
    // execution rows → empty UI. Now every recognized wake resource is tracked.
    const changes = [];
    const hooks = { ...createNoopUploadHooks(), onExecutionChange: () => changes.push("c") };
    const ideaNotif = { ...TASK_NOTIF, entityType: "idea", entityUuid: "idea-7", action: "mentioned" };
    const { waker } = makeWaker(hooks);

    // Idea wake: direct == root == idea-7 (a top-level idea); attribution carries the root.
    waker.markQueued(ideaNotif, "idea:idea-7", { key: "idea:idea-7", rootIdeaUuid: "idea-7", directIdeaUuid: "idea-7" });
    expect(waker.buildExecutionSnapshot()).toEqual([
      { entityType: "idea", entityUuid: "idea-7", rootIdeaUuid: "idea-7", status: "queued", startedAt: null },
    ]);
    expect(changes).toEqual(["c"]); // tracked → snapshot emitted
  });

  it("a notification with an UNRECOGNIZED entityType is not tracked (nothing to attribute)", async () => {
    const changes = [];
    const hooks = { ...createNoopUploadHooks(), onExecutionChange: () => changes.push("c") };
    const commentNotif = { ...TASK_NOTIF, entityType: "comment", entityUuid: "c-1", action: "mentioned" };
    const { waker } = makeWaker(hooks);

    waker.markQueued(commentNotif, "entity:comment:c-1", { key: "entity:comment:c-1", rootIdeaUuid: null, directIdeaUuid: null });
    expect(waker.buildExecutionSnapshot()).toEqual([]);
    expect(changes).toEqual([]);
  });

  it("a hook that throws never breaks the wake (emit is non-throwing)", async () => {
    const hooks = {
      ...createNoopUploadHooks(),
      onExecutionChange: () => { throw new Error("hook boom"); },
    };
    const { waker } = makeWaker(hooks);
    expect(() => waker.markQueued(TASK_NOTIF, `idea:${DIRECT_IDEA}`, attrib("root-1"))).not.toThrow();
    await expect(waker.wake(TASK_NOTIF, `idea:${DIRECT_IDEA}`, attrib("root-1"))).resolves.toBeUndefined();
  });

  it("per-entity fallback (no idea ancestor) yields a null rootIdeaUuid in the snapshot", () => {
    const hooks = createNoopUploadHooks();
    const { waker } = makeWaker(hooks);
    waker.markQueued(TASK_NOTIF, "entity:task:task-1", { key: "entity:task:task-1", rootIdeaUuid: null, directIdeaUuid: null });
    expect(waker.buildExecutionSnapshot()).toEqual([
      { entityType: "task", entityUuid: "task-1", rootIdeaUuid: null, status: "queued", startedAt: null },
    ]);
  });
});

// ===== End-to-end: router → queue → waker → hook → fake server =====

describe("execution upload end-to-end through router/queue/waker", () => {
  it("a dispatched task posts queued then running then ended-by-omission snapshots", async () => {
    const { posts, fetchImpl } = fakeServer();
    // Mutable holder so the snapshot closure can predate the waker (mirrors how
    // daemon.mjs wires the hooks before the waker exists).
    let waker;
    const hooks = createExecutionUploadHooks({
      url: "https://chorus.example",
      apiKey: "cho_x",
      getConnectionUuid: () => "conn-1",
      getSnapshot: () => waker?.buildExecutionSnapshot() ?? [],
      logger: silent,
      fetchImpl,
    });

    const queue = new WakeQueue({ logger: silent });
    const spawner = {
      wake: vi.fn(async () => ({ sessionId: "sid", exitCode: 0, isNew: true })),
    };
    waker = makeWaker(hooks, { spawner }).waker;
    const mcpClient = { callTool: vi.fn(async () => ({ notifications: [TASK_NOTIF] })) };
    const router = new EventRouter({
      mcpClient,
      waker,
      queue,
      wakeActions: WAKE_ACTIONS,
      logger: silent,
    });

    router.dispatch({ type: "new_notification", notificationUuid: "notif-1" });
    // Let fetch/route/queue/spawn + chained uploads settle.
    await new Promise((r) => setTimeout(r, 30));

    // At least: queued (enqueue), running (start), and removed (finish).
    const statusesByCall = posts.map((p) => p.body.executions.map((e) => e.status));
    // queued snapshot present
    expect(statusesByCall.some((s) => s.includes("queued"))).toBe(true);
    // running snapshot present
    expect(statusesByCall.some((s) => s.includes("running"))).toBe(true);
    // final snapshot is empty (task left the active set → server ends it by omission)
    expect(posts[posts.length - 1].body.executions).toEqual([]);
    // every POST carried the connectionUuid
    expect(posts.every((p) => p.body.connectionUuid === "conn-1")).toBe(true);
  });
});
