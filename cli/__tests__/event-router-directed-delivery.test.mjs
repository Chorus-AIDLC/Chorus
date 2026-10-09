// cli/__tests__/event-router-directed-delivery.test.mjs
// Daemon-side directed live delivery for pinned autonomous wakes (T2 —
// fix-pinned-wake-directed-delivery). Covers the two cooperating halves of the Q4 mechanism:
//
//   A. BROADCAST SUPPRESSION (`#fetchAndRoute`): a wake-action notification carrying the
//      transport-only `targetConnectionUuid` / `suppressWake` (stamped by the server on the
//      SSE `new_notification` event) is acted on ONLY when this daemon is the resolved target.
//        - target != my uuid  → suppress (no wake)
//        - target == my uuid  → wake
//        - no target, not suppressed (un-pinned) → wake online-first, BYTE-IDENTICAL to before
//        - suppressWake === true (OFFLINE-PIN) → suppress on EVERY connection (Q2 notify-only)
//        - pre-handshake (my uuid still null) + a targeted wake → "not mine" → suppress
//
//   C/D. DIRECTED-TURN RE-DISPATCH + DEDUP (`dispatchPendingTurn`): a `deliver_turn` for a
//      `mentioned`/`task_assigned`/`elaboration_verified` pending turn (promptText=null) is
//      re-dispatched with its autonomous prompt rebuilt from the re-read notification, and
//      dedups against the broadcast copy so the target wakes exactly ONCE.
//
// The router is exercised through its public API (`dispatch` / `dispatchPendingTurn`) with
// stub mcp/waker/queue, matching the existing event-router test style.
import { describe, it, expect, vi } from "vitest";
import { EventRouter } from "../event-router.mjs";
import { WAKE_ACTIONS } from "../prompts.mjs";

const silent = { info() {}, warn() {}, error() {} };

const DIRECT_IDEA = "11111111-1111-4111-8111-111111111111";
const MY_CONN = "conn-self-mine";
const OTHER_CONN = "conn-other-instance";

/** A mentioned wake notification on the idea (the dominant pinned-autonomous case). */
function mentionNotif(overrides = {}) {
  return {
    uuid: "ni-mention",
    projectUuid: "proj-1",
    entityType: "idea",
    entityUuid: DIRECT_IDEA,
    entityTitle: "My idea",
    action: "mentioned",
    message: "take a look please",
    actorType: "user",
    actorUuid: "user-1",
    actorName: "Alice",
    ...overrides,
  };
}

/**
 * Wire a router with a stub mcp returning `notifications`, a waker that records wakes, and a
 * self-identity getter. `getConnectionUuid` defaults to "I am MY_CONN".
 */
function wire(notifications, { getConnectionUuid = () => MY_CONN, seen = new Set() } = {}) {
  const enqueued = [];
  const mcpClient = { callTool: vi.fn(async () => ({ notifications })) };
  const waker = {
    keyFor: vi.fn(async () => ({
      key: `idea:${DIRECT_IDEA}`,
      rootIdeaUuid: DIRECT_IDEA,
      directIdeaUuid: DIRECT_IDEA,
    })),
    markQueued: vi.fn(),
    wake: vi.fn(async () => {}),
  };
  const queue = { enqueue: (key, task) => enqueued.push({ key, task }) };
  const router = new EventRouter({
    mcpClient,
    waker,
    queue,
    wakeActions: WAKE_ACTIONS,
    seen,
    getConnectionUuid,
    logger: silent,
  });
  return { seen, enqueued, mcpClient, waker, router };
}

const flush = () => new Promise((res) => setTimeout(res, 0));

