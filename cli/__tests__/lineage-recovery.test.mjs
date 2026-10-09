import { describe, expect, it, vi } from "vitest";
import { EventRouter } from "../event-router.mjs";
import { LineageResolver } from "../lineage.mjs";
import { Waker } from "../waker.mjs";

const attribution = { rootIdeaUuid: "root-idea", directIdeaUuid: "child-idea" };
const notification = {
  uuid: "notification-1", action: "mentioned", entityType: "task", entityUuid: "task-1",
};
const wakeContext = { version: 1, notificationUuid: notification.uuid, notification };
const event = {
  type: "new_notification", notificationUuid: notification.uuid,
  turnUuid: "turn-1", wakeRecoveryProtocol: 1, wakeContext,
};
const pendingTurn = {
  turnUuid: "turn-1", sessionId: "child-idea", trigger: "mentioned",
  wakeRecoveryProtocol: 1, wakeContext,
};

function successResponse(data = attribution) {
  return { ok: true, status: 200, json: async () => ({ success: true, data }) };
}

function harness(fetchImpl) {
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const creds = { url: "https://isolated.invalid", apiKey: "synthetic-key" };
  const lineage = new LineageResolver({ ...creds, fetchImpl, logger });
  const spawner = { wake: vi.fn() };
  const waker = new Waker({ creds, lineage, logger, spawner });
  const queue = { enqueue: vi.fn(() => true) };
  const router = new EventRouter({
    mcpClient: {}, waker, queue, logger, wakeActions: new Set(["mentioned"]),
  });
  return { lineage, waker, queue, router, logger, spawner };
}

const deliveryPaths = [
  { name: "SSE then pending-turn", first: (router) => router.dispatch(event), next: (router) => router.dispatchPendingTurn(pendingTurn) },
  { name: "pending-turn then SSE", first: (router) => router.dispatchPendingTurn(pendingTurn), next: (router) => router.dispatch(event) },
];

const transientFailures = [
  { name: "network rejection", fetch: async () => { throw new Error("transport failure synthetic-secret"); } },
  ...[408, 429, 503].map((status) => ({ name: `HTTP ${status}`, fetch: async () => ({ ok: false, status }) })),
  { name: "invalid JSON", fetch: async () => ({ ok: true, status: 200, json: async () => { throw new Error("synthetic-secret"); } }) },
  { name: "invalid attribution", fetch: async () => successResponse({ rootIdeaUuid: 42 }) },
];

describe.each(deliveryPaths)("real lineage recovery: $name", ({ first, next }) => {
  it.each(transientFailures)("releases ownership after $name and retries with the direct idea", async ({ fetch: failFetch }) => {
    const fetchImpl = vi.fn().mockImplementationOnce(failFetch).mockResolvedValue(successResponse());
    const { lineage, waker, queue, router, logger, spawner } = harness(fetchImpl);

    expect(await first(router)).toEqual({ status: "retryable", reason: "routing_failed" });
    expect(lineage.cache.size).toBe(0);
    expect(router.seen.size).toBe(0);
    expect(router.inFlight.size).toBe(0);
    expect(router.acceptedAliases.size).toBe(0);
    expect(queue.enqueue).not.toHaveBeenCalled();
    expect(waker.executions.size).toBe(0);
    expect(spawner.wake).not.toHaveBeenCalled();
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain("synthetic-secret");

    expect(await next(router)).toEqual({ status: "accepted" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(queue.enqueue).toHaveBeenCalledExactlyOnceWith("idea:child-idea", expect.objectContaining({
      attribution: { key: "idea:child-idea", ...attribution },
      notification: expect.objectContaining({ uuid: notification.uuid, turnUuid: "turn-1" }),
    }));
    expect(waker.executions.get("task:task-1")).toMatchObject({ ...attribution, status: "queued" });
    expect(router.seen).toEqual(new Set([notification.uuid, "turn:turn-1"]));
    expect(router.inFlight.size).toBe(0);
    expect(lineage.cache.get("task:task-1")).toEqual(attribution);

    expect(await first(router)).toEqual({ status: "duplicate" });
    expect(await next(router)).toEqual({ status: "duplicate" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(queue.enqueue).toHaveBeenCalledTimes(1);
  });

  it.each([400, 401, 403, 404, 422])("blocks permanent HTTP %s without accepting or caching it", async (status) => {
    const fetchImpl = vi.fn().mockResolvedValue({ ok: false, status });
    const { lineage, waker, queue, router } = harness(fetchImpl);

    expect(await first(router)).toEqual({ status: "blocked", reason: "routing_failed" });
    expect(await next(router)).toEqual({ status: "blocked", reason: "routing_failed" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(lineage.cache.size).toBe(0);
    expect(router.seen.size).toBe(0);
    expect(router.inFlight.size).toBe(0);
    expect(router.acceptedAliases.size).toBe(0);
    expect(queue.enqueue).not.toHaveBeenCalled();
    expect(waker.executions.size).toBe(0);

    fetchImpl.mockResolvedValue(successResponse());
    expect(await next(router)).toEqual({ status: "accepted" });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(queue.enqueue.mock.calls[0][0]).toBe("idea:child-idea");
  });

  it("accepts and caches genuinely ancestor-free attribution under the entity key", async () => {
    const noAncestor = { rootIdeaUuid: null, directIdeaUuid: null };
    const fetchImpl = vi.fn().mockResolvedValue(successResponse(noAncestor));
    const { lineage, waker, queue, router } = harness(fetchImpl);

    expect(await first(router)).toEqual({ status: "accepted" });
    expect(await next(router)).toEqual({ status: "duplicate" });
    expect(await waker.keyFor(notification)).toEqual({ key: "entity:task:task-1", ...noAncestor });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(lineage.cache.get("task:task-1")).toEqual(noAncestor);
    expect(queue.enqueue).toHaveBeenCalledExactlyOnceWith("entity:task:task-1", expect.objectContaining({
      attribution: { key: "entity:task:task-1", ...noAncestor },
    }));
    expect(router.seen).toEqual(new Set([notification.uuid, "turn:turn-1"]));
  });
});

describe("lineage failure ownership", () => {
  it("settles concurrent notification and pending delivery before allowing recovery", async () => {
    let finishFetch;
    const fetchImpl = vi.fn()
      .mockImplementationOnce(() => new Promise((resolve) => { finishFetch = resolve; }))
      .mockResolvedValue(successResponse());
    const { lineage, queue, router } = harness(fetchImpl);

    const broadcast = router.dispatch(event);
    const recovery = router.dispatchPendingTurn(pendingTurn);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    finishFetch({ ok: false, status: 503 });
    expect(await Promise.all([broadcast, recovery])).toEqual([
      { status: "retryable", reason: "routing_failed" },
      { status: "retryable", reason: "routing_failed" },
    ]);
    expect(router.inFlight.size).toBe(0);
    expect(router.seen.size).toBe(0);
    expect(lineage.cache.size).toBe(0);
    expect(queue.enqueue).not.toHaveBeenCalled();

    expect(await router.dispatch(event)).toEqual({ status: "accepted" });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(queue.enqueue).toHaveBeenCalledTimes(1);
  });
});
