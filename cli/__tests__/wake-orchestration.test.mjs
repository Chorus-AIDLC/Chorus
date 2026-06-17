// cli/__tests__/wake-orchestration.test.mjs
// Covers the EventRouter → Waker → ClaudeSpawner wake loop, prompt builders,
// failure isolation, and the no-op upload hooks (cli-daemon spec
// "Task-dispatch wake" + "Reserved upload hooks").
import { describe, it, expect, vi } from "vitest";
import { buildPrompt, WAKE_ACTIONS } from "../prompts.mjs";
import { createNoopUploadHooks } from "../upload-hooks.mjs";
import { Waker } from "../waker.mjs";
import { EventRouter } from "../event-router.mjs";
import { WakeQueue } from "../wake-queue.mjs";

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

describe("buildPrompt", () => {
  it("task_assigned prompt contains the task + project UUIDs and the claim tool", () => {
    const p = buildPrompt(TASK_NOTIF);
    expect(p).toContain("task-1");
    expect(p).toContain("proj-1");
    expect(p).toContain("chorus_get_task");
    expect(p).toContain("chorus_claim_task");
    expect(p).toContain("@[Alice](user:user-1)"); // mention guidance
  });

  it("returns null for non-wake actions", () => {
    expect(buildPrompt({ ...TASK_NOTIF, action: "count_update" })).toBeNull();
    // Deliberately-ignored real actions also return null.
    expect(buildPrompt({ ...TASK_NOTIF, action: "task_status_changed" })).toBeNull();
    expect(buildPrompt({ ...TASK_NOTIF, action: "report_created" })).toBeNull();
  });

  it("comment_added does NOT wake (too noisy); only an explicit @mention does", () => {
    // A plain comment to the task's assignee/creator should be ignored...
    expect(buildPrompt({ ...TASK_NOTIF, action: "comment_added", message: "please rebase" })).toBeNull();
    // ...but an @mention (delivered as action "mentioned") wakes.
    const m = buildPrompt({ ...TASK_NOTIF, action: "mentioned", message: "@agent please rebase" });
    expect(m).not.toBeNull();
    expect(m).toContain("chorus_get_comments");
  });

  it("builds a non-null prompt for every action in WAKE_ACTIONS (no dead/missing entries)", () => {
    for (const action of WAKE_ACTIONS) {
      const p = buildPrompt({ ...TASK_NOTIF, action });
      expect(p, `WAKE_ACTIONS has "${action}" but buildPrompt returns null for it`).not.toBeNull();
    }
  });

  it("WAKE_ACTIONS covers the agent-relevant server notifications and excludes the noisy ones", () => {
    for (const a of [
      "task_assigned",
      "mentioned",
      "elaboration_requested",
      "elaboration_answered",
      "proposal_rejected",
      "proposal_approved",
      "idea_claimed",
      "task_reopened",
      "task_verified",
    ]) {
      expect(WAKE_ACTIONS.has(a), `expected ${a} to wake`).toBe(true);
    }
    for (const a of [
      "comment_added",
      "task_status_changed",
      "task_submitted_for_verify",
      "report_created",
      "count_update",
    ]) {
      expect(WAKE_ACTIONS.has(a), `expected ${a} NOT to wake`).toBe(false);
    }
  });
});

// A canonical lowercase UUID used as the direct idea (= deterministic session id).
const DIRECT_IDEA = "11111111-1111-4111-8111-111111111111";
const ROOT_IDEA = "99999999-9999-4999-8999-999999999999";

function makeWaker(overrides = {}) {
  const spawner = overrides.spawner ?? {
    wake: vi.fn(async ({ sessionId, onMessage }) => {
      onMessage?.({ type: "system", session_id: sessionId });
      return { sessionId, exitCode: 0, isNew: true };
    }),
  };
  // Lineage now resolves BOTH ids in one call. Default: direct ≠ root.
  const lineage =
    overrides.lineage ??
    { resolve: vi.fn(async () => ({ rootIdeaUuid: ROOT_IDEA, directIdeaUuid: DIRECT_IDEA })) };
  const hooks = overrides.hooks ?? createNoopUploadHooks();
  const writeMcpConfigFn =
    overrides.writeMcpConfigFn ?? vi.fn(() => ({ path: "/tmp/m.json", cleanup: vi.fn() }));
  // Disk probe is injected so tests control new-vs-resume without touching the FS.
  const isNewSessionFn = overrides.isNewSessionFn ?? vi.fn(() => true);
  const waker = new Waker({
    creds: { url: "https://c", apiKey: "cho_x" },
    lineage,
    spawner,
    cwd: overrides.cwd ?? "/work/dir",
    hooks,
    logger: silent,
    writeMcpConfigFn,
    isNewSessionFn,
  });
  return { waker, spawner, lineage, hooks, writeMcpConfigFn, isNewSessionFn };
}

