## Context

`chorus.mjs` is the standalone server entry (`#!/usr/bin/env node`). On the server-launch path (no `daemon`/`login` subcommand) its `main()` decides how to obtain a database:

- `usePglite` defaults to `true`; `startEmbeddedPglite = usePglite && !process.env.DATABASE_URL` (`chorus.mjs:287`).
- When starting embedded PGlite it `fork()`s `@electric-sql/pglite-socket`'s `server.js` with `{ stdio: "ignore" }` (`:314–318`), attaches only `pgliteProcess.on("error", …)` (`:320`, fires on **spawn** failure only), then `await waitForTcp("localhost", PGLITE_PORT)` (`:332`) which resolves as soon as a TCP connect succeeds. On success it hardcodes `process.env.DATABASE_URL = postgresql://postgres:postgres@localhost:${PGLITE_PORT}/postgres` (`:342`).
- Then `execSync("… prisma … migrate deploy", { stdio: "inherit" })` (`:354`); on throw it prints `ERROR: Database migration failed.` and `exit(1)` (`:360`).

**Reproduced failure modes (real hardware, 2026-07-01):**
- **A:** a real Postgres already on `PGLITE_PORT`. The forked PGlite child logs `EADDRINUSE` and **exits 0** (clean shutdown after catching the listen error); `stdio:"ignore"` hides it; `.on("error")` never fires (no spawn failure). `waitForTcp` connects to the *foreign* Postgres → prints `PGlite ready` → `DATABASE_URL` points at the foreign DB → `migrate deploy` → **P1000**.
- **B:** `DATABASE_URL` already exported → embedded PGlite skipped → connect to that DB → **P1000**.

The existing `cli/server-signal-handlers.mjs` (+ its `__tests__`) establishes the codebase pattern: **extract a pure, dependency-injected helper out of the side-effectful entry so it can be unit-tested with fakes.** This design follows that precedent.

## Goals / Non-Goals

