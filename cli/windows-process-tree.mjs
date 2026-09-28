// Windows has no POSIX process groups. Capture PID + creation-time identities
// before closing the backend, then inspect surviving descendants after exit.
import { spawn } from "node:child_process";

const SNAPSHOT_SCRIPT = "$ErrorActionPreference='Stop'; $ChorusProcesses=@(Get-CimInstance Win32_Process | Where-Object { $_.ProcessId -gt 0 -and $_.CreationDate } | ForEach-Object { @{pid=[int]$_.ProcessId; parentPid=[int]$_.ParentProcessId; startedAt=$_.CreationDate.ToUniversalTime().ToString('o')} }); ConvertTo-Json -InputObject $ChorusProcesses -Compress";
const MAX_OUTPUT_BYTES = 4 * 1024 * 1024;
const exited = child => child.exitCode != null || Boolean(child.signalCode);
const same = (a, b) => a && b && a.pid === b.pid && a.startedAt === b.startedAt;

/** Fixed system commands only; output, helpers and listeners share one deadline. */
async function command(command, args, { deadline, spawnImpl = spawn, capture = false }) {
  if (Date.now() >= deadline) throw new Error("WINDOWS_CLEANUP_TIMEOUT");
  return new Promise((resolve, reject) => {
    let child, timer, settled = false, bytes = 0;
    const chunks = [];
    const finish = (error, code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child?.stdout?.removeListener("data", onData);
      child?.removeListener("exit", onExit);
      if (error) {
        try { child?.kill?.("SIGKILL"); } catch {}
        reject(new Error("WINDOWS_CLEANUP_COMMAND_FAILED"));
      } else resolve({ code, output: Buffer.concat(chunks).toString("utf8") });
    };
    const onData = chunk => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) return finish(true);
      chunks.push(Buffer.from(chunk));
    };
    const onError = () => finish(true);
    const onExit = code => {
      // Queries need close to drain stdout. taskkill does not capture output.
      if (!capture) finish(false, code);
    };
    const onClose = code => {
      finish(false, code);
      child?.removeListener("error", onError);
      child?.stdout?.removeListener("error", onError);
    };
    try {
      child = spawnImpl(command, args, { stdio: ["ignore", capture ? "pipe" : "ignore", "ignore"], windowsHide: true, shell: false });
      child.on("error", onError);
      child.once("exit", onExit);
      child.once("close", onClose);
      child.stdout?.on("error", onError);
      if (capture) child.stdout?.on("data", onData);
      timer = setTimeout(() => finish(true), Math.max(0, deadline - Date.now()));
    } catch { finish(true); }
  });
}

export async function readWindowsProcessSnapshot(options) {
  const { code, output } = await command("powershell.exe",
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", SNAPSHOT_SCRIPT],
    { ...options, capture: true });
  if (code !== 0) throw new Error("WINDOWS_PROCESS_QUERY_FAILED");
  let parsed;
  try { parsed = JSON.parse(output.replace(/^\uFEFF/, "")); }
  catch { throw new Error("WINDOWS_PROCESS_QUERY_INVALID"); }
  const records = Array.isArray(parsed) ? parsed : [parsed];
  if (records.length > 100_000) throw new Error("WINDOWS_PROCESS_QUERY_INVALID");
  const seen = new Set();
  for (const r of records) {
    if (!r || !Number.isSafeInteger(r.pid) || r.pid < 0 ||
        !Number.isSafeInteger(r.parentPid) || r.parentPid < 0 ||
        typeof r.startedAt !== "string" || !Number.isFinite(Date.parse(r.startedAt)) ||
        seen.has(r.pid)) throw new Error("WINDOWS_PROCESS_QUERY_INVALID");
    seen.add(r.pid);
  }
  return records;
}

export class WindowsProcessTree {
  constructor(child, { deadline, spawnImpl, snapshotImpl = readWindowsProcessSnapshot } = {}) {
    this.child = child;
    this.options = { deadline, spawnImpl };
    this.snapshot = () => snapshotImpl(this.options);
    this.owned = new Map();
    this.capturePromise = null;
    this.captureFailed = false;
    this.escalated = false;
  }

  capture() {
    return this.capturePromise ??= (async () => {
      try {
        const wasRunning = !exited(this.child);
        const records = await this.snapshot();
        const root = records.find(r => r.pid === this.child.pid);
        // A PID found after our ChildProcess has exited belongs to someone else.
        if (root && !exited(this.child)) this.owned.set(root.pid, root);
        else if (wasRunning) this.captureFailed = true;
        else if (!root && records.some(r => r.parentPid === this.child.pid)) {
          // No trustworthy root identity: do not guess ownership or kill.
          this.captureFailed = true;
        }
        this.expand(records);
      } catch { this.captureFailed = true; }
    })();
  }

  expand(records) {
    const current = new Map(records.map(r => [r.pid, r]));
    let changed;
    do {
      changed = false;
      for (const record of records) {
        if (this.owned.has(record.pid)) continue;
        const parent = this.owned.get(record.parentPid);
        // Retain ancestry through a departed parent, but never through a reused
        // PID. Creation ordering also rejects an older, unrelated process.
        if (parent && (!current.has(parent.pid) || same(parent, current.get(parent.pid))) &&
            Date.parse(record.startedAt) >= Date.parse(parent.startedAt)) {
          this.owned.set(record.pid, record); changed = true;
        }
      }
    } while (changed);
    return records.filter(r => same(r, this.owned.get(r.pid)));
  }

  async cleanup() {
    await this.capture();
    try {
      let living = this.expand(await this.snapshot());
      if (this.captureFailed) throw new Error("WINDOWS_TREE_UNCERTAIN");
      if (!living.length) return { cleanupFailed: false, escalated: false };
      // Target each surviving identity, including children whose root exited.
      // Re-read before each taskkill to avoid killing a known reused PID.
      for (const candidate of living) {
        const fresh = await this.snapshot();
        const actual = fresh.find(r => r.pid === candidate.pid);
        this.expand(fresh);
        if (!same(candidate, actual)) continue;
        try {
          this.escalated = true;
          await command("taskkill", ["/PID", String(candidate.pid), "/T", "/F"], this.options);
        } catch {
          // A process can disappear during taskkill. Only the final identity
          // probe distinguishes that race from a genuine termination failure.
        }
      }
      living = this.expand(await this.snapshot());
      if (living.length) throw new Error("WINDOWS_TREE_REMAINS");
      return { cleanupFailed: false, escalated: true };
    } catch {
      // Still try to stop the exact ChildProcess if it has not exited. No
      // unverified numeric PID is targeted on this failure path.
      if (!exited(this.child)) { try { this.child.kill?.("SIGKILL"); } catch {} }
      return { cleanupFailed: true, escalated: this.escalated };
    }
  }
}
