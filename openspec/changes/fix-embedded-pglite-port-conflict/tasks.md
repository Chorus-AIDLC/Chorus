# Tasks

## 1. Extract & harden embedded-PGlite launch (child-exit capture + fail-fast)
- [ ] Extract embedded-PGlite launch + diagnostic logic from `chorus.mjs` into a pure, dependency-injected `cli/embedded-db.mjs` (precedent: `cli/server-signal-handlers.mjs`).
- [ ] Detect child exit before port-ready as fatal (any exit code, incl. EADDRINUSE→exit 0); remove misleading "PGlite ready" on conflict; print `--pglite-port` remedy; exit non-zero.
- [ ] Unit tests with fake spawner/socket for: EADDRINUSE→exit 0, non-zero exit, healthy start, ordering race.

## 2. Rewrite P1000 into a Chorus diagnostic + DATABASE_URL provenance
- [ ] Classify migrate auth-failure (P1000 token / phrase) without misfiring on other errors; keep generic path otherwise.
- [ ] Emit final diagnostic (embedded path → --pglite-port; external path → unset DATABASE_URL); mask creds.
- [ ] Banner names external DATABASE_URL host:port when embedded PGlite skipped.
- [ ] Unit tests for classifier + formatter over captured P1000 sample.

## 3. End-to-end reproduction test (integration checkpoint)
- [ ] Real foreign Postgres on the PGlite port → assert fail-fast, no P1000, no false "PGlite ready".
- [ ] Residual bad DATABASE_URL → assert rewritten diagnostic, not bare P1000.
- [ ] Clean env → assert happy path unchanged (migrations apply, server starts).
