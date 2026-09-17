// cli/__tests__/child-exit.test.mjs
// Covers the daemon-spawner-interface spec requirement "a wake SHALL settle on
// process exit, not only on stdio close":
//   • `close` first          → settle immediately, no grace warning.
//   • `exit` with no `close` → settle with the exit code after the bounded grace,
//                              warning logged exactly once (the "a detached
//                              descendant inherited the pipes" diagnostic).
//   • `exit` then `close`    → settle exactly once.
//   • the grace timer is `unref`'d so it cannot hold the daemon's event loop open.
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { EventEmitter } from "node:events";
import { awaitChildSettled, DEFAULT_STDIO_GRACE_MS } from "../child-exit.mjs";

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe("awaitChildSettled", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("settles immediately on close-first without a grace warning", async () => {
    const child = new EventEmitter();
    const logger = makeLogger();
    const settled = awaitChildSettled(child, { logger, label: "pi" });

    child.emit("close", 0);

    await expect(settled).resolves.toBe(0);
    expect(logger.warn).not.toHaveBeenCalled();
    // Nothing was scheduled: close-first never arms the grace timer.
    expect(vi.getTimerCount()).toBe(0);
  });

  it("settles on close-first even when a nonzero code arrives", async () => {
    const child = new EventEmitter();
    const logger = makeLogger();
    const settled = awaitChildSettled(child, { logger, label: "claude" });

    child.emit("close", 23);

    await expect(settled).resolves.toBe(23);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it("settles with the exit code after the grace when close never arrives, warning once", async () => {
    const child = new EventEmitter();
    const logger = makeLogger();
    const settled = awaitChildSettled(child, { logger, label: "codex", stdioGraceMs: 2000 });

    child.emit("exit", 7, null);
    // Still pending before the grace expires — the pipes get their bounded moment.
    let resolvedWith = "pending";
    settled.then((code) => {
      resolvedWith = code;
    });
    await vi.advanceTimersByTimeAsync(1999);
    expect(resolvedWith).toBe("pending");

    await vi.advanceTimersByTimeAsync(1);
    await expect(settled).resolves.toBe(7);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toContain("codex exited (code 7)");
    expect(logger.warn.mock.calls[0][0]).toContain("stdio stayed open for 2000ms");
  });

  it("normalizes a signalled exit (code null) and still settles", async () => {
    const child = new EventEmitter();
    const logger = makeLogger();
    const settled = awaitChildSettled(child, { logger, label: "kiro-cli", stdioGraceMs: 50 });

    child.emit("exit", null, "SIGKILL");
    await vi.advanceTimersByTimeAsync(50);

    await expect(settled).resolves.toBe(null);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0][0]).toContain("code null");
  });

  it("settles exactly once when exit is followed by close inside the grace", async () => {
    const child = new EventEmitter();
    const logger = makeLogger();
    const onSettled = vi.fn();
    awaitChildSettled(child, { logger, label: "dsh", stdioGraceMs: 2000 }).then(onSettled);

    child.emit("exit", 0, null);
    child.emit("close", 0);
    await vi.advanceTimersByTimeAsync(5000);

    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(onSettled).toHaveBeenCalledWith(0);
    // close won the race, so the grace never expired and nothing was warned.
    expect(logger.warn).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("settles exactly once when close arrives after the grace already settled", async () => {
    const child = new EventEmitter();
    const logger = makeLogger();
    const onSettled = vi.fn();
    awaitChildSettled(child, { logger, label: "dsh", stdioGraceMs: 10 }).then(onSettled);

    child.emit("exit", 3, null);
    await vi.advanceTimersByTimeAsync(10);
    child.emit("close", 0);
    await vi.advanceTimersByTimeAsync(1000);

    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(onSettled).toHaveBeenCalledWith(3);
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it("arms the grace once even if exit is emitted twice", async () => {
    const child = new EventEmitter();
    const logger = makeLogger();
    const onSettled = vi.fn();
    awaitChildSettled(child, { logger, label: "pi", stdioGraceMs: 30 }).then(onSettled);

    child.emit("exit", 4, null);
    child.emit("exit", 9, null);
    await vi.advanceTimersByTimeAsync(30);

    expect(onSettled).toHaveBeenCalledTimes(1);
    expect(onSettled).toHaveBeenCalledWith(4);
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("unrefs the grace timer so it cannot hold the daemon's event loop open", async () => {
    const child = new EventEmitter();
    const unref = vi.fn();
    const spy = vi.spyOn(globalThis, "setTimeout").mockImplementation(() => ({ unref }));

    try {
      awaitChildSettled(child, { logger: makeLogger(), label: "pi" });
      child.emit("exit", 0, null);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy.mock.calls[0][1]).toBe(DEFAULT_STDIO_GRACE_MS);
      expect(unref).toHaveBeenCalledTimes(1);
    } finally {
      spy.mockRestore();
    }
  });

  it("never rejects and tolerates a child without listeners or a logger", async () => {
    const bare = {};
    // No `on` at all (defensive: dsh calls through optional chaining today).
    const settled = awaitChildSettled(bare);
    expect(settled).toBeInstanceOf(Promise);

    const child = new EventEmitter();
    const noLogger = awaitChildSettled(child, { stdioGraceMs: 5 });
    child.emit("exit", 1, null);
    await vi.advanceTimersByTimeAsync(5);
    await expect(noLogger).resolves.toBe(1);
  });
});
