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

  it("AC-2: an un-pinned wake does NOT consult the self-identity getter (no targeting at all)", async () => {
    const getConnectionUuid = vi.fn(() => MY_CONN);
    const { enqueued, router } = wire([mentionNotif()], { getConnectionUuid });
    router.dispatch({ type: "new_notification", notificationUuid: "ni-mention" });
    await flush();

    expect(enqueued).toHaveLength(1);
    expect(getConnectionUuid).not.toHaveBeenCalled(); // no target → no comparison
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

// ===== C/D. directed autonomous pending-turn re-dispatch + dedup =====
describe("event-router — directed autonomous pending-turn re-dispatch (dispatchPendingTurn)", () => {
  /**
   * Wire a router for the pending-turn path: the mcp re-read returns `notifications`, used to
   * rebuild the autonomous prompt + dedup. Reuses a SHARED seen set so the broadcast and the
   * deliver_turn delivery collapse.
   */
  function wirePending(notifications, { seen = new Set() } = {}) {
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
      getConnectionUuid: () => MY_CONN,
      logger: silent,
    });
    return { seen, enqueued, mcpClient, waker, router };
  }

  const pendingMention = {
    turnUuid: "turn-m1",
    sessionId: DIRECT_IDEA,
    directIdeaUuid: DIRECT_IDEA,
    trigger: "mentioned",
    promptText: null, // autonomous turns carry NO canonical text — rebuilt from the notification
  };

  it("AC-4: re-dispatches a `mentioned` pending turn, rebuilding the prompt from the re-read notification (promptText is null)", async () => {
    const { enqueued, mcpClient, waker, router } = wirePending([mentionNotif()]);
    router.dispatchPendingTurn(pendingMention);
    await flush();

    // It re-read the notifications to rebuild the autonomous prompt context.
    expect(mcpClient.callTool).toHaveBeenCalledWith(
      "chorus_get_notifications",
      expect.objectContaining({ status: "unread" })
    );
    // Woke via the FULL notification (so buildPrompt has entityTitle/actorName/message),
    // enqueued on the same session lane.
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].key).toBe(`idea:${DIRECT_IDEA}`);
    const [n] = waker.markQueued.mock.calls[0];
    expect(n.action).toBe("mentioned");
    expect(n.entityUuid).toBe(DIRECT_IDEA);
    expect(n.entityTitle).toBe("My idea"); // rebuilt context, not a null-prompt turn
  });

  it("AC-4: re-dispatches a `task_assigned` pending turn (matched by entityUuid===sessionId)", async () => {
    const taskNotif = mentionNotif({
      uuid: "ni-task",
      entityType: "task",
      entityUuid: "task-xyz",
      action: "task_assigned",
    });
    const { enqueued, waker, router } = wirePending([taskNotif]);
    router.dispatchPendingTurn({
      turnUuid: "turn-t1",
      sessionId: "task-xyz", // ad-hoc / task-anchored: sessionId === the task entity uuid
      directIdeaUuid: null,
      trigger: "task_assigned",
      promptText: null,
    });
    await flush();

    expect(enqueued).toHaveLength(1);
    const [n] = waker.markQueued.mock.calls[0];
    expect(n.action).toBe("task_assigned");
    expect(n.entityUuid).toBe("task-xyz");
  });

  it("AC-4: re-dispatches an `elaboration_verified` pending turn (matched by trigger + idea anchor)", async () => {
    const verifyNotif = mentionNotif({
      uuid: "ni-verify",
      action: "elaboration_verified",
    });
    const { enqueued, waker, router } = wirePending([verifyNotif]);
    router.dispatchPendingTurn({
      turnUuid: "turn-v1",
      sessionId: DIRECT_IDEA,
      directIdeaUuid: DIRECT_IDEA,
      trigger: "elaboration_verified",
      promptText: null,
    });
    await flush();

    expect(enqueued).toHaveLength(1);
    const [n] = waker.markQueued.mock.calls[0];
    expect(n.action).toBe("elaboration_verified");
  });

  it("AC-4b: re-dispatches a `start_development` pending turn (matched by trigger + idea anchor)", async () => {
    const startDevNotif = mentionNotif({
      uuid: "ni-start-dev",
      action: "start_development",
    });
    const { enqueued, waker, router } = wirePending([startDevNotif]);
    router.dispatchPendingTurn({
      turnUuid: "turn-sd1",
      sessionId: DIRECT_IDEA,
      directIdeaUuid: DIRECT_IDEA,
      trigger: "start_development",
      promptText: null,
    });
    await flush();

    expect(enqueued).toHaveLength(1);
    const [n] = waker.markQueued.mock.calls[0];
    expect(n.action).toBe("start_development");
  });

  it("AC-4 DEDUP: the broadcast copy (target==me) then the deliver_turn delivery collapse to ONE wake", async () => {
    const seen = new Set();
    const { enqueued, waker, router } = wirePending([mentionNotif()], { seen });

    // Route 1: the target's broadcast copy wakes (target === me) and marks the notification seen.
    router.dispatch({
      type: "new_notification",
      notificationUuid: "ni-mention",
      targetConnectionUuid: MY_CONN,
    });
    await flush();
    expect(enqueued).toHaveLength(1);

    // Route 2: the deliver_turn → pending re-dispatch for the SAME logical wake. It re-reads
    // the notification, finds it already `seen`, and dedups away — no second wake.
    router.dispatchPendingTurn(pendingMention);
    await flush();

    expect(enqueued).toHaveLength(1); // still exactly ONE wake
    expect(waker.wake).not.toHaveBeenCalled(); // wakes run on the queue, not invoked here
    expect(seen.has("ni-mention")).toBe(true);
    expect(seen.has("turn:turn-m1")).toBe(true);
  });

  it("AC-4 DEDUP: the deliver_turn delivery FIRST then the broadcast copy collapse to ONE wake", async () => {
    const seen = new Set();
    const { enqueued, router } = wirePending([mentionNotif()], { seen });

    // Route 2 first: the deliver_turn → pending re-dispatch wakes and claims the broadcast key.
    router.dispatchPendingTurn(pendingMention);
    await flush();
    expect(enqueued).toHaveLength(1);
    expect(seen.has("ni-mention")).toBe(true); // claimed the broadcast's key

    // Route 1: the broadcast copy arrives — `dispatch` sees the notificationUuid already
    // marked and drops it (no second wake).
    router.dispatch({
      type: "new_notification",
      notificationUuid: "ni-mention",
      targetConnectionUuid: MY_CONN,
    });
    await flush();

    expect(enqueued).toHaveLength(1); // still exactly ONE wake
  });

  it("dedups a re-delivered pending turn against itself (turn:{uuid} key), single wake", async () => {
    const seen = new Set();
    const { enqueued, router } = wirePending([mentionNotif()], { seen });
    router.dispatchPendingTurn(pendingMention);
    router.dispatchPendingTurn(pendingMention); // same turn delivered twice
    await flush();
    expect(enqueued).toHaveLength(1);
    expect(seen.has("turn:turn-m1")).toBe(true);
  });

  it("missed-broadcast recovery: a lineage-anchored task_assigned (entityUuid != sessionId) is recovered as the single unread candidate", async () => {
    // The wake notification's entity is the TASK, but the turn's session anchors on the
    // lineage idea — so anchor equality cannot match without a lineage round-trip. With a
    // single unread task_assigned candidate it is unambiguously this turn's wake.
    const taskNotif = mentionNotif({
      uuid: "ni-task-lineage",
      entityType: "task",
      entityUuid: "task-child", // NOT the session anchor
      action: "task_assigned",
    });
    const { enqueued, waker, router } = wirePending([taskNotif]);
    router.dispatchPendingTurn({
      turnUuid: "turn-tl",
      sessionId: DIRECT_IDEA, // the lineage idea, != the task entityUuid
      directIdeaUuid: DIRECT_IDEA,
      trigger: "task_assigned",
      promptText: null,
    });
    await flush();

    expect(enqueued).toHaveLength(1);
    const [n] = waker.markQueued.mock.calls[0];
    expect(n.uuid).toBe("ni-task-lineage");
    expect(n.action).toBe("task_assigned");
  });

  it("cross-cwd mention: matched by the idea prefix of a composite sessionId `${idea}::${conn}`", async () => {
    const { enqueued, waker, router } = wirePending([mentionNotif()]);
    router.dispatchPendingTurn({
      turnUuid: "turn-xc",
      sessionId: `${DIRECT_IDEA}::conn-strands`, // cross-cwd per-instance session key
      directIdeaUuid: null, // null for a per-instance cross-cwd session
      trigger: "mentioned",
      promptText: null,
    });
    await flush();

    expect(enqueued).toHaveLength(1);
    const [n] = waker.markQueued.mock.calls[0];
    expect(n.uuid).toBe("ni-mention"); // matched the idea-prefixed mention by its entityUuid
  });

  it("ambiguity guard: 2+ unread candidates for the trigger with NO anchor match → defers (no wake), logged", async () => {
    const infos = [];
    const enqueued = [];
    // Two unread mentions, NEITHER anchored on the turn's session → cannot disambiguate.
    const m1 = mentionNotif({ uuid: "ni-a", entityUuid: "other-1" });
    const m2 = mentionNotif({ uuid: "ni-b", entityUuid: "other-2" });
    const router = new EventRouter({
      mcpClient: { callTool: vi.fn(async () => ({ notifications: [m1, m2] })) },
      waker: { keyFor: vi.fn(), markQueued: vi.fn(), wake: vi.fn(async () => {}) },
      queue: { enqueue: (k, t) => enqueued.push({ k, t }) },
      wakeActions: WAKE_ACTIONS,
      seen: new Set(),
      getConnectionUuid: () => MY_CONN,
      logger: { ...silent, info: (m) => infos.push(m) },
    });
    router.dispatchPendingTurn({
      turnUuid: "turn-amb",
      sessionId: DIRECT_IDEA,
      directIdeaUuid: DIRECT_IDEA,
      trigger: "mentioned",
      promptText: null,
    });
    await flush();

    expect(enqueued).toHaveLength(0); // safe: defer to reconnect backfill rather than guess
    expect(infos.join("")).toMatch(/2 candidate/);
  });

  it("skips (logged) when no matching unread notification exists to rebuild the prompt", async () => {
    const infos = [];
    const enqueued = [];
    const router = new EventRouter({
      mcpClient: { callTool: vi.fn(async () => ({ notifications: [] })) }, // none to match
      waker: { keyFor: vi.fn(), markQueued: vi.fn(), wake: vi.fn(async () => {}) },
      queue: { enqueue: (k, t) => enqueued.push({ k, t }) },
      wakeActions: WAKE_ACTIONS,
      seen: new Set(),
      getConnectionUuid: () => MY_CONN,
      logger: { ...silent, info: (m) => infos.push(m) },
    });
    router.dispatchPendingTurn(pendingMention);
    await flush();
    expect(enqueued).toHaveLength(0);
    expect(infos.join("")).toMatch(/no unambiguous unread wake notification.*0 candidate/i);
  });

  it("a `human_instruction` pending turn is UNCHANGED — still re-derived from the turn's own promptText (not the notification re-read)", () => {
    const { enqueued, mcpClient, waker, router } = wirePending([]);
    router.dispatchPendingTurn({
      turnUuid: "turn-hi",
      sessionId: DIRECT_IDEA,
      directIdeaUuid: DIRECT_IDEA,
      trigger: "human_instruction",
      promptText: "Resume the deploy.",
    });
    // human_instruction is synchronous + does NOT re-read notifications.
    expect(mcpClient.callTool).not.toHaveBeenCalled();
    expect(enqueued).toHaveLength(1);
    const [n] = waker.markQueued.mock.calls[0];
    expect(n.action).toBe("human_instruction");
    expect(n.instructionText).toBe("Resume the deploy.");
  });

  it("the router stays non-throwing when the notification re-read rejects (logged, no crash)", async () => {
    const warns = [];
    const enqueued = [];
    const router = new EventRouter({
      mcpClient: { callTool: vi.fn(async () => { throw new Error("network down"); }) },
      waker: { keyFor: vi.fn(), markQueued: vi.fn(), wake: vi.fn(async () => {}) },
      queue: { enqueue: (k, t) => enqueued.push({ k, t }) },
      wakeActions: WAKE_ACTIONS,
      seen: new Set(),
      getConnectionUuid: () => MY_CONN,
      logger: { ...silent, warn: (m) => warns.push(m) },
    });
    expect(() => router.dispatchPendingTurn(pendingMention)).not.toThrow();
    await flush();
    expect(enqueued).toHaveLength(0);
    expect(warns.join("")).toMatch(/re-read failed/i);
  });
});
