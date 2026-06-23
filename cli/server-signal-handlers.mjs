// cli/server-signal-handlers.mjs
// The Chorus CLI entry (`chorus.mjs`) is dual-purpose: with no subcommand it
// launches the embedded Next.js server (with a PGlite child); with `daemon` /
// `login` it dispatches a client subcommand that connects OUT to a remote
// server. The server-launch path installs three process-signal handlers — a
// SIGINT/SIGTERM graceful-shutdown handler and an `exit` handler that
// force-kills the PGlite child — but those are MEANINGLESS (and actively
// harmful) on a client-subcommand process: a `chorus daemon` never starts
// PGlite, and the server's SIGINT/SIGTERM handler would otherwise pre-empt the
// daemon's OWN graceful shutdown (it runs first, in registration order, and
// calls `process.exit(0)` synchronously). See the idea / design docs.
//
// This module is intentionally PURE — it runs no side effects at import — so a
// unit test can import the function in isolation and drive it with a fake
// `process`-like object, without executing `chorus.mjs`'s import-time side
// effects (subcommand dispatch, server-config parsing) and without delivering a
// real fatal signal to the test runner.

/**
 * Install the server-only process-signal handlers, but ONLY for the server
 * launch path (no client subcommand). When invoked as a client subcommand
 * (`chorus daemon` / `chorus login`), this registers NOTHING and returns false,
 * so the process terminates exclusively through the subcommand's own handler
 * (e.g. the daemon's graceful `daemon.stop()`).
 *
 * @param {object} params
 * @param {boolean} params.isSubcommand  true when a client subcommand is running.
 * @param {{ on(event: string, listener: (...args: any[]) => void): unknown }} params.processRef
 *   the process to attach listeners to (real `process`, or a fake in tests).
 * @param {(...args: any[]) => void} params.shutdown    SIGINT/SIGTERM handler.
 * @param {(...args: any[]) => void} params.cleanupExit `exit` handler (PGlite SIGKILL).
 * @returns {boolean} true if the server handlers were installed, false if skipped.
 */
export function installServerSignalHandlers({ isSubcommand, processRef, shutdown, cleanupExit }) {
  // Client subcommand → install none of the server's signal handlers.
  if (isSubcommand) return false;
  processRef.on("SIGINT", shutdown);
  processRef.on("SIGTERM", shutdown);
  processRef.on("exit", cleanupExit);
  return true;
}
