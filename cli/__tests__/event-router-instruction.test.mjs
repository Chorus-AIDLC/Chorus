// cli/__tests__/event-router-instruction.test.mjs
// Covers the event-router reading instructionText from the already-fetched
// notification (no extra fetch) and threading it to the wake, plus the
// dispatchPendingTurn backfill re-derivation entrypoint (子1 —
// daemon-session-conversation).
import { describe, it, expect, vi } from "vitest";
import { EventRouter } from "../event-router.mjs";
import { WAKE_ACTIONS, buildPrompt } from "../prompts.mjs";

const silent = { info() {}, warn() {}, error() {} };

const DIRECT_IDEA = "11111111-1111-4111-8111-111111111111";

function wire(notifications) {
  const seen = new Set();
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
  const router = new EventRouter({ mcpClient, waker, queue, wakeActions: WAKE_ACTIONS, seen, logger: silent });
  return { seen, enqueued, mcpClient, waker, router };
}

const INSTRUCTION_NOTIF = {
  uuid: "ni-1",
  projectUuid: "proj-1",
  entityType: "idea",
  entityUuid: DIRECT_IDEA,
  entityTitle: "My idea",
  action: "human_instruction",
  message: "",
  actorType: "user",
  actorUuid: "user-1",
  actorName: "Alice",
  instructionText: "Please add a retry with backoff to the uploader.",
};

describe("event-router human_instruction is NOT woken from the notification path", () => {
  // Regression: a human_instruction used to be woken here AND via the deliver_turn /
  // pending-turn paths (keyed turn:{uuid}) → the same instruction ran twice under two
  // different dedup keys. The notification path now defers human_instruction entirely;
  // its live delivery is the origin-only deliver_turn ping and its recovery is the
  // pending-turn backfill.
  it("does NOT enqueue/wake on a human_instruction new_notification (deferred to turn-keyed paths)", async () => {
    const { enqueued, mcpClient, waker, router } = wire([INSTRUCTION_NOTIF]);
    router.dispatch({ type: "new_notification", notificationUuid: "ni-1" });
    await new Promise((res) => setTimeout(res, 0));

    // The list is still fetched (it's the router's normal first step), but the action
    // is recognized as human_instruction and dropped here — no wake, no enqueue.
    expect(mcpClient.callTool).toHaveBeenCalledTimes(1);
    expect(enqueued).toHaveLength(0);
    expect(waker.keyFor).not.toHaveBeenCalled();
    expect(waker.markQueued).not.toHaveBeenCalled();
    expect(waker.wake).not.toHaveBeenCalled();
  });

  it("logs the deferral visibly (no silent drop)", async () => {
    const infos = [];
    const mcpClient = {
      callTool: vi.fn(async () => ({ notifications: [INSTRUCTION_NOTIF] })),
    };
    const enqueued = [];
    const waker = { keyFor: vi.fn(), markQueued: vi.fn(), wake: vi.fn(async () => {}) };
    const router = new EventRouter({
      mcpClient,
      waker,
      queue: { enqueue: (k, t) => enqueued.push({ k, t }) },
      wakeActions: WAKE_ACTIONS,
      seen: new Set(),
      logger: { ...silent, info: (m) => infos.push(m) },
    });
    router.dispatch({ type: "new_notification", notificationUuid: "ni-1" });
    await new Promise((res) => setTimeout(res, 0));

    expect(enqueued).toHaveLength(0);
    expect(infos.join("")).toMatch(/deliver_turn \/ pending-turn backfill/);
  });

  it("buildPrompt still renders the human_instruction body (delivery path unchanged)", () => {
    // The prompt builder is shared by the deliver_turn / pending-turn dispatch, so the
    // instruction body still reaches Claude — this asserts the body wiring is intact
    // even though the NOTIFICATION path no longer wakes it.
    const prompt = buildPrompt(INSTRUCTION_NOTIF);
    expect(prompt).toContain("Please add a retry with backoff to the uploader.");
    expect(prompt).toContain("instruction from a human");
  });
});

