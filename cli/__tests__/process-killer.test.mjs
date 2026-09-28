// cli/__tests__/process-killer.test.mjs
// Covers the two-stage cross-platform process-tree killer (子3 —
// daemon-interrupt-resume, spec "Interrupting SHALL use a two-stage stop" +
// "The forceful kill SHALL terminate the whole process tree cross-platform"):
//   • graceful SIGINT within the timeout → no escalation
//   • no exit within the timeout → forceful escalation
//   • POSIX signals the process GROUP (negative pid) so grandchildren are reaped
//   • Windows escalates via `taskkill /PID <pid> /T /F`
//   • never throws into the wake path; no native deps (only process.kill + spawn).
import { describe, it, expect, vi } from "vitest";
import { killProcessTree, DEFAULT_SIGINT_TIMEOUT_MS } from "../process-killer.mjs";

const silent = { info() {}, warn() {}, error() {} };

/** A minimal child double with a controllable pid. */
function fakeChild(pid = 1000) {
  return { pid };
}

describe("killProcessTree — POSIX two-stage group kill", () => {
  it("sends SIGINT to the process GROUP (negative pid) and does NOT escalate when the child exits in time", async () => {
    const killImpl = vi.fn();
    const res = await killProcessTree(fakeChild(1234), {
      platform: "linux",
      logger: silent,
      killImpl,
      sigintTimeoutMs: 50,
      // child exits gracefully within the window
      waitForExit: vi.fn(async () => true),
    });

    // Exactly one signal: SIGINT to the GROUP (-pid). No SIGKILL.
    expect(killImpl).toHaveBeenCalledTimes(1);
    expect(killImpl).toHaveBeenCalledWith(-1234, "SIGINT");
    expect(res).toEqual({ signaled: true, killed: true, escalated: false });
  });

  it("escalates to SIGKILL on the GROUP when the child does NOT exit within the timeout (reaps grandchildren)", async () => {
    const killImpl = vi.fn();
    const res = await killProcessTree(fakeChild(777), {
      platform: "linux",
      logger: silent,
      killImpl,
      sigintTimeoutMs: 20,
      waitForExit: vi.fn(async () => false), // never exits → timeout
    });

    // SIGINT then SIGKILL, both to the negative pid (the whole group).
    expect(killImpl.mock.calls).toEqual([
      [-777, "SIGINT"],
      [-777, "SIGKILL"],
    ]);
    expect(res).toEqual({ signaled: true, killed: true, escalated: true });
  });

  it("respects the timing: escalates only after the real timer elapses", async () => {
    vi.useFakeTimers();
    const killImpl = vi.fn();
    // No injected waitForExit → the killer races the child's 'exit' against a timer.
    const child = fakeChild(55);
    child.exitCode = null; // not yet exited
    const listeners = {};
    child.once = (ev, cb) => { listeners[ev] = cb; };

    const p = killProcessTree(child, {
      platform: "linux",
      logger: silent,
      killImpl,
      sigintTimeoutMs: 10_000,
    });

    // Before the timer: only the graceful SIGINT was sent, no escalation yet.
    await Promise.resolve();
    expect(killImpl).toHaveBeenCalledTimes(1);
    expect(killImpl).toHaveBeenLastCalledWith(-55, "SIGINT");

    // Advance to the timeout → escalation fires.
    await vi.advanceTimersByTimeAsync(10_000);
    const res = await p;
    expect(killImpl).toHaveBeenLastCalledWith(-55, "SIGKILL");
    expect(res.escalated).toBe(true);
    vi.useRealTimers();
  });

  it("does NOT escalate when the child emits 'exit' before the timer", async () => {
    vi.useFakeTimers();
    const killImpl = vi.fn();
    const child = fakeChild(66);
    child.exitCode = null;
    const listeners = {};
    child.once = (ev, cb) => { listeners[ev] = cb; };

    const p = killProcessTree(child, {
      platform: "linux",
      logger: silent,
      killImpl,
      sigintTimeoutMs: 10_000,
    });
    await Promise.resolve();
    // Child exits gracefully a bit later.
    await vi.advanceTimersByTimeAsync(2_000);
    listeners.exit?.(0);
    const res = await p;

    expect(res.escalated).toBe(false);
    // Only the SIGINT — no SIGKILL.
    expect(killImpl).toHaveBeenCalledTimes(1);
    expect(killImpl).toHaveBeenCalledWith(-66, "SIGINT");
    vi.useRealTimers();
  });

  it("short-circuits to 'exited' when the child has already terminated (exitCode set)", async () => {
    const killImpl = vi.fn();
    const child = fakeChild(99);
    child.exitCode = 0; // already gone
    const res = await killProcessTree(child, {
      platform: "linux",
      logger: silent,
      killImpl,
      sigintTimeoutMs: 10_000,
    });
    // SIGINT still attempted (best-effort, ESRCH-safe), but no escalation.
    expect(res.escalated).toBe(false);
    expect(killImpl).toHaveBeenCalledWith(-99, "SIGINT");
  });

  it("never throws when process.kill throws (ESRCH/EPERM); logs and continues", async () => {
    const warns = [];
    const killImpl = vi.fn(() => { throw new Error("ESRCH"); });
    const res = await killProcessTree(fakeChild(5), {
      platform: "linux",
      logger: { ...silent, warn: (m) => warns.push(m) },
      killImpl,
      sigintTimeoutMs: 5,
      waitForExit: vi.fn(async () => false),
    });
    // Both stages attempted; both threw but were swallowed.
    expect(res.escalated).toBe(true);
    expect(warns.join("")).toMatch(/kill\(-5, SIGINT\) failed/);
    expect(warns.join("")).toMatch(/kill\(-5, SIGKILL\) failed/);
  });
});

