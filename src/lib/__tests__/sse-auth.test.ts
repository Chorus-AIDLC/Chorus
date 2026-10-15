import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";
import type { UserAuthContext } from "@/types/auth";

const { bus, validate, fallback } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter } = require("node:events") as typeof import("node:events");
  return { bus: new EventEmitter(), validate: vi.fn(), fallback: vi.fn() };
});
vi.mock("@/lib/event-bus", () => ({ eventBus: bus }));
vi.mock("@/lib/auth", () => ({ getAuthContext: fallback }));
vi.mock("@/lib/stream-credentials", async importOriginal => {
  const original = await importOriginal<typeof import("@/lib/stream-credentials")>();
  return { ...original, validateStreamCredential: validate };
});
import { rememberStreamCredential } from "@/lib/stream-credentials";
import { createSseAuthGate } from "@/lib/sse-auth";

const closes: (() => void)[] = [];
async function flush() { for (let i = 0; i < 10; i++) await Promise.resolve(); }
function gate(expiresAt?: number) {
  const auth: UserAuthContext = { type: "user", companyUuid: "company", actorUuid: "human", authType: "local" };
  rememberStreamCredential(auth, { kind: "session", authType: "local", sessionVersion: 3, expiresAt });
  const controller = { enqueue: vi.fn(), close: vi.fn() };
  const cleanup = vi.fn();
  const stream = createSseAuthGate(new NextRequest("http://localhost/api/events"), auth, controller as unknown as ReadableStreamDefaultController<Uint8Array>, cleanup);
  closes.push(stream.close);
  return { ...stream, isClosed: () => stream.closed, controller, cleanup };
}
beforeEach(() => {
  vi.resetAllMocks(); bus.removeAllListeners();
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date", "performance"] });
  validate.mockResolvedValue(true);
});
afterEach(() => { closes.splice(0).forEach(close => close()); vi.useRealTimers(); });

