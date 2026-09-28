import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { WindowsProcessTree, readWindowsProcessSnapshot } from "../windows-process-tree.mjs";

const root = { pid: 100, parentPid: 1, startedAt: "2026-09-28T10:00:00.0000000Z" };
const descendant = { pid: 101, parentPid: 100, startedAt: "2026-09-28T10:00:01.0000000Z" };
const grandchild = { pid: 102, parentPid: 101, startedAt: "2026-09-28T10:00:02.0000000Z" };
const child = () => ({ pid: 100, exitCode: null, signalCode: null, kill: vi.fn() });

describe("Windows process identity ownership", () => {
  it("captures before close and accepts a clean root/no descendants without taskkill", async () => {
    const process = child();
    let current = [root];
    const spawnImpl = vi.fn();
    const tree = new WindowsProcessTree(process, { deadline: Date.now() + 1000, snapshotImpl: async () => current, spawnImpl });
    await tree.capture();
    process.exitCode = 0; current = [];
    expect(await tree.cleanup()).toEqual({ cleanupFailed: false, escalated: false });
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it("also accepts a root already absent before the first snapshot, with no descendants", async () => {
    const process = { ...child(), exitCode: 0 };
    const spawnImpl = vi.fn();
    const tree = new WindowsProcessTree(process, { deadline: Date.now() + 1000, snapshotImpl: async () => [], spawnImpl });
    expect((await tree.cleanup()).cleanupFailed).toBe(false);
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it.each(["success", "gone-race", "error", "nonzero"])("handles surviving descendants after root exit: %s", async mode => {
    const process = child();
    let current = [root, descendant, grandchild];
    const attempts = [];
    const tree = new WindowsProcessTree(process, {
      deadline: Date.now() + 1000, snapshotImpl: async () => current,
      spawnImpl: (command, args) => {
        attempts.push([command, args]);
        const tk = new EventEmitter(); tk.kill = vi.fn();
        queueMicrotask(() => {
          if (mode === "success" || mode === "gone-race") current = [];
          if (mode === "error") tk.emit("error", new Error("PRIVATE-ERROR"));
          else tk.emit("exit", mode === "success" ? 0 : 128);
          tk.emit("close", mode === "success" ? 0 : 128);
        });
        return tk;
      },
    });
    await tree.capture();
    process.exitCode = 0; current = [descendant, grandchild];
    const result = await tree.cleanup();
    expect(result.cleanupFailed).toBe(mode === "error" || mode === "nonzero");
    expect(attempts[0]).toEqual(["taskkill", ["/PID", "101", "/T", "/F"]]);
    expect(attempts.every(([, args]) => args[1] !== "100")).toBe(true);
    if (!result.cleanupFailed) expect(attempts).toHaveLength(1);
  });

  it("does not kill a reused descendant PID or its unrelated children", async () => {
    const process = child(); let current = [root, descendant];
    const spawnImpl = vi.fn();
    const tree = new WindowsProcessTree(process, { deadline: Date.now() + 1000, snapshotImpl: async () => current, spawnImpl });
    await tree.capture(); process.exitCode = 0;
    current = [{ ...descendant, parentPid: 999, startedAt: "2026-09-28T11:00:00Z" },
      { ...grandchild, startedAt: "2026-09-28T11:00:01Z" }];
    expect((await tree.cleanup()).cleanupFailed).toBe(false);
    expect(spawnImpl).not.toHaveBeenCalled();
  });

  it("retains a captured grandchild when its intermediate parent exits", async () => {
    const process = child(); let current = [root, descendant, grandchild];
    const targets = [];
    const tree = new WindowsProcessTree(process, {
      deadline: Date.now() + 1000, snapshotImpl: async () => current,
      spawnImpl: (_cmd, args) => {
        targets.push(args[1]); const tk = new EventEmitter();
        queueMicrotask(() => { current = []; tk.emit("exit", 0); tk.emit("close", 0); });
        return tk;
      },
    });
    await tree.capture(); process.exitCode = 0; current = [grandchild];
    expect((await tree.cleanup()).cleanupFailed).toBe(false);
    expect(targets).toEqual(["102"]);
  });

  it("fails uncertain ownership/query results without killing arbitrary PIDs", async () => {
    for (const mode of ["query", "orphan", "live-missing"]) {
      const process = child();
      if (mode === "orphan") process.exitCode = 0;
      const spawnImpl = vi.fn();
      const tree = new WindowsProcessTree(process, { deadline: Date.now() + 1000, spawnImpl,
        snapshotImpl: async () => { if (mode === "query") throw new Error("private"); return mode === "orphan" ? [descendant] : []; } });
      expect((await tree.cleanup()).cleanupFailed).toBe(true);
      expect(spawnImpl).not.toHaveBeenCalled();
    }
  });

  it("does not treat a stalled descendant taskkill as verified cleanup", async () => {
    vi.useFakeTimers();
    try {
      const process = child(); let current = [root, descendant];
      const tk = new EventEmitter(); tk.kill = vi.fn(() => tk.emit("close", null));
      const tree = new WindowsProcessTree(process, { deadline: Date.now() + 30,
        snapshotImpl: async () => current, spawnImpl: () => tk });
      await tree.capture(); process.exitCode = 0; current = [descendant];
      const pending = tree.cleanup();
      await vi.advanceTimersByTimeAsync(30);
      expect((await pending).cleanupFailed).toBe(true);
      expect(tk.kill).toHaveBeenCalledWith("SIGKILL");
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
});

describe("bounded Windows system commands", () => {
  function queryChild(run) {
    const c = new EventEmitter(); c.stdout = new PassThrough(); c.kill = vi.fn(() => c.emit("close", null));
    queueMicrotask(() => run(c));
    return c;
  }
  it("reads only PID/parent/creation identities through noninteractive PowerShell", async () => {
    const spawnImpl = vi.fn(() => queryChild(c => {
      c.stdout.write(JSON.stringify([root, descendant])); c.emit("exit", 0); c.emit("close", 0);
    }));
    expect(await readWindowsProcessSnapshot({ deadline: Date.now() + 1000, spawnImpl })).toEqual([root, descendant]);
    expect(spawnImpl.mock.calls[0][0]).toBe("powershell.exe");
    expect(spawnImpl.mock.calls[0][1]).toContain("-NonInteractive");
    expect(spawnImpl.mock.calls[0][2]).toMatchObject({ shell: false, stdio: ["ignore", "pipe", "ignore"] });
  });

  it.each(["invalid", "oversized", "error", "nonzero"])("rejects %s query output without exposing it", async mode => {
    const spawnImpl = () => queryChild(c => {
      if (mode === "error") { c.emit("error", new Error("secret")); c.emit("close", 1); return; }
      c.stdout.write(mode === "oversized" ? "x".repeat(4 * 1024 * 1024 + 1) : "secret");
      c.emit("close", mode === "nonzero" ? 1 : 0);
    });
    await expect(readWindowsProcessSnapshot({ deadline: Date.now() + 1000, spawnImpl })).rejects.toThrow();
  });

  it("kills a stalled query at the original deadline and clears listeners/timers", async () => {
    vi.useFakeTimers();
    try {
      const c = queryChild(() => {});
      const pending = readWindowsProcessSnapshot({ deadline: Date.now() + 30, spawnImpl: () => c });
      const observed = pending.catch(error => error);
      await vi.advanceTimersByTimeAsync(30);
      expect(await observed).toBeInstanceOf(Error);
      expect(c.kill).toHaveBeenCalledWith("SIGKILL");
      expect(c.stdout.listenerCount("data")).toBe(0);
      expect(c.listenerCount("error")).toBe(0);
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
});