// ===== A. broadcast suppression =====
describe("event-router — directed-wake broadcast suppression (#fetchAndRoute)", () => {
  it("AC-1a: a wake whose targetConnectionUuid != this daemon's uuid is SUPPRESSED (no wake)", async () => {
    const { enqueued, waker, router } = wire([mentionNotif()], { getConnectionUuid: () => MY_CONN });
    router.dispatch({
      type: "new_notification",
      notificationUuid: "ni-mention",
      targetConnectionUuid: OTHER_CONN, // directed at a DIFFERENT instance
      suppressWake: false,
    });
    await flush();

    expect(enqueued).toHaveLength(0);
    expect(waker.keyFor).not.toHaveBeenCalled();
    expect(waker.wake).not.toHaveBeenCalled();
  });

  it("AC-1a: logs the suppression reason (no silent drop)", async () => {
    const infos = [];
    const mcpClient = { callTool: vi.fn(async () => ({ notifications: [mentionNotif()] })) };
    const enqueued = [];
    const router = new EventRouter({
      mcpClient,
      waker: { keyFor: vi.fn(), markQueued: vi.fn(), wake: vi.fn(async () => {}) },
      queue: { enqueue: (k, t) => enqueued.push({ k, t }) },
      wakeActions: WAKE_ACTIONS,
      seen: new Set(),
      getConnectionUuid: () => MY_CONN,
      logger: { ...silent, info: (m) => infos.push(m) },
    });
    router.dispatch({
      type: "new_notification",
      notificationUuid: "ni-mention",
      targetConnectionUuid: OTHER_CONN,
    });
    await flush();

    expect(enqueued).toHaveLength(0);
    expect(infos.join("")).toMatch(/directed to connection .* not this daemon/i);
  });

  it("AC-1b: a wake whose targetConnectionUuid == this daemon's uuid WAKES (exactly once)", async () => {
    const { enqueued, waker, router } = wire([mentionNotif()], { getConnectionUuid: () => MY_CONN });
    router.dispatch({
      type: "new_notification",
      notificationUuid: "ni-mention",
      targetConnectionUuid: MY_CONN, // directed at THIS instance
    });
    await flush();

    expect(waker.keyFor).toHaveBeenCalledTimes(1);
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].key).toBe(`idea:${DIRECT_IDEA}`);
    expect(waker.markQueued).toHaveBeenCalledTimes(1);
  });

  it("AC-2: a wake with NO target (un-pinned) WAKES exactly as before — byte-identical to the legacy path", async () => {
    // Reference: the same router with NO transport fields at all (legacy event shape).
    const legacy = wire([mentionNotif()], { getConnectionUuid: () => MY_CONN });
    legacy.router.dispatch({ type: "new_notification", notificationUuid: "ni-mention" });
    await flush();

    // Subject: an explicit { targetConnectionUuid: null, suppressWake: false } event.
    const subject = wire([mentionNotif()], { getConnectionUuid: () => MY_CONN });
    subject.router.dispatch({
      type: "new_notification",
      notificationUuid: "ni-mention",
      targetConnectionUuid: null,
      suppressWake: false,
    });
    await flush();

    // Both wake once, on the same key, via the same waker calls — byte-identical behavior.
    expect(legacy.enqueued).toHaveLength(1);
    expect(subject.enqueued).toHaveLength(1);
    expect(subject.enqueued[0].key).toBe(legacy.enqueued[0].key);
    expect(subject.waker.keyFor).toHaveBeenCalledTimes(1);
    expect(legacy.waker.keyFor).toHaveBeenCalledTimes(1);
    // The notification object passed to markQueued is the same shape on both paths.
    expect(subject.waker.markQueued.mock.calls[0][0]).toEqual(
      legacy.waker.markQueued.mock.calls[0][0]
    );
  });

  it("AC-2: an un-pinned wake captures the connection generation without suppressing", async () => {
    const getConnectionUuid = vi.fn(() => MY_CONN);
    const { enqueued, router } = wire([mentionNotif()], { getConnectionUuid });
    router.dispatch({ type: "new_notification", notificationUuid: "ni-mention" });
    await flush();

    expect(enqueued).toHaveLength(1);
    expect(getConnectionUuid).toHaveBeenCalled();
  });

  it("AC-3: before the handshake assigns a connection uuid, a TARGETED wake is treated as 'not mine' → suppressed", async () => {
    const { enqueued, waker, router } = wire([mentionNotif()], {
      getConnectionUuid: () => null, // handshake incomplete
    });
    router.dispatch({
      type: "new_notification",
      notificationUuid: "ni-mention",
      targetConnectionUuid: MY_CONN, // even if it WOULD be mine, we can't prove it yet
    });
    await flush();

    expect(enqueued).toHaveLength(0);
    expect(waker.wake).not.toHaveBeenCalled();
  });

  it("AC-3: pre-handshake does NOT suppress an UN-PINNED wake (no target → online-first still works)", async () => {
    const { enqueued, router } = wire([mentionNotif()], { getConnectionUuid: () => null });
    router.dispatch({ type: "new_notification", notificationUuid: "ni-mention" });
    await flush();

    expect(enqueued).toHaveLength(1); // un-pinned wake is unaffected by the missing self-uuid
  });

  it("offline-pin: suppressWake===true suppresses on EVERY connection even when this is online (NOT re-woken as un-pinned)", async () => {
    const infos = [];
    const mcpClient = { callTool: vi.fn(async () => ({ notifications: [mentionNotif()] })) };
    const enqueued = [];
    const router = new EventRouter({
      mcpClient,
      waker: { keyFor: vi.fn(), markQueued: vi.fn(), wake: vi.fn(async () => {}) },
      queue: { enqueue: (k, t) => enqueued.push({ k, t }) },
      wakeActions: WAKE_ACTIONS,
      seen: new Set(),
      getConnectionUuid: () => MY_CONN, // this daemon IS online
      logger: { ...silent, info: (m) => infos.push(m) },
    });
    router.dispatch({
      type: "new_notification",
      notificationUuid: "ni-mention",
      targetConnectionUuid: null, // looks like un-pinned at the target level…
      suppressWake: true, // …but the offline-pin marker forbids any wake
    });
    await flush();

    expect(enqueued).toHaveLength(0); // NOT woken — this is the offline-pin-vs-un-pinned fix
    expect(infos.join("")).toMatch(/OFFLINE-PIN|notify-only/i);
  });

  it("a directed wake for a DIFFERENT action (task_assigned) suppresses on a non-target daemon too", async () => {
    const taskNotif = mentionNotif({
      uuid: "ni-task",
      entityType: "task",
      entityUuid: "task-xyz",
      action: "task_assigned",
    });
    const { enqueued, router } = wire([taskNotif], { getConnectionUuid: () => MY_CONN });
    router.dispatch({
      type: "new_notification",
      notificationUuid: "ni-task",
      targetConnectionUuid: OTHER_CONN,
    });
    await flush();
    expect(enqueued).toHaveLength(0);
  });

  it("a non-wake action is still ignored regardless of target stamping", async () => {
    const noise = mentionNotif({ uuid: "ni-noise", action: "comment_added" });
    const { enqueued, router } = wire([noise], { getConnectionUuid: () => MY_CONN });
    router.dispatch({
      type: "new_notification",
      notificationUuid: "ni-noise",
      targetConnectionUuid: MY_CONN,
    });
    await flush();
    expect(enqueued).toHaveLength(0);
  });
});