describe("Waker.wake full loop", () => {
  it("keyFor anchors on the DIRECT idea and returns both ids", async () => {
    const { waker } = makeWaker();
    const resolved = await waker.keyFor(TASK_NOTIF);
    expect(resolved).toEqual({
      key: `idea:${DIRECT_IDEA}`,
      rootIdeaUuid: ROOT_IDEA,
      directIdeaUuid: DIRECT_IDEA,
    });
  });

  it("spawns with the direct idea as session id, --session-id (new) when no transcript, cleans up", async () => {
    const { waker, spawner, writeMcpConfigFn, isNewSessionFn } = makeWaker();
    const cfg = { path: "/tmp/m.json", cleanup: vi.fn() };
    writeMcpConfigFn.mockReturnValue(cfg);

    const resolved = await waker.keyFor(TASK_NOTIF);
    await waker.wake(TASK_NOTIF, resolved.key, resolved);

    const spawnArgs = spawner.wake.mock.calls[0][0];
    expect(spawnArgs.prompt).toContain("task-1");
    expect(spawnArgs.sessionId).toBe(DIRECT_IDEA); // deterministic = direct idea uuid
    expect(spawnArgs.isNew).toBe(true); // no transcript on disk → new session
    expect(spawnArgs.cwd).toBe("/work/dir"); // same cwd threaded for probe + spawn
    expect(spawnArgs.mcpConfigPath).toBe("/tmp/m.json");
    // probe used the SAME cwd as the spawn
    expect(isNewSessionFn).toHaveBeenCalledWith(DIRECT_IDEA, "/work/dir");
    // temp config cleaned up
    expect(cfg.cleanup).toHaveBeenCalled();
  });

  it("passes isNew=false (resume) when the transcript already exists on disk", async () => {
    const { waker, spawner } = makeWaker({ isNewSessionFn: vi.fn(() => false) });
    const resolved = await waker.keyFor(TASK_NOTIF);
    await waker.wake(TASK_NOTIF, resolved.key, resolved);
    expect(spawner.wake.mock.calls[0][0].isNew).toBe(false);
    expect(spawner.wake.mock.calls[0][0].sessionId).toBe(DIRECT_IDEA);
  });

  it("falls back to a per-entity key when there's no direct idea", async () => {
    const { waker } = makeWaker({
      lineage: { resolve: async () => ({ rootIdeaUuid: null, directIdeaUuid: null }) },
    });
    const resolved = await waker.keyFor(TASK_NOTIF);
    expect(resolved.key).toBe("entity:task:task-1");
    expect(resolved.directIdeaUuid).toBeNull();
  });

  it("STILL spawns for a no-idea entity (quick task), anchoring on the entity's OWN uuid", async () => {
    // Regression guard: a task_assigned for a quick task (no proposal → no idea
    // ancestor) is the daemon's headline use case. It must still wake Claude — the
    // session is anchored on the entity's own uuid (deterministic + resumable),
    // NOT dropped because directIdeaUuid is null.
    const QUICK_TASK = "22222222-2222-4222-8222-222222222222"; // entityUuid IS a uuid
    const { waker, spawner } = makeWaker({
      lineage: { resolve: async () => ({ rootIdeaUuid: null, directIdeaUuid: null }) },
    });
    const notif = { ...TASK_NOTIF, entityType: "task", entityUuid: QUICK_TASK };
    const resolved = await waker.keyFor(notif);
    expect(resolved.key).toBe(`entity:task:${QUICK_TASK}`); // per-entity serialization
    await waker.wake(notif, resolved.key, resolved);

    expect(spawner.wake).toHaveBeenCalledTimes(1); // it DID spawn
    const args = spawner.wake.mock.calls[0][0];
    expect(args.sessionId).toBe(QUICK_TASK); // anchored on the entity's own uuid
    // snapshot still reports null root (no idea ancestor) — not the entity uuid
    expect(resolved.rootIdeaUuid).toBeNull();
  });

  it("a spawn failure is logged and does NOT throw", async () => {
    const warns = [];
    const { waker } = makeWaker({
      spawner: { wake: vi.fn(async () => { throw new Error("spawn exploded"); }) },
    });
    waker.logger = { ...silent, warn: (m) => warns.push(m) };
    const resolved = await waker.keyFor(TASK_NOTIF);
    await expect(waker.wake(TASK_NOTIF, resolved.key, resolved)).resolves.toBeUndefined();
    expect(warns.join("")).toMatch(/wake failed/);
  });

  it("invokes the onSessionStart upload hook (no-op here)", async () => {
    const onSessionStart = vi.fn(async () => {});
    const { waker } = makeWaker({
      hooks: { onSessionStart, onConnect: async () => {}, onTranscriptMessage: async () => {} },
    });
    const resolved = await waker.keyFor(TASK_NOTIF);
    await waker.wake(TASK_NOTIF, resolved.key, resolved);
    expect(onSessionStart).toHaveBeenCalledWith(
      expect.objectContaining({ rootIdeaKey: `idea:${DIRECT_IDEA}`, sessionId: DIRECT_IDEA, isNew: true })
    );
  });

  it("logs a non-zero exit visibly (no-silent-errors), still no throw", async () => {
    const warns = [];
    const { waker } = makeWaker({
      spawner: { wake: vi.fn(async ({ sessionId }) => ({ sessionId, exitCode: 2, isNew: true })) },
    });
    waker.logger = { ...silent, warn: (m) => warns.push(m) };
    const resolved = await waker.keyFor(TASK_NOTIF);
    await waker.wake(TASK_NOTIF, resolved.key, resolved);
    expect(warns.join("")).toMatch(/exited non-zero/);
  });

  it("execution snapshot reports the RESOLVED ROOT idea, NOT the direct-idea key (two-id contract)", async () => {
    // The BLOCKER regression guard: with direct ≠ root, the snapshot's rootIdeaUuid
    // must be the server-resolved root, never the direct idea carried by the key.
    let snapshotDuringRun;
    const { waker } = makeWaker({
      spawner: {
        wake: vi.fn(async ({ sessionId }) => {
          snapshotDuringRun = waker.buildExecutionSnapshot();
          return { sessionId, exitCode: 0, isNew: true };
        }),
      },
    });
    const resolved = await waker.keyFor(TASK_NOTIF);
    expect(resolved.directIdeaUuid).not.toBe(resolved.rootIdeaUuid); // precondition
    await waker.wake(TASK_NOTIF, resolved.key, resolved);

    expect(snapshotDuringRun).toHaveLength(1);
    expect(snapshotDuringRun[0].rootIdeaUuid).toBe(ROOT_IDEA); // resolved root, not DIRECT_IDEA
    expect(snapshotDuringRun[0].rootIdeaUuid).not.toBe(DIRECT_IDEA);
    expect(snapshotDuringRun[0].entityUuid).toBe("task-1");
  });

  it("markQueued reports the resolved root idea (not sliced from the key)", async () => {
    const { waker } = makeWaker();
    const resolved = await waker.keyFor(TASK_NOTIF);
    waker.markQueued(TASK_NOTIF, resolved.key, resolved);
    const snap = waker.buildExecutionSnapshot();
    expect(snap).toHaveLength(1);
    expect(snap[0].rootIdeaUuid).toBe(ROOT_IDEA);
    expect(snap[0].status).toBe("queued");
  });
});