describe("killProcessTree — Windows taskkill escalation", () => {
  it("best-effort child.kill('SIGINT') then escalates via taskkill /PID <pid> /T /F", async () => {
    const child = fakeChild(31337);
    child.kill = vi.fn(() => true);
    const spawned = { on: vi.fn() };
    const spawnImpl = vi.fn(() => spawned);

    const res = await killProcessTree(child, {
      platform: "win32",
      logger: silent,
      spawnImpl,
      sigintTimeoutMs: 10,
      waitForExit: vi.fn(async () => false), // never exits → escalate
    });

    // Graceful: direct child.kill (no group signal exists on Windows).
    expect(child.kill).toHaveBeenCalledWith("SIGINT");
    // Forceful: taskkill /PID <pid> /T /F — verified flags (Microsoft Learn).
    expect(spawnImpl).toHaveBeenCalledTimes(1);
    const [cmd, args] = spawnImpl.mock.calls[0];
    expect(cmd).toBe("taskkill");
    expect(args).toEqual(["/PID", "31337", "/T", "/F"]);
    expect(res.escalated).toBe(true);
  });

  it("does NOT taskkill when the Windows child exits gracefully within the timeout", async () => {
    const child = fakeChild(42);
    child.kill = vi.fn(() => true);
    const spawnImpl = vi.fn();
    const res = await killProcessTree(child, {
      platform: "win32",
      logger: silent,
      spawnImpl,
      sigintTimeoutMs: 10,
      waitForExit: vi.fn(async () => true),
    });
    expect(spawnImpl).not.toHaveBeenCalled();
    expect(res.escalated).toBe(false);
  });

  it("never throws when taskkill spawn fails", async () => {
    const warns = [];
    const child = fakeChild(7);
    child.kill = vi.fn(() => true);
    const res = await killProcessTree(child, {
      platform: "win32",
      logger: { ...silent, warn: (m) => warns.push(m) },
      spawnImpl: () => { throw new Error("spawn taskkill ENOENT"); },
      sigintTimeoutMs: 5,
      waitForExit: vi.fn(async () => false),
    });
    expect(res.escalated).toBe(true);
    expect(warns.join("")).toMatch(/taskkill escalation failed/);
  });
});

