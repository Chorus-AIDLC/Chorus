# Design — confine server signal handlers to the server launch path

## Context

`chorus.mjs` is a dual-purpose entry: with no subcommand it launches the Next.js
server (embedded PGlite, migrations, etc.); with `daemon` / `login` it dispatches a
client subcommand. The two modes share one module body, separated by an
`isSubcommand` boolean.

Today the separation is incomplete. The relevant structure:

```js
const SUBCOMMANDS = new Set(["daemon", "login"]);

{
  const sub = process.argv[2];
  if (sub && SUBCOMMANDS.has(sub)) {
    runSubcommand(sub, process.argv.slice(3))
      .then((code) => process.exit(typeof code === "number" ? code : 0))
      .catch(...);
    // "Stop the server-launch module body from executing in this process tick."
    // ^ comment only — there is NO return/guard here.
  }
}

const isSubcommand = SUBCOMMANDS.has(process.argv[2]);

// ...server config + main()...

let pgliteProcess = null;
function shutdown() { ...; console.log("\nShutting down..."); ...process.exit(0); }
process.on("SIGINT", shutdown);     // ← runs even for `chorus daemon`
process.on("SIGTERM", shutdown);    // ← runs even for `chorus daemon`
process.on("exit", () => { if (pgliteProcess && !pgliteProcess.killed) pgliteProcess.kill("SIGKILL"); });

if (!isSubcommand) { main().catch(...); }   // main() IS guarded
```

`main()` is guarded by `!isSubcommand`; the three `process.on(...)` registrations are
not. So `chorus daemon` installs the server's `shutdown` as its first SIGINT/SIGTERM
listener. When a signal arrives, the server handler prints `Shutting down...`, finds
`pgliteProcess === null`, and calls `process.exit(0)` synchronously — pre-empting the
daemon's own graceful handler (registered later inside `runDaemon`, which does
`daemon.stop()` → SSE disconnect + MCP disconnect, logging `[Chorus] shutting down
daemon...`).

## Goals / Non-goals

- **Goal:** a `chorus daemon` (or `chorus login`) process must NOT register the server's
  signal handlers; only the daemon's own graceful handler should be active.
- **Goal:** the guard must be unit-testable without spawning a process or sending a real
  fatal signal.
- **Goal:** preserve server behavior exactly for the no-subcommand path.
- **Non-goal:** changing *why* signals arrive (operational — use `chorus daemon -d`).
- **Non-goal:** touching the daemon's own shutdown logic in `cli/daemon.mjs` (already
  correct).

## Decision

### 1. Guard via `!isSubcommand` (matches `main()`)

Wrap the three registrations in the same `!isSubcommand` condition that already guards
`main()`. Minimal, semantics-preserving, no change to top-level module execution order.
(Chosen over restructuring the dispatch block to `return`, which would require reordering
the whole module body and carries more risk.)

### 2. Extract a testable, injectable installer into its own side-effect-free module

Move the registration into a small function in a **dedicated module**
(`cli/server-signal-handlers.mjs`) so a unit test can drive it with a fake `process`-like
object and assert which listeners get attached — without sending a real SIGINT/SIGTERM to
the test runner:

```js
// cli/server-signal-handlers.mjs — pure, no top-level side effects.
export function installServerSignalHandlers({ isSubcommand, processRef, shutdown, cleanupExit }) {
  if (isSubcommand) return false;          // client subcommand → install nothing
  processRef.on("SIGINT", shutdown);
  processRef.on("SIGTERM", shutdown);
  processRef.on("exit", cleanupExit);
  return true;
}
```

Top-level call site in `chorus.mjs`:

```js
import { installServerSignalHandlers } from "./cli/server-signal-handlers.mjs";
// ...
installServerSignalHandlers({
  isSubcommand,
  processRef: process,
  shutdown,
  cleanupExit: () => { if (pgliteProcess && !pgliteProcess.killed) pgliteProcess.kill("SIGKILL"); },
});
```

**Why a separate module, not an `export` from `chorus.mjs`:** `chorus.mjs` is the CLI
entry and runs side effects at import (the subcommand dispatch at L70-82, server-config
parsing, etc.). In ES modules a named import cannot be loaded without first running the
target module's top-level body, so `import { installServerSignalHandlers } from
"../chorus.mjs"` would execute all of those side effects in the test runner. Housing the
function in a pure module lets the unit test import it in isolation and pass a fake
`processRef` (an object recording `.on(event, fn)` calls), with zero entry-module side
effects. This keeps the existing `isSubcommand`-dispatch + side-effect structure in
`chorus.mjs` untouched apart from swapping the three inline `process.on(...)` lines for the
one guarded call.

> Fallback if the extraction proves disruptive: keep the inline `if (!isSubcommand) {
> process.on(...) }` guard and assert the behavior with the spawn-based e2e test only. The
> injectable installer is preferred because it gives a fast, deterministic unit test.

### 3. Both `exit` and the fatal-signal handlers are guarded together

The `process.on("exit")` PGlite-cleanup is a no-op when `pgliteProcess === null` (always
true on the daemon path), so it is harmless — but it is pure noise there. Guarding all
three together keeps the rule simple and the intent obvious: *server-only handlers live
behind `!isSubcommand`.*

## Risks

- **Low.** The server path is unchanged: `isSubcommand` is `false`, so all three handlers
  install exactly as before. Verified by the e2e on the daemon path (graceful line, no bare
  `Shutting down...`) plus the unchanged server behavior.

## Test Plan

1. **Unit** (`installServerSignalHandlers`): with `isSubcommand=true`, a fake `processRef`
   records ZERO `.on()` calls and the function returns `false`; with `isSubcommand=false`,
   it records `SIGINT`, `SIGTERM`, `exit` and returns `true`.
2. **E2E** (real process): start an actual `chorus daemon` (local server + `.mcp.json`
   local key), wait for `daemon running`, send the PID `SIGTERM`, and assert the captured
   output contains `[Chorus] shutting down daemon...` (daemon graceful path) and does NOT
   contain a bare `Shutting down...` line (server path). This is the direct, root-cause
   discriminator from the elaboration.