describe("bounded SSE auth leases", () => {
  it("checks registration once, then sends a burst without auth work", async () => {
    const stream = gate(); await flush();
    for (let i = 0; i < 100; i++) await stream.send("data: event\n\n");
    expect(validate).toHaveBeenCalledTimes(1);
    expect(fallback).not.toHaveBeenCalled();
    expect(stream.controller.enqueue).toHaveBeenCalledTimes(100);
  });
  it("only invalidates matching tenant/user identities", async () => {
    const stream = gate(); await flush();
    bus.emit("account_access_changed", { companyUuid: "other", userUuid: "human" });
    bus.emit("account_access_changed", { companyUuid: "company", userUuid: "other" });
    await stream.send("valid");
    expect(validate).toHaveBeenCalledTimes(1);
    validate.mockResolvedValue(false);
    bus.emit("account_access_changed", { companyUuid: "company", userUuid: "human" });
    await stream.send("blocked");
    expect(stream.isClosed()).toBe(true);
    expect(stream.controller.enqueue).toHaveBeenCalledTimes(1);
    expect(stream.cleanup).toHaveBeenCalledTimes(1);
  });
  it("does not miss a change between registration and the first authoritative read", async () => {
    let release!: (valid: boolean) => void;
    validate.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const stream = gate();
    const pending = stream.send("must not leak");
    validate.mockResolvedValue(false);
    bus.emit("account_access_changed", { companyUuid: "company", userUuid: "human" });
    release(true);
    await pending;
    expect(validate).toHaveBeenCalledTimes(2);
    expect(stream.controller.enqueue).not.toHaveBeenCalled();
    expect(stream.isClosed()).toBe(true);
  });
  it.each(["initialization", "renewal"])("does not lose %s invalidation between a successful read and promise finalization", async phase => {
    let stream: ReturnType<typeof gate>;
    if (phase === "renewal") { stream = gate(); await flush(); }
    let release!: (valid: boolean) => void;
    validate.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    if (phase === "initialization") stream = gate();
    else await vi.advanceTimersByTimeAsync(25_000);
    const pending = stream!.send("queued confidential message");
    release(true);
    queueMicrotask(() => {
      validate.mockResolvedValue(false);
      bus.emit("account_access_changed", { companyUuid: "company", userUuid: "human" });
    });
    await pending;
    await stream!.send("post-revocation message");
    expect(stream!.controller.enqueue).not.toHaveBeenCalled();
    expect(validate).toHaveBeenCalledTimes(phase === "initialization" ? 2 : 3);
    expect(stream!.isClosed()).toBe(true);
    expect(bus.listenerCount("account_access_changed")).toBe(0);
  });
  it("stops queued sends while an invalidation read is pending, then drops them on failure", async () => {
    const stream = gate(); await flush();
    let release!: (valid: boolean) => void;
    validate.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    bus.emit("account_access_changed", { companyUuid: "company", userUuid: "human" });
    const queued = [stream.send("first"), stream.send("second")];
    await flush();
    expect(stream.controller.enqueue).not.toHaveBeenCalled();
    release(false);
    await Promise.all(queued);
    expect(stream.controller.enqueue).not.toHaveBeenCalled();
    expect(bus.listenerCount("account_access_changed")).toBe(0);
  });
  it("bounds a lost relay independently for two simulated server connections", async () => {
    const a = gate(), b = gate(); await flush();
    validate.mockResolvedValue(false);
    const listeners = bus.listeners("account_access_changed");
    // The change reaches instance A; the simulated Redis relay to B is dropped.
    listeners[0]({ companyUuid: "company", userUuid: "human" });
    await flush();
    expect(a.isClosed()).toBe(true);
    expect(b.isClosed()).toBe(false);
    await vi.advanceTimersByTimeAsync(30_000);
    await b.send("late message");
    expect(b.isClosed()).toBe(true);
    expect(b.controller.enqueue).not.toHaveBeenCalled();
  });
  it("does not extend the deadline while a renewal query hangs", async () => {
    const stream = gate(); await flush();
    validate.mockImplementationOnce(() => new Promise(() => {}));
    await vi.advanceTimersByTimeAsync(25_000);
    expect(validate).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5_000);
    await stream.send("expired");
    expect(stream.isClosed()).toBe(true);
    expect(stream.controller.enqueue).not.toHaveBeenCalled();
  });
  it("checks the monotonic deadline at enqueue even when timeout callbacks are delayed", async () => {
    const stream = gate(); await flush();
    // Wall time cannot grant a lease extension. Advance only the monotonic clock,
    // leaving scheduled timers unfired to emulate a blocked event loop.
    vi.spyOn(performance, "now").mockReturnValue(30_001);
    await stream.send("expired despite delayed timer");
    expect(stream.isClosed()).toBe(true);
    expect(stream.controller.enqueue).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
  it("measures a renewed lease from query start rather than its delayed result", async () => {
    const stream = gate(); await flush();
    let release!: (valid: boolean) => void;
    validate.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    await vi.advanceTimersByTimeAsync(25_000);
    await vi.advanceTimersByTimeAsync(4_000);
    release(true); await flush();
    vi.spyOn(performance, "now").mockReturnValue(55_001);
    await stream.send("cannot use completion-time lease");
    expect(stream.isClosed()).toBe(true);
    expect(stream.controller.enqueue).not.toHaveBeenCalled();
    vi.restoreAllMocks();
  });
  it("enforces known token expiry without repeated crypto or DB reads", async () => {
    const stream = gate(Date.now() + 2_000); await flush();
    await stream.send("before expiry");
    await vi.advanceTimersByTimeAsync(2_000);
    await stream.send("after expiry");
    expect(validate).toHaveBeenCalledTimes(1);
    expect(stream.controller.enqueue).toHaveBeenCalledTimes(1);
    expect(stream.isClosed()).toBe(true);
  });
  it("cleans up once on DB failure and ignores results arriving after cancellation", async () => {
    let release!: (valid: boolean) => void;
    validate.mockImplementationOnce(() => new Promise(resolve => { release = resolve; }));
    const stream = gate(); stream.close(); stream.close();
    release(true); await flush();
    await stream.send("cancelled");
    expect(stream.cleanup).toHaveBeenCalledTimes(1);
    expect(stream.controller.enqueue).not.toHaveBeenCalled();
    expect(bus.listenerCount("account_access_changed")).toBe(0);
    const failed = gate(); await flush();
    validate.mockRejectedValueOnce(new Error("DB unavailable"));
    bus.emit("account_access_changed", { companyUuid: "company", userUuid: "human" });
    await failed.send("blocked");
    expect(failed.isClosed()).toBe(true);
  });
});