describe("killProcessTree — guards & defaults", () => {
  it("no-ops (no throw) when there is no child pid to target", async () => {
    const warns = [];
    const res = await killProcessTree(null, { logger: { ...silent, warn: (m) => warns.push(m) } });
    expect(res).toEqual({ signaled: false, killed: false, escalated: false });
    expect(warns.join("")).toMatch(/no child pid/);
  });

  it("exposes the spec default timeout of 10000ms", () => {
    expect(DEFAULT_SIGINT_TIMEOUT_MS).toBe(10_000);
  });
});

describe("process-associated protocol stop", () => {
  it("registry disposal is idempotent and cannot erase a replacement", async () => {
    const { registerProcessStopHook, getProcessStopHook } = await import("../process-stop-hooks.mjs");
    const child = fakeChild();
    const first = registerProcessStopHook(child, () => {});
    const secondHook = () => {};
    const second = registerProcessStopHook(child, secondHook);
    first(); first();
    expect(getProcessStopHook(child)).toBe(secondHook);
    expect(JSON.stringify(child)).toBe('{"pid":1000}');
    second(); second();
    expect(getProcessStopHook(child)).toBeUndefined();
  });

  it("protocol and exit wait share one deadline and do not send SIGINT", async () => {
    const { registerProcessStopHook } = await import("../process-stop-hooks.mjs");
    vi.useFakeTimers();
    try {
      const child = fakeChild(123);
      const killImpl = vi.fn();
      const waitForExit = vi.fn(async (ms) => { expect(ms).toBe(30); return true; });
      registerProcessStopHook(child, () => new Promise((resolve) => setTimeout(resolve, 70)));
      const stopped = killProcessTree(child, { sigintTimeoutMs: 100, killImpl, waitForExit, hasTree: () => false });
      await vi.advanceTimersByTimeAsync(70);
      expect(await stopped).toEqual({ signaled: false, killed: true, escalated: false });
      expect(killImpl).not.toHaveBeenCalled();
      expect(waitForExit).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });

  it.each(["reject", "hang", "throw"])("%s hook cannot prevent forced cleanup", async (mode) => {
    const { registerProcessStopHook } = await import("../process-stop-hooks.mjs");
    vi.useFakeTimers();
    try {
      const child = fakeChild(321);
      const killImpl = vi.fn();
      registerProcessStopHook(child, () => {
        if (mode === "throw") throw new Error("no");
        return mode === "reject" ? Promise.reject(new Error("no")) : new Promise(() => {});
      });
      const stopped = killProcessTree(child, { sigintTimeoutMs: 100, killImpl });
      await vi.advanceTimersByTimeAsync(100);
      expect((await stopped).escalated).toBe(true);
      expect(killImpl.mock.calls).toEqual([[-321, "SIGKILL"]]);
    } finally { vi.useRealTimers(); }
  });

  it("still reaps remaining descendants after the leader exited", async () => {
    const { registerProcessStopHook } = await import("../process-stop-hooks.mjs");
    const child = { ...fakeChild(123), exitCode: 0 };
    const killImpl = vi.fn();
    registerProcessStopHook(child, () => {});
    expect((await killProcessTree(child, { killImpl })).escalated).toBe(true);
    expect(killImpl.mock.calls).toEqual([[-123, 0], [-123, "SIGKILL"]]);
  });

  it("Windows taskkill uses only the original protocol deadline remainder", async () => {
    const { registerProcessStopHook } = await import("../process-stop-hooks.mjs");
    const { EventEmitter } = await import("node:events");
    vi.useFakeTimers();
    try {
      const child = { ...fakeChild(123), exitCode: null };
      const taskkill = new EventEmitter();
      const spawnImpl = vi.fn(() => taskkill);
      const root = { pid: 123, parentPid: 1, startedAt: "2026-09-28T10:00:00Z" };
      const descendant = { pid: 124, parentPid: 123, startedAt: "2026-09-28T10:00:01Z" };
      registerProcessStopHook(child, async ({ beforeClose }) => {
        await new Promise(resolve => setTimeout(resolve, 70));
        await beforeClose();
        child.exitCode = 0;
      });
      const pending = killProcessTree(child, { platform: "win32", sigintTimeoutMs: 100, spawnImpl, logger: silent,
        windowsSnapshotImpl: async () => child.exitCode === null ? [root, descendant] : [descendant] });
      await vi.advanceTimersByTimeAsync(70);
      expect(spawnImpl).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(30);
      expect(await pending).toMatchObject({ cleanupFailed: true, escalated: true });
      expect(vi.getTimerCount()).toBe(0);
      taskkill.emit("close", 1);
      expect(taskkill.listenerCount("error")).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it("reserves Windows cleanup time when a live root ignores graceful close", async () => {
    const { registerProcessStopHook } = await import("../process-stop-hooks.mjs");
    const { EventEmitter } = await import("node:events");
    vi.useFakeTimers();
    try {
      const child = { ...fakeChild(123), exitCode: null };
      const root = { pid: 123, parentPid: 1, startedAt: "2026-09-28T10:00:00Z" };
      let current = [root];
      let taskkillAt;
      registerProcessStopHook(child, async ({ deadline, protocolDeadline, beforeClose }) => {
        expect(protocolDeadline).toBe(deadline - 12);
        expect(Number.isSafeInteger(protocolDeadline)).toBe(true);
        await beforeClose();
      });
      const pending = killProcessTree(child, {
        platform: "win32", sigintTimeoutMs: 50, logger: silent,
        windowsSnapshotImpl: async () => current,
        spawnImpl: () => {
          taskkillAt = Date.now();
          const tk = new EventEmitter();
          queueMicrotask(() => { current = []; child.exitCode = 1; tk.emit("exit", 0); tk.emit("close", 0); });
          return tk;
        },
      });
      const startedAt = Date.now();
      await vi.advanceTimersByTimeAsync(38);
      expect(await pending).toMatchObject({ killed: true, escalated: true });
      expect(taskkillAt - startedAt).toBe(38);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it("concurrent cleanup and interrupt invoke the latch immediately but share escalation", async () => {
    const { registerProcessStopHook } = await import("../process-stop-hooks.mjs");
    vi.useFakeTimers();
    try {
      const child = fakeChild(456);
      const seen = [];
      const killImpl = vi.fn();
      registerProcessStopHook(child, (context) => { seen.push(context); return new Promise(() => {}); });
      const first = killProcessTree(child, { killImpl, sigintTimeoutMs: 100, reason: "cleanup" });
      await vi.advanceTimersByTimeAsync(60);
      const second = killProcessTree(child, { killImpl, sigintTimeoutMs: 100 });
      expect(seen.map((s) => s.reason)).toEqual(["cleanup", "interrupt"]);
      expect(seen[0].deadline).toBe(seen[1].deadline);
      await vi.advanceTimersByTimeAsync(40);
      expect(await first).toEqual(await second);
      expect(killImpl.mock.calls).toEqual([[-456, "SIGKILL"]]);
    } finally { vi.useRealTimers(); }
  });

  it("removes raw exit listeners after timeout and recognizes signal termination", async () => {
    const { EventEmitter } = await import("node:events");
    const child = new EventEmitter(); child.pid = 123; child.signalCode = "SIGINT";
    expect((await killProcessTree(child, { killImpl: vi.fn() })).escalated).toBe(false);
    child.signalCode = null;
    vi.useFakeTimers();
    try {
      const pending = killProcessTree(child, { killImpl: vi.fn(), sigintTimeoutMs: 10 });
      await vi.advanceTimersByTimeAsync(10);
      await pending;
      expect(child.listenerCount("exit")).toBe(0);
      expect(child.listenerCount("close")).toBe(0);
    } finally { vi.useRealTimers(); }
  });
});
