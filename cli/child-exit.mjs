// cli/child-exit.mjs
// One shared settlement path for every spawner's child process, so the five
// backends (pi / claude / codex / kiro / dsh) cannot drift on "when is the wake
// over?".
//
// WHY THIS EXISTS — `close` is not the same event as "the agent finished".
// Node emits `exit` when the child process itself is reaped, but `close` only
// once every stdio stream the child was given has been closed. A child that
// leaves a DETACHED DESCENDANT behind (a backgrounded server, a `nohup`'d
// helper) hands that descendant the SAME inherited pipes, so the pipes stay
// open after the child is long gone and `close` may never fire. A spawner that
// waits only for `close` therefore keeps reporting a finished wake as still
// `running` — the phantom `running` turn. Settling on `exit` fixes that.
//
// !!! THE GRACE IS NOT A WAKE TIMEOUT AND NOT A WATCHDOG !!!
// `stdioGraceMs` only starts counting AFTER the child process has ALREADY
// EXITED, and it bounds one thing only: how long we wait for that dead
// process's pipes to drain so a final stdout chunk is still parsed. It places
// no limit whatsoever on how long an agent may run — a wake that runs for
// hours is never interrupted, cancelled or "timed out" by this module. No
// wake-duration limit is introduced anywhere here; do not repurpose this timer
// into one.

/** Grace for an already-exited process's pipes to drain. NOT a wake timeout. */
export const DEFAULT_STDIO_GRACE_MS = 2000;

/**
 * Resolve once with the child's exit code as soon as the process is KNOWN to be gone.
 *
 *  • `close` first  → resolve immediately (today's behaviour, zero regression).
 *  • `exit` first   → wait up to `stdioGraceMs` for `close` (so a last stdout chunk
 *                     is still parsed), then resolve with the exit code anyway.
 *
 * Settles exactly once and NEVER rejects. The grace timer is `unref`'d so it can
 * never hold the daemon's event loop open.
 *
 * @param {import("node:child_process").ChildProcess} child
 * @param {{ stdioGraceMs?: number, logger?: { warn?: (msg: string) => void }, label?: string }} [options]
 * @returns {Promise<number | null>} the exit code (`null` when the child was signalled)
 */
export function awaitChildSettled(child, options = {}) {
  const { stdioGraceMs = DEFAULT_STDIO_GRACE_MS, logger, label = "child" } = options;

  return new Promise((resolve) => {
    let settled = false;
    let timer = null;

    const settle = (code) => {
      if (settled) return;
      settled = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      resolve(code ?? null);
    };

    child.on?.("close", (code) => settle(code));

    child.on?.("exit", (code) => {
      if (settled || timer) return;
      // The process is gone; give its (possibly descendant-held) pipes a bounded
      // moment to drain, then settle regardless. See the header: not a timeout.
      timer = setTimeout(() => {
        timer = null;
        if (settled) return;
        logger?.warn?.(
          `[Chorus] ${label} exited (code ${code ?? null}) but stdio stayed open for ` +
            `${stdioGraceMs}ms; settling on exit`
        );
        settle(code);
      }, stdioGraceMs);
      // Never keep the daemon's event loop alive for a dead process's pipes.
      timer?.unref?.();
    });
  });
}
