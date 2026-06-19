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

describe("event-router human_instruction threading", () => {
  it("reads instructionText from the already-fetched notification (single fetch) and threads it to wake", async () => {
    const { enqueued, mcpClient, waker, router } = wire([INSTRUCTION_NOTIF]);
    router.dispatch({ type: "new_notification", notificationUuid: "ni-1" });
    await new Promise((res) => setTimeout(res, 0));

    // Exactly ONE fetch (the list it already makes) — no extra round-trip.
    expect(mcpClient.callTool).toHaveBeenCalledTimes(1);
    expect(mcpClient.callTool).toHaveBeenCalledWith("chorus_get_notifications", {
      status: "unread",
      limit: 50,
      autoMarkRead: false,
    });

    // It enqueued the wake; run the enqueued task to drive waker.wake (the queue is a
    // spy that records tasks without auto-running them).
    expect(enqueued).toHaveLength(1);
    await enqueued[0].task();

    // The notification (carrying instructionText) was threaded to wake unchanged.
    expect(waker.wake).toHaveBeenCalledTimes(1);
    const threadedNotif = waker.wake.mock.calls[0][0];
    expect(threadedNotif.instructionText).toBe(
      "Please add a retry with backoff to the uploader.",
    );
    // And buildPrompt over that threaded notification emits the instruction body.
    const prompt = buildPrompt(threadedNotif);
    expect(prompt).toContain("Please add a retry with backoff to the uploader.");
    expect(prompt).toContain("instruction from a human");
  });

  it("skips a human_instruction with no instructionText (no contentless wake), logged", async () => {
    const warns = [];
    const noBody = { ...INSTRUCTION_NOTIF, instructionText: "" };
    const mcpClient = { callTool: vi.fn(async () => ({ notifications: [noBody] })) };
    const enqueued = [];
    const waker = { keyFor: vi.fn(), markQueued: vi.fn(), wake: vi.fn(async () => {}) };
    const router = new EventRouter({
      mcpClient,
      waker,
      queue: { enqueue: (k, t) => enqueued.push({ k, t }) },
      wakeActions: WAKE_ACTIONS,
      seen: new Set(),
      logger: { ...silent, warn: (m) => warns.push(m) },
    });
    router.dispatch({ type: "new_notification", notificationUuid: "ni-1" });
    await new Promise((res) => setTimeout(res, 0));

    expect(waker.wake).not.toHaveBeenCalled();
    expect(enqueued).toHaveLength(0);
    expect(warns.join("")).toMatch(/carries no instructionText/);
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

  it("anchors an ad-hoc (no direct idea) pending turn on the entity key", () => {
    const { enqueued, router } = wirePending();
    const adHocSession = "33333333-3333-4333-8333-333333333333";
    router.dispatchPendingTurn({
      turnUuid: "turn-2",
      sessionId: adHocSession,
      directIdeaUuid: null,
      trigger: "human_instruction",
      promptText: "do the thing",
    });
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].key).toBe(`entity:task:${adHocSession}`);
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
