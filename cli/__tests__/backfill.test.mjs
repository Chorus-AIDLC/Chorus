// cli/__tests__/backfill.test.mjs
// Covers cli-daemon spec "Reconnect with backfill" — missed dispatch recovered.
import { describe, it, expect, vi } from "vitest";
import { createBackfill } from "../backfill.mjs";
import { EventRouter } from "../event-router.mjs";
import { WAKE_ACTIONS } from "../prompts.mjs";

const silent = { info() {}, warn() {}, error() {} };

describe("createBackfill", () => {
  it("re-dispatches unread notifications missed during the gap", async () => {
    const dispatched = [];
    const mcpClient = {
      callTool: vi.fn(async () => ({
        notifications: [{ uuid: "n1" }, { uuid: "n2" }],
      })),
    };
    const backfill = createBackfill({
      mcpClient,
      dispatch: (e) => dispatched.push(e),
      logger: silent,
    });

    await backfill();

    expect(mcpClient.callTool).toHaveBeenCalledWith("chorus_get_notifications", {
      status: "unread",
      limit: 50,
      autoMarkRead: false,
    });
    expect(dispatched).toEqual([
      { type: "new_notification", notificationUuid: "n1" },
      { type: "new_notification", notificationUuid: "n2" },
    ]);
  });

  it("skips uuids already in the shared seen set, dispatches the rest (pre-check only, does NOT mark)", async () => {
    const dispatched = [];
    const seen = new Set(["n1"]); // n1 already handled by the live path
    const mcpClient = {
      callTool: vi.fn(async () => ({ notifications: [{ uuid: "n1" }, { uuid: "n2" }] })),
    };
    const backfill = createBackfill({ mcpClient, dispatch: (e) => dispatched.push(e), seen, logger: silent });

    await backfill();

    // n1 skipped (already seen), n2 dispatched.
    expect(dispatched).toEqual([{ type: "new_notification", notificationUuid: "n2" }]);
    // backfill MUST NOT mark seen itself — that's the router's job. If it did,
    // the router's dispatch would early-return and the wake would be lost.
    expect(seen.has("n2")).toBe(false);
  });

  it("does not throw if the fetch fails", async () => {
    const mcpClient = { callTool: vi.fn(async () => { throw new Error("boom"); }) };
    const warns = [];
    const backfill = createBackfill({
      mcpClient,
      dispatch: () => { throw new Error("should not dispatch"); },
      logger: { ...silent, warn: (m) => warns.push(m) },
    });
    await expect(backfill()).resolves.toBeUndefined();
    expect(warns.join("")).toMatch(/backfill fetch failed/);
  });

  it("handles a response with no notifications array", async () => {
    const mcpClient = { callTool: vi.fn(async () => ({})) };
    const dispatched = [];
    const backfill = createBackfill({ mcpClient, dispatch: (e) => dispatched.push(e), logger: silent });
    await backfill();
    expect(dispatched).toEqual([]);
  });
});

// Integration: real createBackfill → real EventRouter with a SHARED seen set —
// exactly the wiring the daemon uses (daemon.mjs). A prior regression where
// backfill marked `seen` before dispatch caused the router's dedup to early-
// return and drop EVERY backfilled wake; no test wired these two together with
// a shared set, so it slipped through. This is that test.
describe("backfill → router integration (shared seen set)", () => {
  const TASK_NOTIF = {
    uuid: "n1",
    projectUuid: "p1",
    entityType: "task",
    entityUuid: "task-1",
    entityTitle: "t",
    action: "task_assigned",
    message: "",
    actorType: "user",
    actorUuid: "u1",
    actorName: "Alice",
  };

  function wire(notifications) {
    const seen = new Set();
    const enqueued = [];
    const mcpClient = { callTool: vi.fn(async () => ({ notifications })) };
    const waker = { keyFor: vi.fn(async () => "idea:root-1"), wake: vi.fn(async () => {}) };
    const queue = { enqueue: (key, task) => enqueued.push({ key, task }) };
    const router = new EventRouter({ mcpClient, waker, queue, wakeActions: WAKE_ACTIONS, seen, logger: silent });
    const backfill = createBackfill({ mcpClient, dispatch: (e) => router.dispatch(e), seen, logger: silent });
    return { seen, enqueued, router, backfill };
  }

  it("backfill alone DOES wake (the regression: it was dropping everything)", async () => {
    const { enqueued, backfill } = wire([TASK_NOTIF]);
    await backfill();
    await new Promise((r) => setTimeout(r, 0)); // let router's async fetchAndRoute settle
    expect(enqueued).toHaveLength(1);
    expect(enqueued[0].key).toBe("idea:root-1");
  });

  it("live dispatch then backfill of the same uuid wakes exactly once (dedup still holds)", async () => {
    const { enqueued, router, backfill } = wire([TASK_NOTIF]);
    router.dispatch({ type: "new_notification", notificationUuid: "n1" }); // live
    await new Promise((r) => setTimeout(r, 0));
    await backfill(); // reconnect backfill sees n1 already handled → skip
    await new Promise((r) => setTimeout(r, 0));
    expect(enqueued).toHaveLength(1);
  });
});
