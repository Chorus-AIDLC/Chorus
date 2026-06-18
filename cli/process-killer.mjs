// cli/process-killer.mjs
// Two-stage, cross-platform process-tree killer for the daemon's reverse control
// channel (子3 — daemon-interrupt-resume, Tech Design "Killer contract"). When an
// authorized interrupt is verified, the daemon must STOP a running headless-Claude
// subprocess — first gracefully (SIGINT, so the model can flush in-progress work),
// then forcefully if it does not exit within a configurable window. Plain ESM, ZERO
// new npm deps (CLAUDE.md pitfall #9) and Bash-3.2-safe (no shell touched).
//
// Why a process TREE, not just the direct child:
//   • POSIX: Claude may itself spawn children. Linux does NOT cascade a signal to a
//     parent's children (Node docs: "On Linux, child processes of child processes
//     will not be terminated when attempting to kill their parent"). So the daemon
//     spawns the child `detached: true` — which makes it a PROCESS GROUP LEADER
//     (its pgid === its pid) — and we signal the whole GROUP via the negative-pid
//     form `process.kill(-pid, sig)`. That reaches every descendant in the group.
//   • Windows: there is no per-tree signal. We escalate with the platform
//     `taskkill /PID <pid> /T /F` command — `/T` ends the process AND its child
//     processes (the tree), `/F` forces termination. Verified against Microsoft
//     Learn's taskkill reference. The graceful stage is best-effort `child.kill()`
//     on the direct process only (Node delivers SIGINT to the child on Windows; the
//     signal cannot reach a tree there). The Windows path is NOT runtime-verifiable
//     in this (POSIX) environment — re-verify on a real Windows host before claiming
//     Windows support.
//
// Contract (Tech Design): killProcessTree(child, { sigintTimeoutMs, platform,
// logger, spawnImpl, nowKill }) → Promise<{ killed, escalated, signaled }>. It is
// pure-ish (platform + spawn injectable for tests), NEVER throws into the wake path
// (every signal/spawn is try/caught), and LOGS visibly (memory: no-silent-errors).

import { spawn as nodeSpawn } from "node:child_process";

const NOOP_LOGGER = { info() {}, warn() {}, error() {} };

/** Default escalation window before a forceful kill (Tech Design / spec: 10s). */
export const DEFAULT_SIGINT_TIMEOUT_MS = 10_000;

/**
 * Send SIGINT to a POSIX child's PROCESS GROUP (negative pid). The child must have
 * been spawned `detached: true` so it leads its own group and the group kill reaches
 * grandchildren. Returns true iff the signal was delivered without throwing.
 * @param {number} pid
 * @param {string} signal  "SIGINT" | "SIGKILL"
 * @param {(pid: number, signal: string) => void} killImpl  injectable process.kill
 * @param {{warn(m:string):void}} logger
 * @returns {boolean}
 */
function signalGroup(pid, signal, killImpl, logger) {
  try {
    // Negative pid → signal the entire process group led by `pid`. This is the
    // POSIX semantics process.kill(2) implements; Node forwards it verbatim.
    killImpl(-pid, signal);
    return true;
  } catch (err) {
    // ESRCH (already gone) is the common, benign case after a graceful exit; any
    // other error (e.g. EPERM) is logged but never thrown — the wake path must not
    // crash because a stop signal failed.
    logger.warn(`[Chorus] kill(-${pid}, ${signal}) failed: ${err}`);
    return false;
  }
}

/**
 * Two-stage stop of a running subprocess TREE. Never throws.
 *
 * Stage 1 (graceful): SIGINT.
 *   • POSIX: `process.kill(-pid, "SIGINT")` — the whole group.
 *   • Windows: best-effort `child.kill("SIGINT")` on the direct process (no tree
 *     signal exists; taskkill below is the tree-reaching escalation).
 * Then wait up to `sigintTimeoutMs` for the child to exit (resolved via the child's
 * own 'exit'/'close' — the caller observes that and aborts our timer by resolving
 * early through `child.exitObserved`). If the child has not exited when the timer
 * fires:
 * Stage 2 (forceful):
 *   • POSIX: `process.kill(-pid, "SIGKILL")` — the whole group.
 *   • Windows: spawn `taskkill /PID <pid> /T /F`.
 *
 * @param {{ pid?: number, killed?: boolean, kill?: Function, once?: Function, on?: Function }} child
 *   The live ChildProcess (or a test double). `pid` MUST be present to target a tree.
 * @param {{
 *   sigintTimeoutMs?: number,
 *   platform?: NodeJS.Platform,
 *   logger?: { info(m:string):void, warn(m:string):void, error(m:string):void },
 *   killImpl?: (pid: number, signal: string) => void,  Injectable process.kill (POSIX group signal).
 *   spawnImpl?: typeof nodeSpawn,                       Injectable spawn (Windows taskkill).
 *   hasExited?: () => boolean,                          Probe: has the child already exited?
 *   waitForExit?: (ms: number) => Promise<boolean>,     Resolve true if child exits within ms, else false.
 * }} [opts]
 * @returns {Promise<{ signaled: boolean, killed: boolean, escalated: boolean }>}
 *   signaled: the graceful SIGINT was delivered.
 *   escalated: a forceful kill was issued (child did not exit within the window).
 *   killed: a stop action (graceful or forceful) was issued at all.
 */
