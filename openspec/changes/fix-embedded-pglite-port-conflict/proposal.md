## Why

A first-time user who runs `chorus` after a global install can hit Prisma **P1000** ("Authentication failed against database server, the provided credentials for `postgres` are not valid") — an out-of-the-box CLI should never require the user to supply their own Postgres. This was reported as GitHub #379 and **reproduced on real hardware** via two paths:

- **Path A (port occupied):** the embedded PGlite is forked on a hardcoded port (default 5433). If a *real* Postgres already listens there, the forked PGlite child dies of `EADDRINUSE` — but it **exits with code 0** (it catches the error and shuts down cleanly), and its output is swallowed by `stdio: "ignore"`. The current `.on("error")` handler only catches *spawn* failure, so nothing is caught. `waitForTcp` then probes only "is *someone* listening?" — the foreign Postgres is — so it prints a misleading **`PGlite ready`**, sets `DATABASE_URL=postgres:postgres@localhost:5433`, and the next step (`prisma migrate deploy`) hands the wrong credentials to the foreign DB → **P1000**.
- **Path B (residual env):** if the user's shell already exports `DATABASE_URL` (common on developer machines), embedded PGlite is skipped entirely and Chorus connects straight to that DB; wrong credentials → **P1000**.

Correction over the original report: P1000 surfaces at the **`prisma migrate deploy`** step, *before* the Next.js server starts — the process `exit(1)`s and the user never reaches a login screen. (Ruled out by experiment: a stale `.next/standalone/.env` does **not** ship to npm; `bun` vs `npm` install is irrelevant — the runtime is always node.)

## What Changes

Scope is the agreed MVP (elaboration Round 1): make the failure **impossible to hit silently**, and make any residual failure **self-explaining**. No automatic port bumping.

- **Capture PGlite child-process exit (any exit code), not just spawn error.** If the forked PGlite process exits before `waitForTcp` reports the port ready, treat it as **fatal** and stop with a clear message — never let a foreign listener on the port be mistaken for our PGlite. This closes Path A at the root: `waitForTcp` alone ("someone is listening") is no longer sufficient evidence that our embedded DB is up.
- **Rewrite the bare Prisma P1000 into a Chorus-friendly diagnostic.** When `prisma migrate deploy` fails with an authentication error, intercept it and print an actionable message: which host:port was connected, that credentials did not match, and the two remedies (`--pglite-port <free port>` if the default port is occupied, or `unset DATABASE_URL` if it points at the wrong DB). The raw P1000 is no longer the last thing the user sees.
- **Surface `DATABASE_URL` provenance explicitly.** When embedded PGlite is skipped because `DATABASE_URL` is set, say so in the startup banner and in the failure diagnostic ("Using external DATABASE_URL <host:port>; embedded PGlite not started"), so a *residual* export is visible rather than silent. Existing `DATABASE_URL`-wins semantics are unchanged.

Explicitly **out of scope** for this change (deferred): automatic port bumping (5433→5434→…), and passing the PGlite child's stderr through to the console.

## Capabilities

### New Capabilities
- `embedded-db-launch`: how the standalone `chorus` server launches (or declines to launch) the embedded PGlite database — child-process liveness detection, port-conflict fail-fast, DATABASE_URL provenance in the banner, and actionable diagnostics when the database connection fails at migration time.

### Modified Capabilities
<!-- none — no existing spec capability covers the embedded-DB launch path -->

## Impact

- **Code:** `chorus.mjs` (embedded-PGlite launch block ~L303–L343, `.on("error")` handler L320, `waitForTcp` L225–L248, migration block L350–L363, banner L385–L411). Following the existing `cli/server-signal-handlers.mjs` precedent, the launch/diagnostic logic is extracted into a **pure, dependency-injected `cli/*.mjs` module** so it can be unit-tested with fake process/socket objects without importing the side-effectful entry.
- **Tests:** new `cli/__tests__/*.test.mjs` covering child-exit capture, port-conflict fail-fast, and P1000 rewrite; plus a real end-to-end reproduction (foreign Postgres on the PGlite port; residual bad `DATABASE_URL`).
- **No schema/API/dependency changes.** No behavioral change on the clean happy path (no port occupant, no `DATABASE_URL`) — verified still working during reproduction.
- **Docs:** the `--pglite-port` remedy and the `DATABASE_URL` provenance note may warrant a line in the CLI `--help` / setup docs.