describe("event-router dispatchPendingTurn (backfill re-derivation)", () => {
  function wirePending() {
    const seen = new Set();
    const enqueued = [];
    const waker = { markQueued: vi.fn(), wake: vi.fn(async () => {}), keyFor: vi.fn() };
    const queue = { enqueue: (key, task) => enqueued.push({ key, task }) };
    const router = new EventRouter({
      mcpClient: { callTool: vi.fn() },
      waker,
      queue,
      wakeActions: WAKE_ACTIONS,
      seen,
      logger: silent,
    });
    return { seen, enqueued, waker, router };
  }

  it("re-runs a pending human_instruction turn directly from its turn ids (no lineage fetch), anchored on the direct idea", () => {
    const { enqueued, waker, router } = wirePending();
    router.dispatchPendingTurn({
      turnUuid: "turn-1",
      sessionId: DIRECT_IDEA,
      directIdeaUuid: DIRECT_IDEA,
      trigger: "human_instruction",
      promptText: "Resume the deploy and verify health checks.",
    });

    // No lineage call — the key/attribution come straight from the turn ids.
    expect(waker.keyFor).not.toHaveBeenCalled();
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].key).toBe(`idea:${DIRECT_IDEA}`);
    expect(waker.markQueued).toHaveBeenCalledTimes(1);

    // The synthetic notification threads the canonical promptText as instructionText
    // and anchors entityUuid on the session id so the waker session matches.
    const [n, key, attribution] = waker.markQueued.mock.calls[0];
    expect(n.action).toBe("human_instruction");
    expect(n.entityType).toBe("idea");
    expect(n.entityUuid).toBe(DIRECT_IDEA);
    expect(n.instructionText).toBe("Resume the deploy and verify health checks.");
    expect(key).toBe(`idea:${DIRECT_IDEA}`);
    expect(attribution.directIdeaUuid).toBe(DIRECT_IDEA);
  });

  it("anchors an ad-hoc (no direct idea) pending turn on the daemon_session entity key", () => {
    const { enqueued, waker, router } = wirePending();
    const adHocSession = "33333333-3333-4333-8333-333333333333";
    router.dispatchPendingTurn({
      turnUuid: "turn-2",
      sessionId: adHocSession,
      directIdeaUuid: null,
      trigger: "human_instruction",
      promptText: "do the thing",
    });
    expect(enqueued).toHaveLength(1);
    // The serialization lane is keyed on the conversation (daemon_session), and the
    // execution entity reported to the server is daemon_session:<sessionId> — NOT
    // task:<sessionId> (which the server would drop as a non-existent Task).
    expect(enqueued[0].key).toBe(`entity:daemon_session:${adHocSession}`);
    const [n] = waker.markQueued.mock.calls[0];
    expect(n.entityType).toBe("daemon_session");
    expect(n.entityUuid).toBe(adHocSession);
  });

  it("dedupes a pending turn already handled (shared seen set, keyed turn:<uuid>)", () => {
    const { seen, enqueued, router } = wirePending();
    const turn = {
      turnUuid: "turn-3",
      sessionId: DIRECT_IDEA,
      directIdeaUuid: DIRECT_IDEA,
      trigger: "human_instruction",
      promptText: "x",
    };
    router.dispatchPendingTurn(turn);
    router.dispatchPendingTurn(turn); // second time → deduped
    expect(enqueued).toHaveLength(1);
    expect(seen.has("turn:turn-3")).toBe(true);
  });

  it("ignores non-human_instruction triggers (autonomous turns are re-driven by the notification backfill)", () => {
    const { enqueued, router } = wirePending();
    router.dispatchPendingTurn({
      turnUuid: "turn-4",
      sessionId: DIRECT_IDEA,
      directIdeaUuid: DIRECT_IDEA,
      trigger: "task_assigned",
      promptText: null,
    });
    expect(enqueued).toHaveLength(0);
  });

  it("skips a malformed pending turn (missing turnUuid / sessionId / empty promptText), logged", () => {
    const warns = [];
    const seen = new Set();
    const enqueued = [];
    const router = new EventRouter({
      mcpClient: { callTool: vi.fn() },
      waker: { markQueued: vi.fn(), wake: vi.fn() },
      queue: { enqueue: (k, t) => enqueued.push({ k, t }) },
      wakeActions: WAKE_ACTIONS,
      seen,
      logger: { ...silent, warn: (m) => warns.push(m) },
    });
    router.dispatchPendingTurn({ sessionId: DIRECT_IDEA, trigger: "human_instruction", promptText: "x" }); // no turnUuid
    router.dispatchPendingTurn({ turnUuid: "t", trigger: "human_instruction", promptText: "x" }); // no sessionId
    router.dispatchPendingTurn({
      turnUuid: "t2",
      sessionId: DIRECT_IDEA,
      trigger: "human_instruction",
      promptText: "   ",
    }); // blank body
    expect(enqueued).toHaveLength(0);
    expect(warns.length).toBeGreaterThanOrEqual(3);
  });
});
