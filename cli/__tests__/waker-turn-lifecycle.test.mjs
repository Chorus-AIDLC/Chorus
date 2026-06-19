// cli/__tests__/waker-turn-lifecycle.test.mjs
// Covers the Waker advancing the server-side DaemonSessionTurn (子1 —
// daemon-session-conversation): pending→running on spawn, running→ended on exit,
// reusing the existing executions map / onChild hook (no parallel registry), with the
// entity threaded so the server can stamp the executionUuid linkage.
import { describe, it, expect, vi } from "vitest";
import { Waker } from "../waker.mjs";

const silent = { info() {}, warn() {}, error() {} };

const DIRECT_IDEA = "11111111-1111-4111-8111-111111111111";
const ROOT_IDEA = "99999999-9999-4999-8999-999999999999";

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

// A spawner that DOES invoke onChild (the live-spawn moment the running turn-advance
// hangs off) before resolving with the given exit code.
function spawnerThatSpawns(exitCode = 0) {
  return {
    wake: vi.fn(async ({ sessionId, onChild, onMessage }) => {
      onChild?.({ pid: 4242, on: () => {}, kill: () => {} });
      onMessage?.({ type: "system", session_id: sessionId });
      return { sessionId, exitCode, isNew: true };
    }),
  };
}

// A spawner that NEVER calls onChild (e.g. a spawn that failed before the child
// materialized) — the turn must stay pending and ended must NOT be attempted.
function spawnerThatNeverSpawns() {
  return {
    wake: vi.fn(async ({ sessionId }) => ({ sessionId, exitCode: null, isNew: true })),
  };
}

function makeWaker(overrides = {}) {
  const advanceTurn = overrides.advanceTurn ?? vi.fn(async () => {});
  const waker = new Waker({
    creds: { url: "https://c", apiKey: "cho_x" },
    lineage:
      overrides.lineage ??
      { resolve: vi.fn(async () => ({ rootIdeaUuid: ROOT_IDEA, directIdeaUuid: DIRECT_IDEA })) },
    spawner: overrides.spawner ?? spawnerThatSpawns(0),
    cwd: "/work/dir",
    hooks: overrides.hooks,
    logger: overrides.logger ?? silent,
    writeMcpConfigFn: vi.fn(() => ({ path: "/tmp/m.json", cleanup: vi.fn() })),
    isNewSessionFn: vi.fn(() => true),
    reportInterrupt: vi.fn(async () => {}),
    advanceTurn,
  });
  return { waker, advanceTurn, spawner: waker.spawner };
}

