import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDeliveryRecovery } from "../delivery-recovery.mjs";
import { createBackfill } from "../backfill.mjs";
import { deliveryError, deliveryRequest } from "../delivery-request.mjs";

const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
const event = { type: "new_notification", notificationUuid: "notification", targetConnectionUuid: "connection", runtimeCwd: "/project" };

function wire() {
  const router = { dispatch: vi.fn(async () => ({ status: "accepted" })), invalidate: vi.fn(), stop: vi.fn() };
  const backfill = { pendingTurnsOnly: vi.fn(async () => ({ status: "accepted", outcomes: {} })) };
  const recovery = createDeliveryRecovery({ router, backfill, getConnectionUuid: () => "connection", logger, random: () => 0.5 });
  return { router, backfill, recovery };
}

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(0); vi.clearAllMocks(); });
afterEach(() => vi.useRealTimers());

describe("delivery recovery", () => {
  it("recovers a failed event without reconnecting and preserves its transport fields", async () => {
    const { router, recovery } = wire();
    recovery.register();
    await vi.advanceTimersByTimeAsync(0);
    router.dispatch.mockResolvedValueOnce({ status: "retryable" }).mockResolvedValue({ status: "accepted" });
    await recovery.dispatch(event);
    expect(router.dispatch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(router.dispatch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(router.dispatch).toHaveBeenCalledTimes(2);
    expect(router.dispatch.mock.calls[1][0]).toEqual(event);
    recovery.stop();
  });

  it("retains failures past fast attempts with capped backoff", async () => {
    const { router, recovery } = wire();
    recovery.register();
    await vi.advanceTimersByTimeAsync(0);
    router.dispatch.mockResolvedValue({ status: "retryable" });
    await recovery.dispatch(event);
    for (const delay of [1_000,2_000,4_000,27_000]) await vi.advanceTimersByTimeAsync(delay);
    expect(router.dispatch).toHaveBeenCalledTimes(5);
    router.dispatch.mockResolvedValue({ status: "accepted" });
    await vi.advanceTimersByTimeAsync(27_000);
    expect(router.dispatch).toHaveBeenCalledTimes(6);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(router.dispatch).toHaveBeenCalledTimes(6);
    recovery.stop();
  });

  it("retries a failed targeted read but not a permanent authorization denial", async () => {
    const { backfill, recovery } = wire();
    recovery.register();
    await vi.advanceTimersByTimeAsync(0);
    backfill.pendingTurnsOnly.mockResolvedValueOnce({ status: "retryable" }).mockResolvedValue({ status: "blocked", httpStatus: 403 });
    await recovery.deliver("original-turn");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(backfill.pendingTurnsOnly).toHaveBeenCalledTimes(3);
    expect(backfill.pendingTurnsOnly.mock.calls[2][1].turnUuids).toEqual(["original-turn"]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(backfill.pendingTurnsOnly).toHaveBeenCalledTimes(3);
    recovery.stop();
  });

  it("periodically reconciles protocol work on an otherwise healthy connection", async () => {
    const { backfill, recovery } = wire();
    recovery.register();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(backfill.pendingTurnsOnly).toHaveBeenCalledTimes(2);
    expect(backfill.pendingTurnsOnly.mock.calls[1][1]).toMatchObject({ sweep: true, recoverableOnly: true });
    recovery.stop();
  });

  it("deduplicates repeated pings while a read is in flight", async () => {
    const { backfill, recovery } = wire();
    recovery.register();
    await vi.advanceTimersByTimeAsync(0);
    let finish;
    backfill.pendingTurnsOnly.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const first = recovery.deliver("turn");
    await Promise.resolve();
    recovery.deliver("turn");
    finish({ status: "accepted", outcomes: { turn: { status: "accepted" } } });
    await first;
    await vi.advanceTimersByTimeAsync(0);
    expect(backfill.pendingTurnsOnly).toHaveBeenCalledTimes(2);
    recovery.stop();
  });

  it("stop aborts an in-flight request and removes all scheduled recovery", async () => {
    const { backfill, router, recovery } = wire();
    recovery.register();
    await vi.advanceTimersByTimeAsync(0);
    let signal;
    backfill.pendingTurnsOnly.mockImplementationOnce((unusedTurn,options) => { signal=options.signal; return new Promise(() => {}); });
    const running = recovery.deliver("turn");
    await Promise.resolve();
    recovery.stop();
    await running;
    expect(signal.aborted).toBe(true);
    expect(router.stop).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(120_000);
    expect(backfill.pendingTurnsOnly).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("replacement registration invalidates old asynchronous results", async () => {
    const { backfill, router, recovery } = wire();
    recovery.register();
    await vi.advanceTimersByTimeAsync(0);
    let oldOptions;
    backfill.pendingTurnsOnly.mockImplementationOnce((unusedTurn,options) => { oldOptions=options; return new Promise(() => {}); });
    const running = recovery.deliver("old-turn");
    await Promise.resolve();
    recovery.register();
    await running;
    await vi.advanceTimersByTimeAsync(0);
    expect(oldOptions.signal.aborted).toBe(true);
    expect(oldOptions.shouldDispatch()).toBe(false);
    expect(router.invalidate).toHaveBeenCalledTimes(2);
    recovery.stop();
  });

  it("one stuck notification source does not prevent the pending source", async () => {
    const { backfill, router, recovery } = wire();
    router.dispatch.mockImplementation(() => new Promise(() => {}));
    recovery.dispatch(event);
    recovery.register();
    const running = recovery.dispatch(event);
    await Promise.resolve();
    await Promise.resolve();
    expect(backfill.pendingTurnsOnly).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10_000);
    await running;
    recovery.stop();
  });

  it("keeps two connection coordinators isolated", async () => {
    const first = wire();
    const second = wire();
    first.recovery.register(); second.recovery.register();
    await vi.advanceTimersByTimeAsync(0);
    first.recovery.stop();
    await second.recovery.dispatch(event);
    expect(second.router.dispatch).toHaveBeenCalledTimes(1);
    expect(first.router.dispatch).not.toHaveBeenCalled();
    second.recovery.stop();
  });
});

describe("safe backfill and deadlines", () => {
  it("periodic scans do not infer source identity for historical autonomous turns", async () => {
    const dispatchPendingTurn = vi.fn(async () => ({ status: "accepted" }));
    const backfill=createBackfill({ mcpClient:{callTool:vi.fn()}, dispatch:vi.fn(), url:"https://example.invalid", apiKey:"fake", getConnectionUuid:()=>"connection", dispatchPendingTurn,
      fetchImpl:async()=>({ok:true,status:200,json:async()=>({data:{turns:[{turnUuid:"old",trigger:"mentioned"},{turnUuid:"new",wakeContext:{version:1}}]}})}) });
    await backfill.pendingTurnsOnly(undefined,{recoverableOnly:true});
    expect(dispatchPendingTurn).toHaveBeenCalledTimes(1);
    expect(dispatchPendingTurn.mock.calls[0][0].turnUuid).toBe("new");
  });

  it("times out a hanging operation without waiting for its underlying promise", async () => {
    let signal;
    const request=deliveryRequest(requestSignal=>{signal=requestSignal;return new Promise(()=>{});});
    const assertion=expect(request).rejects.toMatchObject({name:"TimeoutError"});
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
    expect(signal.aborted).toBe(true);
  });

  it("safe diagnostics retain error codes but no arbitrary secret-bearing messages", () => {
    expect(deliveryError(new TypeError("secret token",{cause:{code:"ECONNRESET"}}))).toBe("fetch failed (ECONNRESET)");
    expect(deliveryError(new Error("Authorization: Bearer private"))).toBe("fetch failed");
  });
});
