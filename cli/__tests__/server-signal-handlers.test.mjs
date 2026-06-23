// cli/__tests__/server-signal-handlers.test.mjs
// Regression for the signal-handler leak: `chorus.mjs` used to register the
// server's SIGINT/SIGTERM/exit handlers UNCONDITIONALLY, so a `chorus daemon`
// process installed the server's `shutdown` (bare "Shutting down...", synchronous
// process.exit(0)) ahead of the daemon's own graceful handler. The guard lives in
// installServerSignalHandlers — this test drives it with a FAKE processRef so we can
// assert exactly which listeners get attached, without importing the side-effectful
// entry module and without delivering a real fatal signal to the test runner.
import { describe, it, expect, vi } from "vitest";
import { installServerSignalHandlers } from "../server-signal-handlers.mjs";

/** A minimal process-like recorder: captures every .on(event, fn) call. */
function fakeProcess() {
  const calls = [];
  return {
    calls,
    on(event, listener) {
      calls.push({ event, listener });
      return this;
    },
    /** events registered, in order */
    events() {
      return calls.map((c) => c.event);
    },
  };
}

describe("installServerSignalHandlers", () => {
  it("client subcommand (isSubcommand=true): registers ZERO handlers and returns false", () => {
    const proc = fakeProcess();
    const shutdown = vi.fn();
    const cleanupExit = vi.fn();

    const installed = installServerSignalHandlers({
      isSubcommand: true,
      processRef: proc,
      shutdown,
      cleanupExit,
    });

    expect(installed).toBe(false);
    expect(proc.calls).toHaveLength(0);
    expect(proc.events()).toEqual([]);
    // The handlers themselves are never invoked as a side effect of registration.
    expect(shutdown).not.toHaveBeenCalled();
    expect(cleanupExit).not.toHaveBeenCalled();
  });

  it("server path (isSubcommand=false): registers exactly SIGINT, SIGTERM, exit and returns true", () => {
    const proc = fakeProcess();
    const shutdown = vi.fn();
    const cleanupExit = vi.fn();

    const installed = installServerSignalHandlers({
      isSubcommand: false,
      processRef: proc,
      shutdown,
      cleanupExit,
    });

    expect(installed).toBe(true);
    expect(proc.events()).toEqual(["SIGINT", "SIGTERM", "exit"]);
    // SIGINT + SIGTERM are wired to `shutdown`; `exit` is wired to `cleanupExit`.
    const byEvent = Object.fromEntries(proc.calls.map((c) => [c.event, c.listener]));
    expect(byEvent.SIGINT).toBe(shutdown);
    expect(byEvent.SIGTERM).toBe(shutdown);
    expect(byEvent.exit).toBe(cleanupExit);
    // Registration must not invoke the listeners.
    expect(shutdown).not.toHaveBeenCalled();
    expect(cleanupExit).not.toHaveBeenCalled();
  });
});
