## Context

The daemon resolves a complete credential pair `{ url, apiKey }` before constructing `CodexSpawner`. Codex MCP connectivity is declared separately in the user's `~/.codex/config.toml`: the URL is stored in that config, while `bearer_token_env_var` reads the API key from the spawned process environment.

`CodexSpawner.wake` currently copies the daemon environment, sets `CHORUS_DAEMON_HEADLESS=1`, and overwrites `CHORUS_API_KEY` from the resolved daemon credentials. It does not set `CHORUS_URL`. The Codex SessionStart hook checks both `CHORUS_URL` and `CHORUS_API_KEY` before calling `chorus_checkin`, so it emits a false "environment not configured" message even though Codex MCP can connect through `config.toml`. The observed message can also be surfaced more than once during one startup, so diagnostics need an explicit idempotency boundary.

## Goals / Non-Goals

**Goals:**

- Give the SessionStart hook the same resolved URL and API key pair used by the daemon wake.
- Suppress configuration warnings when Chorus check-in succeeds.
- Emit a given configuration warning no more than once during one Codex headless startup.
- Preserve a visible generic warning for genuinely missing configuration or failed connectivity.
- Keep the API key out of argv and logs.

**Non-Goals:**

- Changing how normal interactive Codex sessions configure MCP.
- Replacing the user's `[mcp_servers.chorus]` configuration.
- Expanding connection errors into new diagnostic categories.
- Changing Claude, Kiro, or OpenClaw daemon backends.

## Decisions

### Inject the complete resolved credential context

`CodexSpawner` will set both `CHORUS_URL` and `CHORUS_API_KEY` from `this.creds` in the child environment, in addition to `CHORUS_DAEMON_HEADLESS=1`. The resolved daemon credentials are authoritative for a daemon wake and already contain both values. Explicit assignment also prevents stale inherited values from disagreeing with the daemon connection.

Alternative considered: teach the hook to parse `~/.codex/config.toml`. This would duplicate Codex config parsing, still would not reliably recover secrets referenced through arbitrary environment-variable names, and would couple a shell hook to Codex's configuration schema.

Alternative considered: skip the environment check whenever `CHORUS_DAEMON_HEADLESS=1`. This would hide real daemon misconfiguration and prevent the hook's check-in context from loading.

### Keep the existing hook diagnostic contract

Once both values are present, the hook will continue to call `chorus_checkin`. Missing values retain the existing generic not-configured warning, and a failed check-in retains the existing generic connection warning. The fix changes the inputs to this contract rather than introducing a second source of connectivity truth.

### Put deduplication at the diagnostic emission boundary

Implementation will first reproduce whether duplicate output is caused by duplicate hook invocation or duplicate rendering of one hook result. The narrowest stable emission boundary will guard a diagnostic identity for the lifetime of one headless startup, without suppressing warnings in later independent starts. Tests must demonstrate one visible warning after two equivalent triggers and a fresh warning in a separate startup.

If investigation shows that the same hook result is rendered twice outside the hook process, deduplication belongs in that caller rather than a process-local shell variable. The implementation must document the observed trigger path in the test name or code comment.

## Risks / Trade-offs

- [Child environment exposes the URL to subprocesses] -> The URL is non-secret and the API key is already intentionally present; tests continue to assert that the key never enters argv.
- [Inherited credentials could differ from daemon credentials] -> Always overwrite both variables from the resolved `this.creds` pair.
- [A global dedupe marker could suppress later valid warnings] -> Scope any marker or state to one startup identity and test independent starts.
- [Hook and installed plugin copies can drift] -> Update source tests around the repository hook and rely on the normal plugin packaging path rather than patching cached installations.

## Migration Plan

No data migration is required. Ship the spawner and hook changes together. Rollback is a code revert; the user's Codex MCP configuration remains unchanged.

## Open Questions

- Which layer duplicates the warning in the reproduced headless startup: repeated SessionStart execution, duplicate plugin registration, or duplicate rendering of one hook result? This is an implementation investigation item and determines the narrowest dedupe location.
