# Fix: server signal handlers leak into the `chorus daemon` subcommand path

## Why

Users report that `chorus daemon` "keeps disconnecting on its own." The daemon log
ends with a bare line — **`Shutting down...`** with no `[Chorus]` prefix — right after
a wake completed:

```
[Chorus] ✓ wake done: daemon_session:787e4680-... (exit=0, 904374ms)
[Chorus] execution-state uploaded (0 active)

Shutting down...
```

That exact string `Shutting down...` is emitted by **exactly one** place in the
codebase: `chorus.mjs`'s **server** shutdown handler. The daemon's own handler logs
`[Chorus] shutting down daemon...` instead. So the log proves the process received a
SIGINT/SIGTERM and the **wrong handler** (the server's) ran.

Root cause: `chorus.mjs` dispatches the `daemon` / `login` subcommands asynchronously
at the top of the module, with a comment claiming this "stops the server-launch module
body from executing." But nothing actually stops it — there is no `return`/guard, so
the rest of the module body keeps running. `main()` is correctly guarded by
`if (!isSubcommand)`, **but the `process.on("SIGINT"|"SIGTERM"|"exit")` registrations
are NOT.** So a `chorus daemon` process ends up with TWO competing signal dispositions:

1. the **server's** handler (registered first, synchronously) → prints `Shutting
   down...`, sees `pgliteProcess === null` (a daemon never starts PGlite) → calls
   `process.exit(0)` **immediately**;
2. the **daemon's** handler (registered later, async inside `runDaemon`) → would run a
   graceful `daemon.stop()` (SSE disconnect + MCP disconnect).

Node runs listeners in registration order; #1's synchronous `process.exit(0)` halts the
process before #2 ever runs. Consequences: the daemon never disconnects gracefully (so
the server shows it online — stale presence — for a while), and the shutdown message is
misleading (looks like a server / PGlite shutdown).

## What Changes

- Guard the server-only signal handlers (`SIGINT`, `SIGTERM`, and the `exit` PGlite
  SIGKILL cleanup) behind `!isSubcommand`, exactly as `main()` is already guarded — so a
  `chorus daemon` (or `chorus login`) process registers ONLY the daemon's own graceful
  handler.
- Extract the registration into a small injectable function so the guard is unit-testable
  without spawning a process or actually killing one.
- Add a unit test asserting the server handlers are NOT installed on the subcommand path
  (and ARE on the server path).
- Add a real end-to-end test: start an actual `chorus daemon`, send it SIGTERM, and assert
  the log shows the daemon's graceful line (`[Chorus] shutting down daemon...`) and NOT
  the server's bare `Shutting down...`.

## Capabilities

- **cli-daemon** — adds a normative requirement that the server's process-signal handlers
  are confined to the server launch path and never installed for a client subcommand, so a
  `chorus daemon` process shuts down via its own graceful path.

## Impact

- Affected code: `chorus.mjs` (swaps the three inline `process.on(...)` registrations for
  one guarded call), a new pure module `cli/server-signal-handlers.mjs` holding the
  injectable installer, a new unit test for that installer, and a new daemon-shutdown e2e
  test.
- No behavior change for `chorus` with no subcommand (the server) — it still installs the
  same handlers and shuts down identically.
- No schema, API, or dependency changes. Out of scope: *why* a signal arrives (foreground
  daemon, a co-located agent running `kill`/`pkill`, terminal Ctrl+C). That is an
  operational concern — run `chorus daemon -d` (detached) — not a code bug.