describe("EventRouter dispatch", () => {
  function makeRouter(notifications, waker, queue, seen) {
    const mcpClient = { callTool: vi.fn(async () => ({ notifications })) };
    const router = new EventRouter({
      mcpClient,
      waker,
      queue,
      wakeActions: WAKE_ACTIONS,
      seen,
      logger: silent,
    });
    return { router, mcpClient };
  }

  it("routes a task_assigned notification onto the queue under its direct-idea key", async () => {
    const enqueued = [];
    const queue = { enqueue: (key, task) => enqueued.push({ key, task }) };
    const attribution = { key: `idea:${DIRECT_IDEA}`, rootIdeaUuid: ROOT_IDEA, directIdeaUuid: DIRECT_IDEA };
    const waker = {
      keyFor: vi.fn(async () => attribution),
      markQueued: vi.fn(),
      wake: vi.fn(async () => {}),
    };
    const { router } = makeRouter([TASK_NOTIF], waker, queue);

    router.dispatch({ type: "new_notification", notificationUuid: "notif-1" });
    await new Promise((r) => setTimeout(r, 0));

    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].key).toBe(`idea:${DIRECT_IDEA}`);
    // markQueued got the resolved attribution (so the snapshot can report the root)
    expect(waker.markQueued).toHaveBeenCalledWith(TASK_NOTIF, `idea:${DIRECT_IDEA}`, attribution);
    // running the enqueued task calls waker.wake with the notification + key + attribution
    await enqueued[0].task();
    expect(waker.wake).toHaveBeenCalledWith(TASK_NOTIF, `idea:${DIRECT_IDEA}`, attribution);
  });

  it("ignores non-new_notification events and non-wake actions", async () => {
    const queue = { enqueue: vi.fn() };
    const waker = { keyFor: vi.fn(), wake: vi.fn() };
    const { router } = makeRouter([{ ...TASK_NOTIF, action: "count_update" }], waker, queue);

    router.dispatch({ type: "count_update" });
    router.dispatch({ type: "new_notification", notificationUuid: "notif-1" });
    await new Promise((r) => setTimeout(r, 0));

    expect(queue.enqueue).not.toHaveBeenCalled();
  });

  it("de-dupes a notification already handled (shared seen set) — no double wake on reconnect", async () => {
    const enqueued = [];
    const queue = { enqueue: (key, task) => enqueued.push({ key, task }) };
    const waker = {
      keyFor: vi.fn(async () => ({ key: `idea:${DIRECT_IDEA}`, rootIdeaUuid: ROOT_IDEA, directIdeaUuid: DIRECT_IDEA })),
      markQueued: vi.fn(),
      wake: vi.fn(async () => {}),
    };
    const seen = new Set();
    const { router } = makeRouter([TASK_NOTIF], waker, queue, seen);

    // Live delivery, then a reconnect-backfill re-dispatch of the SAME uuid.
    router.dispatch({ type: "new_notification", notificationUuid: "notif-1" });
    router.dispatch({ type: "new_notification", notificationUuid: "notif-1" });
    await new Promise((r) => setTimeout(r, 0));

    expect(enqueued).toHaveLength(1); // only one wake despite two dispatches
    expect(seen.has("notif-1")).toBe(true);
  });

  it("two same-direct-idea notifications do not spawn concurrently (serialized via the real queue)", async () => {
    const queue = new WakeQueue({ logger: silent });
    let concurrent = 0;
    let maxConcurrent = 0;
    const spawner = {
      wake: vi.fn(async ({ sessionId }) => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((r) => setTimeout(r, 5));
        concurrent--;
        return { sessionId, exitCode: 0, isNew: true };
      }),
    };
    // Both notifications resolve to the SAME direct idea → same key → serialized.
    const { waker } = makeWaker({
      spawner,
      lineage: { resolve: async () => ({ rootIdeaUuid: ROOT_IDEA, directIdeaUuid: DIRECT_IDEA }) },
    });
    const notifA = { ...TASK_NOTIF, uuid: "a" };
    const notifB = { ...TASK_NOTIF, uuid: "b" };
    const { router } = makeRouter([notifA, notifB], waker, queue);

    router.dispatch({ type: "new_notification", notificationUuid: "a" });
    router.dispatch({ type: "new_notification", notificationUuid: "b" });
    await new Promise((r) => setTimeout(r, 40));

    expect(spawner.wake).toHaveBeenCalledTimes(2);
    expect(maxConcurrent).toBe(1); // same direct idea → never concurrent
  });
});