**Goals:**
- A foreign listener on `PGLITE_PORT` can never be mistaken for our embedded PGlite (kill Path A's silent mis-connect).
- The PGlite child exiting for *any* reason before the port is confirmed ready is detected and fatal (not just spawn failure).
- When the DB connection fails at migration time, the user sees an actionable, self-explaining diagnostic (host:port connected, credential mismatch, remedies) instead of a bare Prisma P1000.
- When `DATABASE_URL` causes embedded PGlite to be skipped, that provenance is visible in the banner and in any failure message.
- The launch/diagnostic logic is unit-testable without spawning real processes or importing the entry module's import-time side effects.
- Clean happy path (no occupant, no `DATABASE_URL`) is byte-for-byte unchanged in behavior.

**Non-Goals:**
- **Automatic port bumping** (5433→5434→…). Elaboration chose fail-fast (`--pglite-port` is the manual remedy). Deferred.
- **Passing the PGlite child's stderr through** to the console. Elaboration chose `capture_exit` only; the rewritten P1000 diagnostic (Q3) carries the actionable information, so raw child stderr is not required. Deferred.
- Changing `DATABASE_URL`-wins precedence semantics (kept as-is; only made visible).
- Deep protocol/handshake validation of the peer (e.g., confirming it speaks PGlite's wire dialect). Child-liveness + fail-fast is sufficient for the MVP; handshake probing is a possible future hardening.

## Decisions

### D1 — Detect child exit, don't trust "someone is listening"

Replace the spawn-only `.on("error")` with a launch routine that treats **the PGlite child exiting before the port is confirmed** as fatal. Concretely, race two conditions after `fork`:

- **child exit** — attach `pgliteProcess.on("exit", (code, signal) => …)`. If the child exits (any code, including the observed `EADDRINUSE → exit 0`) before we've confirmed readiness, the launch **fails fatally**.
- **port ready** — `waitForTcp` resolving.

Whichever fires first wins. If child-exit wins → fatal error (the port is either occupied by a foreign process or PGlite couldn't start). If port-ready wins first **and the child is still alive**, we accept it. This closes the Path A gap: a foreign listener no longer counts as success, because our own child having exited is now an independent, sufficient failure signal.

> Implementation note (verify against the installed Node): a `fork`ed child that exits fires `"exit"` even under `stdio:"ignore"`. The child's own `EADDRINUSE` handler exits 0, so we must key off *"exited before ready"*, **not** *"exited with non-zero code"* — a non-zero-only check would miss the reproduced case. Task AC must assert exactly this.

### D2 — Fail-fast message on port conflict

When D1 declares the launch failed (child exited before ready), print a clear, actionable error and `exit(1)`:

> `Embedded PostgreSQL (PGlite) could not start on port <PORT>. The port may be occupied by another process (e.g. a real PostgreSQL). Free the port, or choose another with: chorus --pglite-port <port>.`

No auto-bump. This replaces the misleading `PGlite ready` line for the conflict case.

### D3 — Rewrite Prisma P1000 into a Chorus diagnostic

Wrap `migrate deploy` so an authentication failure is intercepted and re-presented. Because `stdio:"inherit"` streams Prisma's output live, detection must not rely on swallowing it: capture the migrate step's output (or re-run classification) enough to recognize the auth-failure signature, then append/emit a Chorus diagnostic as the **final** message so it's the last thing the user sees. The diagnostic states:

- which host:port was connected (derive from the effective `DATABASE_URL`, credentials masked),
- that the server rejected the `postgres` credentials,
- the two remedies, chosen by *why* we're pointed there:
  - embedded-PGlite path (no external `DATABASE_URL`): "port `<PORT>` is likely occupied by another PostgreSQL — retry with `chorus --pglite-port <free port>`",
  - external path (`DATABASE_URL` set): "Chorus is using your `DATABASE_URL` (`<host:port>`); if that is unintended, `unset DATABASE_URL` and re-run."

Detection should match Prisma's P1000 robustly (code token `P1000` and/or the "Authentication failed against database server" phrase) and must not misfire on unrelated migration errors — non-auth failures keep today's generic `Database migration failed` path. Verify the exact P1000 surface text against the installed Prisma version rather than trusting memory.

### D4 — DATABASE_URL provenance in the banner

The banner already prints a `Database:` line. Extend the skip-PGlite case so it names the external target: `Database: external PostgreSQL (from DATABASE_URL: <host:port>)` (credentials masked). Semantics unchanged — only visibility. The D3 external-path diagnostic reuses the same host:port formatting helper.

### D5 — Extract a pure, injectable module (testing seam)

Following `cli/server-signal-handlers.mjs`: move the embedded-PGlite launch + diagnostic logic into a new pure module under `cli/` (e.g. `cli/embedded-db.mjs`) exporting small functions that take injected dependencies — a `fork`-like spawner, a `waitForTcp`-like readiness probe, a `logger`/`console`, and an `exit` callback — so unit tests drive them with fakes (mirroring the fake-`process` recorder in `server-signal-handlers.test.mjs`). `chorus.mjs` becomes a thin caller. Pure functions to cover:

- **launch outcome resolver** — given (child-exit event vs port-ready event ordering, child alive flag) → `{ ok }` or `{ fatal, reason }` (D1).
- **P1000 classifier** — given migrate stdout/stderr + exit status → `isAuthFailure: boolean` (D3).
- **diagnostic formatter** — given `{ effectiveUrl, startedEmbedded, pglitePort }` → the exact remedy string (D2/D3/D4), credentials masked.

This keeps the fix honest (assert the exact reproduced case) and avoids flaky process-spawning tests in the unit layer; a separate integration test exercises the real `fork`.

## Risks / Trade-offs

- **Race semantics (D1):** the child could exit *microseconds after* `waitForTcp` resolves against the real PGlite — acceptable: that's a genuinely-started PGlite that then crashed, still worth surfacing, but the common healthy path resolves port-ready first with a live child. Keep the "still alive at ready-time" check narrow to avoid false fatals on a healthy start. Cover ordering in unit tests.
- **P1000 detection brittleness (D3):** matching on Prisma's message/code risks drift across Prisma versions. Mitigate by matching the stable `P1000` token first, phrase second, and falling back to the generic error path when unsure (never *hide* a real failure). Pin behavior with a unit test over a captured P1000 sample and re-verify against the installed Prisma.
- **`stdio:"inherit"` vs capturing output (D3):** to classify the migrate failure we may need to capture rather than pure-inherit its streams; must preserve live progress visibility (users expect to see migrations applying). Trade-off: tee/capture, or run classification on a captured buffer while still echoing. Chosen approach must not regress the visible migration progress on the happy path.
- **Foreign PGlite on the port:** if the occupant genuinely *is* another Chorus PGlite with matching `postgres/postgres`, migration could succeed against it (data goes to the wrong instance). Out of scope to fully disambiguate here; D1 only guarantees we don't treat a *dead* child as success. Handshake/identity probing is future work.
