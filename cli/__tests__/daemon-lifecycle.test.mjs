// cli/__tests__/daemon-lifecycle.test.mjs
// Covers daemon-background-lifecycle: -d detach (pidfile/logfile, double-start
// guard, POSIX+Windows spawn opts), stop/status/logs, and the identity-verified
// liveness probe (fix-daemon-stale-pid-identity): pidfile JSON round-trip,
// queryProcessIdentity platform branches, and the probe decision table incl.
// the query-failure split. All IO injected.
import { describe, it, expect } from "vitest";
import {
  startBackground,
  stopDaemon,
  isRunning,
  readPid,
  readPidRecord,
  processAlive,
  queryProcessIdentity,
  readLog,
} from "../daemon-lifecycle.mjs";

/**
 * A fake IO over an in-memory file map + controllable process table.
 * `identities`: pid → { startedAt?, cmdline } drives the fake `ps`;
 * a pid absent from `identities` makes every ps invocation return nothing,
 * modelling a vanished process / missing ps. `busybox: true` models real
 * busybox 1.36 behavior: any `-p` or `-o lstart` invocation errors (status 1),
 * while `ps -o pid=,args=` lists the whole table for caller-side filtering.
 */
function fakeIO({
  files = {},
  alivePids = new Set(),
  epermPids = new Set(),
  identities = {},
  busybox = false,
  platform = "linux",
  spawnPid = 4242,
} = {}) {
  const spawnCalls = [];
  const spawnSyncCalls = [];
  return {
    _files: files,
    _spawnCalls: spawnCalls,
    _spawnSyncCalls: spawnSyncCalls,
    existsSync: (p) => p in files,
    readFileSync: (p) => {
      if (!(p in files)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      return files[p];
    },
    writeFileSync: (p, c, opts) => { files[p] = c; files[`${p}:mode`] = opts?.mode; },
    unlinkSync: (p) => { delete files[p]; },
    mkdirSync: () => {},
    openSync: () => 7, // fake fd
    spawn: (cmd, args, opts) => {
      spawnCalls.push({ cmd, args, opts });
      return { pid: spawnPid, unref: () => {} };
    },
    spawnSync: (cmd, args, opts) => {
      spawnSyncCalls.push({ cmd, args, opts });
      if (cmd === "powershell") {
        const pid = Number.parseInt((args.join(" ").match(/ProcessId=(\d+)/) ?? [])[1] ?? "", 10);
        const id = identities[pid];
        if (!id) return { status: 1, stdout: "" };
        return { status: 0, stdout: JSON.stringify({ CommandLine: id.cmdline, CreationDate: id.startedAt ?? null }) };
      }
      // POSIX ps. Real busybox 1.36 rejects -p and -o lstart outright.
      const hasP = args.includes("-p");
      const wantsLstart = args.some((a) => String(a).includes("lstart"));
      if (busybox && (hasP || wantsLstart)) return { status: 1, stdout: "", stderr: "ps: invalid option -- 'p'" };
      if (hasP) {
        const pid = Number.parseInt(String(args[args.indexOf("-p") + 1]), 10);
        const id = identities[pid];
        if (!id) return { status: 1, stdout: "" }; // ps -p exits 1 when the pid is gone
        if (wantsLstart) {
          if (!id.startedAt) return { status: 1, stdout: "" };
          return { status: 0, stdout: `${id.startedAt} ${id.cmdline}\n` };
        }
        return { status: 0, stdout: `${id.cmdline}\n` };
      }
      // Full-table listing (`ps -o pid=,args=`): the busybox path.
      const rows = Object.entries(identities).map(([pid, id]) => `${String(pid).padStart(5)} ${id.cmdline}`);
      return { status: 0, stdout: rows.join("\n") + "\n" };
    },
    kill: (pid) => {
      if (epermPids.has(pid)) throw Object.assign(new Error("EPERM"), { code: "EPERM" });
      if (!alivePids.has(pid)) throw Object.assign(new Error("ESRCH"), { code: "ESRCH" });
      return true;
    },
    platform,
    home: "/home/u",
  };
}

const PID = "/home/u/.chorus/daemon.pid";
const LOG = "/home/u/.chorus/daemon.log";
// lstart-style fixed 5-field prefix used by the fake ps.
const T1 = "Thu Jul 2 21:22:55 2026";
const T2 = "Fri Jul 3 01:00:00 2026";
const jsonPid = (pid, startedAt, argsHint) =>
  `${JSON.stringify({ pid, ...(startedAt ? { startedAt } : {}), ...(argsHint ? { argsHint } : {}) })}\n`;

describe("readPidRecord / readPid", () => {
  it("parses the JSON format with identity metadata", () => {
    const io = fakeIO({ files: { [PID]: jsonPid(4242, T1, "/x/chorus.mjs daemon") } });
    expect(readPidRecord(io)).toEqual({ pid: 4242, startedAt: T1, argsHint: "/x/chorus.mjs daemon" });
    expect(readPid(io)).toBe(4242);
  });

  it("parses the legacy plain-number format as legacy:true", () => {
    const io = fakeIO({ files: { [PID]: "4242\n" } });
    expect(readPidRecord(io)).toEqual({ pid: 4242, legacy: true });
    expect(readPid(io)).toBe(4242);
  });

  it("returns null on absent / garbage / bad-pid JSON", () => {
    expect(readPidRecord(fakeIO({ files: {} }))).toBeNull();
    expect(readPidRecord(fakeIO({ files: { [PID]: "notapid" } }))).toBeNull();
    expect(readPidRecord(fakeIO({ files: { [PID]: '{"pid":"x"}' } }))).toBeNull();
    expect(readPidRecord(fakeIO({ files: { [PID]: "{broken" } }))).toBeNull();
  });
});

describe("queryProcessIdentity", () => {
  it("POSIX: one ps call returns {cmdline, startedAt} from lstart=,args=", () => {
    const io = fakeIO({ identities: { 10: { startedAt: T1, cmdline: "/usr/bin/node /x/chorus.mjs daemon" } } });
    expect(queryProcessIdentity(10, io)).toEqual({ cmdline: "/usr/bin/node /x/chorus.mjs daemon", startedAt: T1 });
    expect(io._spawnSyncCalls[0].cmd).toBe("ps");
    expect(io._spawnSyncCalls[0].opts.shell).toBeUndefined(); // argument arrays, never shell:true
  });

  it("POSIX busybox fallback: -p/lstart rejected → full-table pid=,args= listing filtered by pid, startedAt:null", () => {
    const io = fakeIO({
      busybox: true,
      identities: {
        10: { cmdline: "/usr/bin/node /x/chorus.mjs daemon" },
        99: { cmdline: "/usr/sbin/sshd" },
      },
    });
    expect(queryProcessIdentity(10, io)).toEqual({ cmdline: "/usr/bin/node /x/chorus.mjs daemon", startedAt: null });
    expect(io._spawnSyncCalls).toHaveLength(2);
    // The retry must NOT use -p (real busybox rejects it) — pid=,args= only.
    expect(io._spawnSyncCalls[1].args).toEqual(["-o", "pid=,args="]);
    // A pid absent from the table → null, not another process's cmdline.
    expect(queryProcessIdentity(42, io)).toBeNull();
  });

  it("Windows: PowerShell Get-CimInstance branch (no shell:true)", () => {
    const io = fakeIO({ platform: "win32", identities: { 10: { startedAt: "20260702212255", cmdline: "node.exe chorus.mjs daemon" } } });
    expect(queryProcessIdentity(10, io)).toEqual({ cmdline: "node.exe chorus.mjs daemon", startedAt: "20260702212255" });
    expect(io._spawnSyncCalls[0].cmd).toBe("powershell");
    expect(io._spawnSyncCalls[0].args).not.toContain("wmic");
    expect(io._spawnSyncCalls[0].opts.shell).toBeUndefined();
  });

  it("returns null on total failure (ps unavailable / no output / bad pid)", () => {
    expect(queryProcessIdentity(10, fakeIO({}))).toBeNull(); // no identity → both ps calls fail
    expect(queryProcessIdentity(-1, fakeIO({}))).toBeNull();
    const noSpawnSync = { platform: "linux" }; // spawnSync missing entirely
    expect(queryProcessIdentity(10, noSpawnSync)).toBeNull();
  });
});

describe("processAlive — identity-verified probe decision table", () => {
  const HINT = "/x/chorus.mjs daemon";

  it("ESRCH ⇒ stale (unchanged)", () => {
    expect(processAlive({ pid: 11, legacy: true }, fakeIO({}))).toBe(false);
    expect(processAlive({ pid: 11, startedAt: T1, argsHint: HINT }, fakeIO({}))).toBe(false);
  });

  it("EPERM + identity match ⇒ running", () => {
    const io = fakeIO({ epermPids: new Set([12]), identities: { 12: { startedAt: T1, cmdline: `/usr/bin/node ${HINT}` } } });
    expect(processAlive({ pid: 12, startedAt: T1, argsHint: HINT }, io)).toBe(true);
  });

  it("EPERM + startedAt mismatch ⇒ stale (the reboot-recycled pid bug)", () => {
    const io = fakeIO({ epermPids: new Set([12]), identities: { 12: { startedAt: T2, cmdline: "/usr/sbin/dockerd" } } });
    expect(processAlive({ pid: 12, startedAt: T1, argsHint: HINT }, io)).toBe(false);
  });

  it("EPERM + cmdline mismatch ⇒ stale even when startedAt matches", () => {
    const io = fakeIO({ epermPids: new Set([12]), identities: { 12: { startedAt: T1, cmdline: "/usr/sbin/dockerd" } } });
    expect(processAlive({ pid: 12, startedAt: T1, argsHint: HINT }, io)).toBe(false);
  });

  it("signalable pid + identity mismatch ⇒ stale (recycled to our own other process)", () => {
    const io = fakeIO({ alivePids: new Set([13]), identities: { 13: { startedAt: T2, cmdline: "vim notes.txt" } } });
    expect(processAlive({ pid: 13, startedAt: T1, argsHint: HINT }, io)).toBe(false);
  });

  it("identity record + busybox (startedAt unavailable live) ⇒ cmdline alone decides", () => {
    const io = fakeIO({ busybox: true, epermPids: new Set([12]), identities: { 12: { cmdline: `/usr/bin/node ${HINT}` } } });
    expect(processAlive({ pid: 12, startedAt: T1, argsHint: HINT }, io)).toBe(true);
    const io2 = fakeIO({ busybox: true, epermPids: new Set([12]), identities: { 12: { cmdline: "/usr/sbin/dockerd" } } });
    expect(processAlive({ pid: 12, startedAt: T1, argsHint: HINT }, io2)).toBe(false);
  });

  it("query failure on an identity-carrying record ⇒ conservative running (never auto-clean)", () => {
    const io = fakeIO({ epermPids: new Set([12]) }); // no identities → query fails
    expect(processAlive({ pid: 12, startedAt: T1, argsHint: HINT }, io)).toBe(true);
    const io2 = fakeIO({ alivePids: new Set([13]) });
    expect(processAlive({ pid: 13, startedAt: T1, argsHint: HINT }, io2)).toBe(true);
  });

  it("legacy record + daemon-marker cmdline ⇒ running", () => {
    const io = fakeIO({ epermPids: new Set([12]), identities: { 12: { startedAt: T1, cmdline: "/usr/bin/node /x/chorus.mjs daemon" } } });
    expect(processAlive({ pid: 12, legacy: true }, io)).toBe(true);
  });

  it("legacy record + non-daemon cmdline ⇒ stale (q3=a self-heal)", () => {
    const io = fakeIO({ epermPids: new Set([12]), identities: { 12: { startedAt: T1, cmdline: "/usr/sbin/dockerd -H fd://" } } });
    expect(processAlive({ pid: 12, legacy: true }, io)).toBe(false);
  });

  it("legacy record + EPERM + query failure ⇒ stale (EPERM proves it is not ours)", () => {
    const io = fakeIO({ epermPids: new Set([12]) }); // busybox-class: no identity available
    expect(processAlive({ pid: 12, legacy: true }, io)).toBe(false);
  });

  it("legacy record + signalable pid + query failure ⇒ conservative running", () => {
    const io = fakeIO({ alivePids: new Set([10]) });
    expect(processAlive({ pid: 10, legacy: true }, io)).toBe(true);
  });

  it("accepts a bare pid number for backward compatibility (treated as legacy)", () => {
    const io = fakeIO({ alivePids: new Set([10]) });
    expect(processAlive(10, io)).toBe(true);
    expect(processAlive(11, io)).toBe(false);
  });
});

describe("isRunning", () => {
  it("distinguishes running / stale / absent", () => {
    const live = fakeIO({ files: { [PID]: "10" }, alivePids: new Set([10]) });
    expect(isRunning(live)).toEqual({ running: true, pid: 10, stale: false });
    const dead = fakeIO({ files: { [PID]: "10" } });
    expect(isRunning(dead)).toEqual({ running: false, pid: 10, stale: true });
    expect(isRunning(fakeIO({ files: {} }))).toEqual({ running: false, pid: null, stale: false });
  });

  it("reports stale for an identity-mismatched (recycled) pid", () => {
    const io = fakeIO({
      files: { [PID]: jsonPid(10, T1, "/x/chorus.mjs daemon") },
      epermPids: new Set([10]),
      identities: { 10: { startedAt: T2, cmdline: "/usr/sbin/dockerd" } },
    });
    expect(isRunning(io)).toEqual({ running: false, pid: 10, stale: true });
  });
});

describe("startBackground", () => {
  it("spawns detached, writes the JSON pidfile (0600) with identity, returns started", () => {
    const io = fakeIO({
      files: {},
      spawnPid: 999,
      identities: { 999: { startedAt: T1, cmdline: "/usr/bin/node /x/chorus.mjs daemon" } },
    });
    const r = startBackground({ nodePath: "/usr/bin/node", args: ["/x/chorus.mjs", "daemon"], env: { A: "1" } }, io);
    expect(r).toMatchObject({ started: true, pid: 999 });
    const record = JSON.parse(io._files[PID]);
    expect(record).toEqual({ pid: 999, argsHint: "/x/chorus.mjs daemon", startedAt: T1 });
    expect(io._files[`${PID}:mode`]).toBe(0o600);
    const opts = io._spawnCalls[0].opts;
    expect(opts.detached).toBe(true);
    expect(opts.windowsHide).toBe(true);
    expect(opts.stdio[0]).toBe("ignore");
    expect(opts.shell).toBeUndefined(); // never shell:true
  });

  it("degrades to a record without startedAt when the post-spawn query fails", () => {
    const io = fakeIO({ files: {}, spawnPid: 999 }); // no identities → query fails
    const r = startBackground({ nodePath: "node", args: ["/x/chorus.mjs", "daemon"] }, io);
    expect(r.started).toBe(true);
    const record = JSON.parse(io._files[PID]);
    expect(record).toEqual({ pid: 999, argsHint: "/x/chorus.mjs daemon" });
    expect(record.startedAt).toBeUndefined();
  });

  it("refuses to double-start when a live pid is recorded", () => {
    const io = fakeIO({ files: { [PID]: "10" }, alivePids: new Set([10]) });
    const r = startBackground({ nodePath: "node", args: [] }, io);
    expect(r).toMatchObject({ started: false, alreadyRunning: true, pid: 10 });
    expect(io._spawnCalls).toHaveLength(0);
  });

  it("overwrites a stale pidfile (dead pid) and starts", () => {
    const io = fakeIO({ files: { [PID]: "10" }, alivePids: new Set(), spawnPid: 50 });
    const r = startBackground({ nodePath: "node", args: [] }, io);
    expect(r.started).toBe(true);
    expect(JSON.parse(io._files[PID]).pid).toBe(50);
  });

  it("starts over a reboot-recycled pidfile instead of refusing (self-heal e2e)", () => {
    // The original bug: identity mismatch on an EPERM pid must NOT read as
    // alreadyRunning.
    const io = fakeIO({
      files: { [PID]: jsonPid(10, T1, "/x/chorus.mjs daemon") },
      epermPids: new Set([10]),
      identities: { 10: { startedAt: T2, cmdline: "/usr/sbin/dockerd" } },
      spawnPid: 51,
    });
    const r = startBackground({ nodePath: "node", args: ["/x/chorus.mjs", "daemon"] }, io);
    expect(r.started).toBe(true);
    expect(JSON.parse(io._files[PID]).pid).toBe(51);
  });

  it("works for the Windows platform branch (no shell, windowsHide)", () => {
    const io = fakeIO({ files: {}, platform: "win32", spawnPid: 7 });
    const r = startBackground({ nodePath: "node.exe", args: ["chorus.mjs", "daemon"] }, io);
    expect(r.started).toBe(true);
    expect(io._spawnCalls[0].opts.windowsHide).toBe(true);
    expect(io._spawnCalls[0].opts.detached).toBe(true);
  });
});

describe("stopDaemon", () => {
  it("signals a live daemon and removes the pidfile", () => {
    const io = fakeIO({ files: { [PID]: "10" }, alivePids: new Set([10]) });
    const r = stopDaemon(io);
    expect(r).toMatchObject({ stopped: true, pid: 10, reason: "stopped" });
    expect(PID in io._files).toBe(false);
  });

  it("reports clearly when nothing is running (no pidfile)", () => {
    const r = stopDaemon(fakeIO({ files: {} }));
    expect(r).toMatchObject({ stopped: false, reason: "not-running" });
    expect(r.message).toMatch(/no daemon/i);
  });

  it("clears a stale pidfile and reports it", () => {
    const io = fakeIO({ files: { [PID]: "10" }, alivePids: new Set() });
    const r = stopDaemon(io);
    expect(r.reason).toBe("stale-cleared");
    expect(PID in io._files).toBe(false);
  });

  it("self-heals the reboot-recycled pid via the stale-cleared path (the bug)", () => {
    const io = fakeIO({
      files: { [PID]: jsonPid(10, T1, "/x/chorus.mjs daemon") },
      epermPids: new Set([10]),
      identities: { 10: { startedAt: T2, cmdline: "/usr/sbin/dockerd" } },
    });
    const r = stopDaemon(io);
    expect(r).toMatchObject({ stopped: false, pid: 10, reason: "stale-cleared" });
    expect(PID in io._files).toBe(false);
  });

  it("a real SIGTERM failure keeps the pidfile and names stop --force", () => {
    // Probe says running (identity matches), but the actual SIGTERM races into
    // EPERM. The pidfile must survive; the message must guide recovery.
    let killCalls = 0;
    const io = fakeIO({
      files: { [PID]: jsonPid(10, T1, "/x/chorus.mjs daemon") },
      identities: { 10: { startedAt: T1, cmdline: "/usr/bin/node /x/chorus.mjs daemon" } },
    });
    io.kill = (pid, sig) => {
      killCalls++;
      if (sig === 0) return true; // probe passes
      throw Object.assign(new Error("kill EPERM"), { code: "EPERM" });
    };
    const r = stopDaemon(io);
    expect(r).toMatchObject({ stopped: false, pid: 10, reason: "error" });
    expect(r.message).toMatch(/recycled by the OS/);
    expect(r.message).toMatch(/chorus daemon stop --force/);
    expect(PID in io._files).toBe(true); // pidfile intact
    expect(killCalls).toBe(2);
  });
});

describe("readLog", () => {
  it("returns content when the log exists", () => {
    const r = readLog(fakeIO({ files: { [LOG]: "hello log" } }));
    expect(r).toEqual({ ok: true, content: "hello log" });
  });
  it("reports clearly when no log file exists (no silent failure)", () => {
    const r = readLog(fakeIO({ files: {} }));
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/no log file/i);
  });
});