describe("Waker turn lifecycle (子1)", () => {
  it("advances pending→running on spawn and running→ended on exit, keyed on the session id, with the entity for executionUuid linkage", async () => {
    const { waker, advanceTurn } = makeWaker();
    const resolved = await waker.keyFor(TASK_NOTIF);
    await waker.wake(TASK_NOTIF, resolved.key, resolved);

    expect(advanceTurn).toHaveBeenCalledTimes(2);
    // running first, then ended — strict forward order.
    expect(advanceTurn.mock.calls[0][0]).toEqual({
      sessionId: DIRECT_IDEA, // the session anchor = direct idea uuid
      status: "running",
      entityType: "task",
      entityUuid: "task-1",
    });
    expect(advanceTurn.mock.calls[1][0]).toEqual({
      sessionId: DIRECT_IDEA,
      status: "ended",
      entityType: "task",
      entityUuid: "task-1",
    });
  });

  it("anchors the turn on the entity's own uuid when there is no direct idea (ad-hoc session)", async () => {
    const QUICK_TASK = "22222222-2222-4222-8222-222222222222";
    const { waker, advanceTurn } = makeWaker({
      lineage: { resolve: async () => ({ rootIdeaUuid: null, directIdeaUuid: null }) },
    });
    const notif = { ...TASK_NOTIF, entityUuid: QUICK_TASK };
    const resolved = await waker.keyFor(notif);
    await waker.wake(notif, resolved.key, resolved);

    expect(advanceTurn).toHaveBeenCalledTimes(2);
    expect(advanceTurn.mock.calls[0][0].sessionId).toBe(QUICK_TASK);
    expect(advanceTurn.mock.calls[0][0].status).toBe("running");
    expect(advanceTurn.mock.calls[1][0].status).toBe("ended");
  });

  it("still advances running→ended on a NON-ZERO exit (a turn ends regardless of exit code)", async () => {
    const { waker, advanceTurn } = makeWaker({ spawner: spawnerThatSpawns(2) });
    const resolved = await waker.keyFor(TASK_NOTIF);
    await waker.wake(TASK_NOTIF, resolved.key, resolved);

    const statuses = advanceTurn.mock.calls.map((c) => c[0].status);
    expect(statuses).toEqual(["running", "ended"]);
  });

  it("does NOT attempt ended when the subprocess never spawned (turn stays pending; no illegal pending→ended)", async () => {
    const { waker, advanceTurn } = makeWaker({ spawner: spawnerThatNeverSpawns() });
    const resolved = await waker.keyFor(TASK_NOTIF);
    await waker.wake(TASK_NOTIF, resolved.key, resolved);

    // onChild never fired → no running, and therefore no ended either.
    expect(advanceTurn).not.toHaveBeenCalled();
  });

  it("reuses the existing executions map / onChild — the running entry still gets its child handle", async () => {
    // Assert the turn-advance addition did NOT displace the 子3 child-capture: the
    // running execution entry must still hold the live child for the interrupt path.
    let capturedChild = null;
    const spawner = {
      wake: vi.fn(async ({ sessionId, onChild }) => {
        const child = { pid: 7, on: () => {}, kill: () => {} };
        onChild?.(child);
        capturedChild = child;
        return { sessionId, exitCode: 0, isNew: true };
      }),
    };
    // Capture the running entry's child mid-wake via a spy on the snapshot.
    const { waker, advanceTurn } = makeWaker({ spawner });
    const resolved = await waker.keyFor(TASK_NOTIF);
    await waker.wake(TASK_NOTIF, resolved.key, resolved);
    // The child was handed to onChild (子3 path intact) AND the turn advanced (子1).
    expect(capturedChild).not.toBeNull();
    expect(advanceTurn.mock.calls.map((c) => c[0].status)).toEqual(["running", "ended"]);
  });

  it("a throwing turn reporter never crashes the wake (logged + swallowed)", async () => {
    const warns = [];
    const { waker } = makeWaker({
      advanceTurn: vi.fn(async () => {
        throw new Error("reporter boom");
      }),
      logger: { ...silent, warn: (m) => warns.push(m) },
    });
    const resolved = await waker.keyFor(TASK_NOTIF);
    await expect(waker.wake(TASK_NOTIF, resolved.key, resolved)).resolves.toBeUndefined();
    expect(warns.join("")).toMatch(/advanceTurn failed/);
  });

  it("defaults to a no-op-with-log reporter when none is injected (existing Wakers keep working)", async () => {
    const infos = [];
    // Build a Waker WITHOUT advanceTurn — the default no-op-with-log must be used.
    const waker = new Waker({
      creds: { url: "https://c", apiKey: "cho_x" },
      lineage: { resolve: async () => ({ rootIdeaUuid: ROOT_IDEA, directIdeaUuid: DIRECT_IDEA }) },
      spawner: spawnerThatSpawns(0),
      cwd: "/work/dir",
      logger: { ...silent, info: (m) => infos.push(m) },
      writeMcpConfigFn: vi.fn(() => ({ path: "/tmp/m.json", cleanup: vi.fn() })),
      isNewSessionFn: vi.fn(() => true),
    });
    const resolved = await waker.keyFor(TASK_NOTIF);
    await expect(waker.wake(TASK_NOTIF, resolved.key, resolved)).resolves.toBeUndefined();
    expect(infos.join("")).toMatch(/no turn reporter wired/);
  });
});
