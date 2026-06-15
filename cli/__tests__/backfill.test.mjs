// cli/__tests__/backfill.test.mjs
// Covers cli-daemon spec "Reconnect with backfill" — missed dispatch recovered.
import { describe, it, expect, vi } from "vitest";
import { createBackfill } from "../backfill.mjs";

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

  it("de-dupes against already-seen notifications across reconnects", async () => {
    const dispatched = [];
    const seen = new Set();
    const mcpClient = {
      callTool: vi.fn(async () => ({ notifications: [{ uuid: "n1" }, { uuid: "n2" }] })),
    };
    const backfill = createBackfill({ mcpClient, dispatch: (e) => dispatched.push(e), seen, logger: silent });

    await backfill(); // first reconnect: n1, n2
    await backfill(); // second reconnect: same two, already seen → nothing new

    expect(dispatched).toHaveLength(2);
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
