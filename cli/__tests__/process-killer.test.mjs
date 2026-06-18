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
