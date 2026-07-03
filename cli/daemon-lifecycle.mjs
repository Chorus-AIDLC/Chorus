// cli/daemon-lifecycle.mjs
// Background (`-d`) run + lifecycle subcommands (stop/status/restart/logs) for
// `chorus daemon`. Pure Node, cross-platform, NO native dependencies and NO
// `shell:true` — mirrors the platform-gated spawn approach in claude-spawner.mjs
// (POSIX detached process-group leader + unref + stdio→logfile; Windows
// windowsHide, no new console). All IO is injectable so both platform branches
// are unit-testable from a single host.
//
// State files live alongside the credentials in ~/.chorus:
//   pidfile  ~/.chorus/daemon.pid   (JSON {pid, startedAt?, argsHint?}; legacy
//                                    bare-number files from older CLIs still read)
//   logfile  ~/.chorus/daemon.log   (its redirected stdout+stderr)

import { spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** Default IO bundle — overridable per-call for tests (no real disk/process). */
function defaultIO() {
  return {
    existsSync,
    mkdirSync,
    openSync,
    readFileSync,
    unlinkSync,
    writeFileSync,
    spawn,
    spawnSync,
    // process.kill with signal 0 is the portable liveness probe (no signal sent).
    kill: (pid, sig) => process.kill(pid, sig),
    platform: process.platform,
    home: homedir(),
  };
}

/** ~/.chorus/daemon.pid */
export function pidFilePath(io = defaultIO()) {
  return join(io.home ?? homedir(), ".chorus", "daemon.pid");
}

/** ~/.chorus/daemon.log */
export function logFilePath(io = defaultIO()) {
  return join(io.home ?? homedir(), ".chorus", "daemon.log");
}

/**
 * The cmdline marker every legacy (pre-identity) chorus daemon carries — the
 * fallback identity check when the pidfile recorded no argsHint.
 */
const DAEMON_CMD_MARKER = "daemon";

/**
 * Read the recorded pidfile as a structured record, or null when absent /
 * unreadable / malformed. Two on-disk formats:
 *   - JSON `{pid, startedAt?, argsHint?}` (current — written by startBackground)
 *   - bare pid number (legacy — pre-identity CLIs) → `{ pid, legacy: true }`
 * @param {object} [io]
 * @returns {{ pid: number, startedAt?: string, argsHint?: string, legacy?: boolean }|null}
 */
export function readPidRecord(io = defaultIO()) {
  const path = pidFilePath(io);
  try {
    if (!io.existsSync(path)) return null;
    const raw = String(io.readFileSync(path, "utf8")).trim();
    if (raw.startsWith("{")) {
      const parsed = JSON.parse(raw);
      const pid = Number.parseInt(String(parsed.pid), 10);
      if (!Number.isInteger(pid) || pid <= 0) return null;
      const record = { pid };
      if (typeof parsed.startedAt === "string" && parsed.startedAt) record.startedAt = parsed.startedAt;
      if (typeof parsed.argsHint === "string" && parsed.argsHint) record.argsHint = parsed.argsHint;
      return record;
    }
    const pid = Number.parseInt(raw, 10);
    return Number.isInteger(pid) && pid > 0 ? { pid, legacy: true } : null;
  } catch {
    return null;
  }
}

/**
 * Read the recorded pid, or null when absent / unreadable / malformed.
 * Thin compatibility wrapper over readPidRecord.
 * @param {object} [io]
 * @returns {number|null}
 */
export function readPid(io = defaultIO()) {
  return readPidRecord(io)?.pid ?? null;
}

/**
 * Query the identity (command line + start time) of the process currently
 * occupying `pid`. One subprocess invocation, argument arrays only (no
 * `shell:true`), pure JS:
 *   - POSIX: `ps -p <pid> -o lstart=,args=` (lstart is second-resolution and
 *     stable across probes of the same process). busybox `ps` rejects `-o
 *     lstart` → retry `ps -o args= -p <pid>` for cmdline-only verification.
 *   - Windows: PowerShell `Get-CimInstance Win32_Process` (wmic is deprecated).
 * @param {number} pid @param {object} [io]
 * @returns {{ cmdline: string, startedAt: string|null }|null} null = query failed
 */
export function queryProcessIdentity(pid, io = defaultIO()) {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    if (io.platform === "win32") {
      const r = io.spawnSync(
        "powershell",
        [
          "-NoProfile",
          "-Command",
          `Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}' | Select-Object CommandLine,CreationDate | ConvertTo-Json`,
        ],
        { encoding: "utf8", windowsHide: true }
      );
      if (!r || r.status !== 0 || !r.stdout) return null;
      const parsed = JSON.parse(r.stdout);
      if (!parsed || typeof parsed.CommandLine !== "string") return null;
      return { cmdline: parsed.CommandLine, startedAt: parsed.CreationDate ? String(parsed.CreationDate) : null };
    }
    // POSIX: lstart= + args= in one call. Output shape (no headers):
    //   "Thu Jul  2 21:22:55 2026 /usr/bin/node /x/chorus.mjs daemon"
    // lstart is a fixed 5-field prefix (dow mon dd hh:mm:ss yyyy).
    const full = io.spawnSync("ps", ["-p", String(pid), "-o", "lstart=,args="], { encoding: "utf8" });
    if (full && full.status === 0 && full.stdout && full.stdout.trim()) {
      const line = full.stdout.trim();
      const fields = line.split(/\s+/);
      if (fields.length >= 6) {
        const startedAt = fields.slice(0, 5).join(" ");
        const cmdline = fields.slice(5).join(" ");
        if (cmdline) return { cmdline, startedAt };
      }
    }
    // busybox fallback: busybox ps rejects -p AND -o lstart (it only knows -o
    // and -T), so list every process as "pid args" and filter by the pid
    // column ourselves. Cmdline verification still possible; no start time.
    const argsOnly = io.spawnSync("ps", ["-o", "pid=,args="], { encoding: "utf8" });
    if (argsOnly && argsOnly.status === 0 && argsOnly.stdout) {
      for (const line of argsOnly.stdout.split("\n")) {
        const m = line.trim().match(/^(\d+)\s+(.+)$/);
        if (m && Number.parseInt(m[1], 10) === pid) {
          return { cmdline: m[2].trim(), startedAt: null };
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Is the process recorded by `record` still OUR live daemon? Identity-verified
 * probe (fix-daemon-stale-pid-identity): pid existence alone is not enough —
 * after a reboot the OS recycles pids, and a foreign owner surfaces as EPERM,
 * which the old probe misread as "daemon alive". Decision table (tech design):
 *   - ESRCH / invalid pid                → false (stale)
 *   - pid exists (OK or EPERM):
 *       identity recorded    → startedAt (when recorded) AND cmdline must match;
 *                              any mismatch → false; query failed → true (never
 *                              auto-clean an identity we could not verify)
 *       legacy record        → cmdline contains the daemon marker → true;
 *                              foreign cmdline → false; query failed → EPERM
 *                              proves it is not ours (same-user daemon) → false,
 *                              while a signalable pid stays conservatively true
 * Accepts a bare pid (number) for backward compatibility → treated as legacy.
 * @param {number|{pid:number,startedAt?:string,argsHint?:string,legacy?:boolean}} record
 * @param {object} [io]
 */
export function processAlive(record, io = defaultIO()) {
  const rec = typeof record === "number" ? { pid: record, legacy: true } : record;
  if (!rec || !Number.isInteger(rec.pid) || rec.pid <= 0) return false;
  let eperm = false;
  try {
    io.kill(rec.pid, 0);
  } catch (err) {
    if (!err || err.code !== "EPERM") return false;
    eperm = true;
  }
  // The pid exists. Verify the occupant is still our daemon.
  const identity = queryProcessIdentity(rec.pid, io);
  const hasRecordedIdentity = Boolean(rec.startedAt || rec.argsHint);
  if (hasRecordedIdentity) {
    if (identity === null) return true; // unverifiable → conservative: running
    // Collapse whitespace on both sides: the ps parse re-joins fields with
    // single spaces, so an argsHint containing consecutive spaces must not
    // read as a mismatch (false-stale is the dangerous direction).
    const liveCmd = identity.cmdline.replace(/\s+/g, " ");
    const hint = rec.argsHint ? rec.argsHint.replace(/\s+/g, " ") : null;
    if (hint && !liveCmd.includes(hint)) return false;
    if (rec.startedAt && identity.startedAt !== null && identity.startedAt !== rec.startedAt) return false;
    return true;
  }
  // Legacy record (no identity metadata): cmdline-marker fallback.
  if (identity === null) {
    // EPERM on a legacy record already proves the process belongs to another
    // user — the CLI and daemon always run as the same user (q3=a self-heal,
    // covers busybox systems where ps cannot report identity).
    return !eperm;
  }
  return identity.cmdline.includes(DAEMON_CMD_MARKER);
}

/**
 * Current daemon status from the pidfile.
 * @param {object} [io]
 * @returns {{ running: boolean, pid: number|null, stale: boolean }}
 *   `stale` = a pidfile exists but its pid is dead OR its identity no longer
 *   matches (pid recycled after a reboot / crash).
 */
export function isRunning(io = defaultIO()) {
  const record = readPidRecord(io);
  if (record == null) return { running: false, pid: null, stale: false };
  const alive = processAlive(record, io);
  return { running: alive, pid: record.pid, stale: !alive };
}

/** Ensure ~/.chorus exists for the pid/log files. */
function ensureDir(path, io) {
  io.mkdirSync(dirname(path), { recursive: true });
}

/**
 * Spawn the daemon DETACHED in the background. The caller has already completed
 * any interactive preflight (credential completion + yolo confirm) in the
 * foreground, so the child starts non-interactively. stdout+stderr are
 * redirected to the logfile; the child pid is written to the pidfile; the child
 * is unref'd so the parent can exit.
 *
 * Refuses to start a second daemon when a live pid is already recorded (returns
 * `{ started:false, alreadyRunning:true, pid }`). A stale pidfile (dead pid) is
 * overwritten.
 *
 * @param {{ nodePath: string, args: string[], env?: Record<string,string|undefined>, cwd?: string }} spec
 *   `nodePath` (e.g. process.execPath) runs `args` (e.g. ["/path/chorus.mjs","daemon",...]
 *   WITHOUT `-d`). The env should carry the detached marker so the child skips preflight.
 * @param {object} [io]
 * @returns {{ started: boolean, pid?: number, alreadyRunning?: boolean, logFile: string, pidFile: string }}
 */
export function startBackground(spec, io = defaultIO()) {
  const pidFile = pidFilePath(io);
  const logFile = logFilePath(io);

  const status = isRunning(io);
  if (status.running) {
    return { started: false, alreadyRunning: true, pid: status.pid, logFile, pidFile };
  }

  ensureDir(logFile, io);
  // Append so restarts keep history; the child owns the fd after spawn.
  const out = io.openSync(logFile, "a");

  const child = io.spawn(spec.nodePath, spec.args, {
    cwd: spec.cwd ?? process.cwd(),
    env: { ...(spec.env ?? {}) },
    // POSIX: detached:true makes the child a process-group leader so it survives
    // the parent and the controlling terminal closing. Windows: detached spawns
    // its own process group too; windowsHide prevents a new console window.
    detached: true,
    windowsHide: true,
    // No stdin; stdout+stderr → the logfile fd. shell:false (default) — no shell
    // word-splitting / injection surface (args is an array).
    stdio: ["ignore", out, out],
  });

  // Let the parent exit without waiting on the child (POSIX + Windows).
  child.unref?.();

  // Record the child's IDENTITY alongside its pid so later probes can tell
  // "our daemon" from "a reboot-recycled pid" (fix-daemon-stale-pid-identity).
  // argsHint: a distinguishing substring of the spawned command line. startedAt:
  // the same query the probe uses (string-equality comparison, no clock math);
  // a failed post-spawn query degrades to a record without startedAt.
  const record = { pid: child.pid };
  const argsHint = (spec.args ?? []).join(" ").trim();
  if (argsHint) record.argsHint = argsHint;
  const identity = queryProcessIdentity(child.pid, io);
  if (identity?.startedAt) record.startedAt = identity.startedAt;

  ensureDir(pidFile, io);
  io.writeFileSync(pidFile, `${JSON.stringify(record)}\n`, { mode: 0o600 });
  return { started: true, pid: child.pid, logFile, pidFile };
}

/**
 * Stop the recorded background daemon: signal it, then remove the pidfile.
 * @param {object} [io]
 * @returns {{ stopped: boolean, pid: number|null, reason: "stopped"|"not-running"|"stale-cleared"|"error", message: string }}
 */
export function stopDaemon(io = defaultIO()) {
  const pidFile = pidFilePath(io);
  const status = isRunning(io);
  if (status.pid == null) {
    return { stopped: false, pid: null, reason: "not-running", message: "no daemon is running (no pidfile)" };
  }
  if (!status.running) {
    // Stale pidfile — clean it up, report clearly (no silent failure).
    try { io.unlinkSync(pidFile); } catch { /* best-effort */ }
    return { stopped: false, pid: status.pid, reason: "stale-cleared", message: `no live daemon (cleared stale pidfile for pid ${status.pid})` };
  }
  try {
    io.kill(status.pid, "SIGTERM");
  } catch (err) {
    // Keep the pidfile: deleting a record we could not act on risks orphaning a
    // genuinely live daemon. The message names the recovery path instead.
    return {
      stopped: false,
      pid: status.pid,
      reason: "error",
      message:
        `failed to signal pid ${status.pid}: ${err instanceof Error ? err.message : String(err)}` +
        ` — the pid may have been recycled by the OS; if you are sure no daemon is running: chorus daemon stop --force`,
    };
  }
  try { io.unlinkSync(pidFile); } catch { /* best-effort */ }
  return { stopped: true, pid: status.pid, reason: "stopped", message: `stopped daemon (pid ${status.pid})` };
}

/**
 * Read the daemon logfile contents (for `chorus daemon logs`).
 * @param {object} [io]
 * @returns {{ ok: boolean, content?: string, message?: string }}
 */
export function readLog(io = defaultIO()) {
  const logFile = logFilePath(io);
  try {
    if (!io.existsSync(logFile)) return { ok: false, message: `no log file at ${logFile}` };
    return { ok: true, content: io.readFileSync(logFile, "utf8") };
  } catch (err) {
    return { ok: false, message: `could not read ${logFile}: ${err instanceof Error ? err.message : String(err)}` };
  }
}