function precise(notification = mentionNotif(), overrides = {}) {
  return {
    turnUuid: "turn-m1", sessionId: DIRECT_IDEA, directIdeaUuid: DIRECT_IDEA,
    trigger: notification.action, promptText: null,
    wakeContext: { version: 1, notificationUuid: notification.uuid, notification },
    ...overrides,
  };
}

function broadcast(pending = precise()) {
  return { type: "new_notification", notificationUuid: pending.wakeContext.notificationUuid,
    turnUuid: pending.turnUuid, wakeContext: pending.wakeContext, targetConnectionUuid: MY_CONN };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((accept, fail) => { resolve = accept; reject = fail; });
  return { promise, resolve, reject };
}

describe("event-router exact durable identity", () => {
  it.each(["mentioned", "task_assigned", "elaboration_verified", "start_development", "yolo_requested"])(
    "reconstructs %s without unread notification lookup", async (action) => {
      const { router, enqueued, mcpClient, seen } = wire([]);
      const pending = precise(mentionNotif({ action, entityType: "task", entityUuid: "child-task" }));
      expect(await router.dispatchPendingTurn(pending)).toEqual({ status: "accepted" });
      expect(mcpClient.callTool).not.toHaveBeenCalled();
      expect(enqueued[0].task.notification).toMatchObject({
        action, turnUuid: "turn-m1", uuid: "ni-mention", entityUuid: "child-task",
        wakeRecoveryProtocol: 1, message: "take a look please", admissionUuid: expect.any(String),
      });
      expect([...seen].sort()).toEqual(["ni-mention", "turn:turn-m1"]);
    },
  );

  it.each([true, false])("dedups concurrent dual-route delivery, notificationFirst=%s", async (notificationFirst) => {
    const { router, enqueued, waker } = wire([]);
    const gate = deferred();
    waker.keyFor.mockReturnValueOnce(gate.promise);
    const first = notificationFirst ? router.dispatch(broadcast()) : router.dispatchPendingTurn(precise());
    const second = notificationFirst ? router.dispatchPendingTurn(precise()) : router.dispatch(broadcast());
    expect(router.inFlight.size).toBe(2);
    expect(router.seen.size).toBe(0);
    gate.resolve({ key: "idea:" + DIRECT_IDEA, rootIdeaUuid: DIRECT_IDEA, directIdeaUuid: DIRECT_IDEA });
    expect(await first).toEqual({ status: "accepted" });
    expect(await second).toEqual({ status: "duplicate" });
    expect(await router.dispatchPendingTurn(precise())).toEqual({ status: "duplicate" });
    expect(enqueued).toHaveLength(1);
    expect(waker.keyFor).toHaveBeenCalledTimes(1);
  });

  it("releases both aliases after failed concurrent routing and retries exactly once", async () => {
    const { router, enqueued, waker } = wire([]);
    const gate = deferred();
    waker.keyFor.mockReturnValueOnce(gate.promise);
    const first = router.dispatch(broadcast());
    const second = router.dispatchPendingTurn(precise());
    gate.reject(new Error("synthetic network failure"));
    expect((await first).status).toBe("retryable");
    expect((await second).status).toBe("retryable");
    expect(router.seen.size).toBe(0);
    expect(router.inFlight.size).toBe(0);
    expect((await router.dispatchPendingTurn(precise())).status).toBe("accepted");
    expect(enqueued).toHaveLength(1);
  });

  it.each([0, 1, 2])("blocks legacy pending turns with %s unread candidates without guessing", async (count) => {
    const { router, enqueued, mcpClient } = wire(Array.from({ length: count }, () => mentionNotif()));
    const pending = precise();
    delete pending.wakeContext;
    expect(await router.dispatchPendingTurn(pending)).toEqual({ status: "blocked", reason: "missing_wake_context" });
    expect(router.seen.size).toBe(0);
    expect(enqueued).toHaveLength(0);
    expect(mcpClient.callTool).not.toHaveBeenCalled();
  });

  it("retains the explicit legacy event path and retries a failed lookup", async () => {
    const { router, enqueued, mcpClient } = wire([mentionNotif()]);
    mcpClient.callTool.mockRejectedValueOnce(new Error("synthetic failure"));
    const event = { type: "new_notification", notificationUuid: "ni-mention" };
    expect((await router.dispatch(event)).status).toBe("retryable");
    expect(router.seen.size).toBe(0);
    expect((await router.dispatch(event)).status).toBe("accepted");
    expect(enqueued).toHaveLength(1);
  });

  it.each(["version", "notification", "trigger", "uuid"])("blocks invalid %s context", async (field) => {
    const { router, enqueued } = wire([]);
    const pending = precise();
    if (field === "version") pending.wakeContext.version = 2;
    if (field === "notification") pending.wakeContext.notification = null;
    if (field === "trigger") pending.trigger = "task_assigned";
    if (field === "uuid") pending.wakeContext.notificationUuid = "unrelated-notification";
    expect((await router.dispatchPendingTurn(pending)).status).toBe("blocked");
    expect(enqueued).toHaveLength(0);
    expect(router.seen.size).toBe(0);
  });

  it("never downgrades an unsupported protocol to legacy routing", async () => {
    const { router, mcpClient, enqueued } = wire([mentionNotif()]);
    expect((await router.dispatch({ type: "new_notification", notificationUuid: "ni-mention", wakeRecoveryProtocol: 2 })).status).toBe("blocked");
    expect((await router.dispatchPendingTurn({ ...precise(), wakeRecoveryProtocol: 2 })).status).toBe("blocked");
    expect(mcpClient.callTool).not.toHaveBeenCalled();
    expect(enqueued).toHaveLength(0);
  });

  it.each(["stop", "invalidate", "abort", "connection"])("drops late key resolution after %s", async (boundary) => {
    let connection = MY_CONN;
    const { router, waker, enqueued } = wire([], { getConnectionUuid: () => connection });
    const controller = new AbortController();
    const gate = deferred();
    waker.keyFor.mockReturnValueOnce(gate.promise);
    const result = router.dispatch(broadcast(), { signal: controller.signal });
    if (boundary === "connection") connection = OTHER_CONN;
    else if (boundary === "abort") controller.abort();
    else router[boundary]();
    if (boundary === "abort") expect((await result).status).toBe("retryable");
    gate.resolve({ key: "idea:" + DIRECT_IDEA });
    expect((await result).status).not.toBe("accepted");
    await flush();
    expect(enqueued).toHaveLength(0);
    expect(router.seen.size).toBe(0);
  });

  it("drops late MCP reads after abort and releases ownership before they complete", async () => {
    const { router, enqueued, mcpClient } = wire([mentionNotif()]);
    const controller = new AbortController();
    const gate = deferred();
    mcpClient.callTool.mockReturnValueOnce(gate.promise);
    const event = { type: "new_notification", notificationUuid: "ni-mention" };
    const result = router.dispatch(event, { signal: controller.signal });
    controller.abort();
    expect((await result).status).toBe("retryable");
    expect(router.inFlight.size).toBe(0);
    expect((await router.dispatch(event)).status).toBe("accepted");
    gate.resolve({ notifications: [mentionNotif()] });
    await flush();
    expect(enqueued).toHaveLength(1);
  });

  it("does not count queue refusal or throw as accepted", async () => {
    const { router, enqueued } = wire([]);
    const enqueue = router.queue.enqueue;
    router.queue.enqueue = () => false;
    expect((await router.dispatchPendingTurn(precise())).status).toBe("retryable");
    expect(router.seen.size).toBe(0);
    router.queue.enqueue = () => { throw new Error("queue unavailable"); };
    expect((await router.dispatchPendingTurn(precise())).status).toBe("retryable");
    expect(router.seen.size).toBe(0);
    router.queue.enqueue = enqueue;
    expect((await router.dispatchPendingTurn(precise())).status).toBe("accepted");
    expect(enqueued).toHaveLength(1);
  });

  it("preserves target, suppression and runtime cwd on pending recovery", async () => {
    const { router, enqueued } = wire([]);
    expect((await router.dispatchPendingTurn(precise(mentionNotif(), { targetConnectionUuid: OTHER_CONN }))).status).toBe("ignored");
    expect((await router.dispatchPendingTurn(precise(mentionNotif(), { suppressWake: true }))).status).toBe("ignored");
    expect(router.seen.size).toBe(0);
    expect((await router.dispatchPendingTurn(precise(mentionNotif(), {
      targetConnectionUuid: MY_CONN, runtimeCwd: "/isolated/workspace",
    }))).status).toBe("accepted");
    expect(enqueued[0].task.notification).toMatchObject({ targetConnectionUuid: MY_CONN, runtimeCwd: "/isolated/workspace" });
  });
});
