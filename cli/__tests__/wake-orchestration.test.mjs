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

function makeWaker(overrides = {}) {
  const spawner = overrides.spawner ?? {
    wake: vi.fn(async ({ onMessage }) => {
      onMessage?.({ type: "system", session_id: "new-sid" });
      return { sessionId: "new-sid", exitCode: 0, isNew: true };
    }),
  };
  const sessionMap =
    overrides.sessionMap ??
    {
      resolve: vi.fn(() => ({ sessionId: null, isNew: true })),
      record: vi.fn(),
    };
  const lineage = overrides.lineage ?? { rootIdeaFor: vi.fn(async () => "root-1") };
  const hooks = overrides.hooks ?? createNoopUploadHooks();
  const writeMcpConfigFn =
    overrides.writeMcpConfigFn ?? vi.fn(() => ({ path: "/tmp/m.json", cleanup: vi.fn() }));
  const waker = new Waker({
    creds: { url: "https://c", apiKey: "cho_x" },
    lineage,
    sessionMap,
    spawner,
    hooks,
    logger: silent,
    writeMcpConfigFn,
  });
  return { waker, spawner, sessionMap, lineage, hooks, writeMcpConfigFn };
}

describe("Waker.wake full loop", () => {
  it("resolves key, builds mcp-config, spawns, records session, cleans up", async () => {
    const { waker, spawner, sessionMap, writeMcpConfigFn } = makeWaker();
    const cfg = { path: "/tmp/m.json", cleanup: vi.fn() };
    writeMcpConfigFn.mockReturnValue(cfg);

    const key = await waker.keyFor(TASK_NOTIF);
    expect(key).toBe("idea:root-1");

    await waker.wake(TASK_NOTIF, key);

    // spawner got the prompt + null sessionId (new) + mcp config path
    const spawnArgs = spawner.wake.mock.calls[0][0];
    expect(spawnArgs.prompt).toContain("task-1");
    expect(spawnArgs.sessionId).toBeNull();
    expect(spawnArgs.mcpConfigPath).toBe("/tmp/m.json");
    // new session id recorded for the key
    expect(sessionMap.record).toHaveBeenCalledWith("idea:root-1", "new-sid");
    // temp config cleaned up
    expect(cfg.cleanup).toHaveBeenCalled();
  });

  it("passes --resume sessionId for an existing root", async () => {
    const { waker, spawner } = makeWaker({
      sessionMap: { resolve: () => ({ sessionId: "existing-sid", isNew: false }), record: vi.fn() },
    });
    await waker.wake(TASK_NOTIF, "idea:root-1");
    expect(spawner.wake.mock.calls[0][0].sessionId).toBe("existing-sid");
  });

  it("falls back to a per-entity key when there's no idea ancestor", async () => {
    const { waker } = makeWaker({ lineage: { rootIdeaFor: async () => null } });
    const key = await waker.keyFor(TASK_NOTIF);
    expect(key).toBe("entity:task:task-1");
  });

  it("a spawn failure is logged and does NOT throw", async () => {
    const warns = [];
    const { waker } = makeWaker({
      spawner: { wake: vi.fn(async () => { throw new Error("spawn exploded"); }) },
    });
    waker.logger = { ...silent, warn: (m) => warns.push(m) };
    await expect(waker.wake(TASK_NOTIF, "idea:root-1")).resolves.toBeUndefined();
    expect(warns.join("")).toMatch(/wake failed/);
  });

  it("invokes the onSessionStart upload hook (no-op here)", async () => {
    const onSessionStart = vi.fn(async () => {});
    const { waker } = makeWaker({
      hooks: { onSessionStart, onConnect: async () => {}, onTranscriptMessage: async () => {} },
    });
    await waker.wake(TASK_NOTIF, "idea:root-1");
    expect(onSessionStart).toHaveBeenCalledWith(
      expect.objectContaining({ rootIdeaKey: "idea:root-1", isNew: true })
    );
  });

  it("does NOT record a session id when the wake exits non-zero (no phantom --resume)", async () => {
    const record = vi.fn();
    const { waker } = makeWaker({
      sessionMap: { resolve: () => ({ sessionId: null, isNew: true }), record },
      // exitCode null (e.g. claude missing) — must not be recorded
      spawner: { wake: vi.fn(async () => ({ sessionId: "phantom", exitCode: null, isNew: true })) },
    });
    await waker.wake(TASK_NOTIF, "idea:root-1");
    expect(record).not.toHaveBeenCalled();
  });

  it("records the session id only on a clean (exit 0) wake", async () => {
    const record = vi.fn();
    const { waker } = makeWaker({
      sessionMap: { resolve: () => ({ sessionId: null, isNew: true }), record },
      spawner: { wake: vi.fn(async () => ({ sessionId: "real-sid", exitCode: 0, isNew: true })) },
    });
    await waker.wake(TASK_NOTIF, "idea:root-1");
    expect(record).toHaveBeenCalledWith("idea:root-1", "real-sid");
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

  it("routes a task_assigned notification onto the queue under its root-idea key", async () => {
    const enqueued = [];
    const queue = { enqueue: (key, task) => enqueued.push({ key, task }) };
    const waker = {
      keyFor: vi.fn(async () => "idea:root-1"),
      wake: vi.fn(async () => {}),
    };
    const { router } = makeRouter([TASK_NOTIF], waker, queue);

    router.dispatch({ type: "new_notification", notificationUuid: "notif-1" });
    await new Promise((r) => setTimeout(r, 0));

    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].key).toBe("idea:root-1");
    // running the enqueued task calls waker.wake with the notification + key
    await enqueued[0].task();
    expect(waker.wake).toHaveBeenCalledWith(TASK_NOTIF, "idea:root-1");
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
    const waker = { keyFor: vi.fn(async () => "idea:root-1"), wake: vi.fn(async () => {}) };
    const seen = new Set();
    const { router } = makeRouter([TASK_NOTIF], waker, queue, seen);

    // Live delivery, then a reconnect-backfill re-dispatch of the SAME uuid.
    router.dispatch({ type: "new_notification", notificationUuid: "notif-1" });
    router.dispatch({ type: "new_notification", notificationUuid: "notif-1" });
    await new Promise((r) => setTimeout(r, 0));

    expect(enqueued).toHaveLength(1); // only one wake despite two dispatches
    expect(seen.has("notif-1")).toBe(true);
  });

  it("two same-root notifications do not spawn concurrently (serialized via the real queue)", async () => {
    const queue = new WakeQueue({ logger: silent });
    let concurrent = 0;
    let maxConcurrent = 0;
    const spawner = {
      wake: vi.fn(async () => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((r) => setTimeout(r, 5));
        concurrent--;
        return { sessionId: "sid", exitCode: 0, isNew: true };
      }),
    };
    const { waker } = makeWaker({ spawner, lineage: { rootIdeaFor: async () => "root-1" } });
    const notifA = { ...TASK_NOTIF, uuid: "a" };
    const notifB = { ...TASK_NOTIF, uuid: "b" };
    const { router } = makeRouter([notifA, notifB], waker, queue);

    router.dispatch({ type: "new_notification", notificationUuid: "a" });
    router.dispatch({ type: "new_notification", notificationUuid: "b" });
    await new Promise((r) => setTimeout(r, 40));

    expect(spawner.wake).toHaveBeenCalledTimes(2);
    expect(maxConcurrent).toBe(1); // same root → never concurrent
  });
});