export async function killProcessTree(child, opts = {}) {
  const platform = opts.platform ?? process.platform;
  const logger = opts.logger ?? NOOP_LOGGER;
  const killImpl = opts.killImpl ?? ((pid, signal) => process.kill(pid, signal));
  const spawnImpl = opts.spawnImpl ?? nodeSpawn;
  const sigintTimeoutMs = opts.sigintTimeoutMs ?? DEFAULT_SIGINT_TIMEOUT_MS;
  const isWin = platform === "win32";

  if (!child || typeof child.pid !== "number") {
    // No live process to target — log and no-op (never throw into the wake path).
    logger.warn("[Chorus] killProcessTree: no child pid to target; ignoring");
    return { signaled: false, killed: false, escalated: false };
  }
  const pid = child.pid;

  // --- Stage 1: graceful SIGINT ---
  let signaled;
  if (isWin) {
    // Windows: deliver SIGINT to the direct child only (best-effort). Node maps
    // SIGINT to a console-stop on Windows; it cannot reach a tree there.
    try {
      signaled = child.kill?.("SIGINT") ?? false;
    } catch (err) {
      logger.warn(`[Chorus] child.kill("SIGINT") failed: ${err}`);
      signaled = false;
    }
    logger.info(`[Chorus] interrupt: sent SIGINT to pid ${pid} (windows, direct child)`);
  } else {
    signaled = signalGroup(pid, "SIGINT", killImpl, logger);
    logger.info(`[Chorus] interrupt: sent SIGINT to process group -${pid} (posix)`);
  }

  // --- Wait for graceful exit within the window ---
  const exitedGracefully = await waitForChildExit(child, sigintTimeoutMs, opts, logger);
  if (exitedGracefully) {
    logger.info(`[Chorus] interrupt: pid ${pid} exited gracefully within ${sigintTimeoutMs}ms`);
    return { signaled, killed: true, escalated: false };
  }

  // --- Stage 2: forceful tree kill ---
  if (isWin) {
    // taskkill /PID <pid> /T /F — /T ends the tree (child processes), /F forces it.
    try {
      const tk = spawnImpl("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      // taskkill failures are logged, never thrown.
      tk?.on?.("error", (err) => logger.warn(`[Chorus] taskkill spawn error: ${err}`));
      logger.info(`[Chorus] interrupt: escalated — taskkill /PID ${pid} /T /F (windows)`);
    } catch (err) {
      logger.warn(`[Chorus] taskkill escalation failed for pid ${pid}: ${err}`);
    }
  } else {
    signalGroup(pid, "SIGKILL", killImpl, logger);
    logger.info(`[Chorus] interrupt: escalated — SIGKILL to process group -${pid} (posix)`);
  }
  return { signaled, killed: true, escalated: true };
}

/**
 * Resolve true if the child exits within `ms`, else false (timeout). Prefers an
 * injected `waitForExit` (tests); otherwise races the child's own 'exit' event
 * against a timer, with an immediate short-circuit if it has already exited.
 * Never throws.
 */
async function waitForChildExit(child, ms, opts, logger) {
  if (typeof opts.waitForExit === "function") {
    try {
      return await opts.waitForExit(ms);
    } catch (err) {
      logger.warn(`[Chorus] waitForExit probe failed: ${err}`);
      return false;
    }
  }
  // Already exited? (Node sets child.killed after a delivered signal, but exitCode/
  // signalCode is the authoritative "has terminated" probe.)
  const hasExited =
    typeof opts.hasExited === "function"
      ? safeBool(opts.hasExited, logger)
      : child.exitCode !== null && child.exitCode !== undefined;
  if (hasExited) return true;

  return await new Promise((resolve) => {
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => finish(false), ms);
    // unref so a pending timer never keeps the daemon process alive on shutdown.
    timer?.unref?.();
    try {
      child.once?.("exit", () => finish(true));
      child.once?.("close", () => finish(true));
    } catch (err) {
      logger.warn(`[Chorus] failed to attach exit listener: ${err}`);
      finish(false);
    }
  });
}

/** Run a boolean probe, treating a throw as false (never propagate). */
function safeBool(fn, logger) {
  try {
    return Boolean(fn());
  } catch (err) {
    logger.warn(`[Chorus] hasExited probe threw: ${err}`);
    return false;
  }
}
