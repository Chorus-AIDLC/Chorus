# Technical Design: Fix `chorus daemon install` config

## Overview

`chorus daemon install` gains a **pre-install config phase** that runs before the service unit is written, plus a change to the unit generator so working directories are sourced from `~/.chorus/daemon.json` rather than baked into the unit. All new logic reuses existing, unit-tested seams — no new persistence primitive, no new dependency, pure Node.

## Architecture

Today (`cli/daemon.mjs`):

```
runDaemon → action !== "run" → handleLifecycleAction("install")
                                   → installService(spec)   // writes unit, enable --now
```

`preflight` (interactive credential completion) lives only on the `run` path and is never reached by `install`.

After this change:

```
handleLifecycleAction("install")
  → resolveInstallCredentials(flags, env, {isTTY, skip})   // NEW: resolve → (prompt?) → validate → persist
      · abort (non-zero) if creds cannot be obtained/validated
  → resolveInstallCwds(flags, {isTTY, skip})               // NEW: reuse resolveDaemonCwds; wizard if unconfigured
      · persist chosen set to daemon.json `cwds`
  → installService(spec)                                    // unchanged call; spec.cwds no longer flows into the unit
```

Both new helpers are pure/dependency-injected (env, readJson, prompt, validate, writeConfig) so they unit-test without real disk/network/TTY — matching the existing `cli/*.mjs` style.

## Credential preflight (`resolveInstallCredentials`)

Order of operations:

1. `resolveCredentials(flags, {env})` (existing, `cli/credentials.mjs`) — flags > env > daemon.json > plugin.
2. **Resolved:** persist `{url, apiKey}` to `~/.chorus/daemon.json` via `updateDaemonConfig` (existing field-merge writer in `cli/login.mjs`, 0600, preserves `cwds`/`yoloAckAt`/`sigintTimeoutMs`). This is the crux of the fix — it moves env/flag creds into the tier the clean boot env reads. When creds already came from `daemon.json`, the persist is an idempotent no-op merge.
3. **Not resolved + TTY + not skip:** run the `chorus login` masked-prompt flow (reuse `prompt` from `cli/login.mjs`) to collect url + key.
4. **Not resolved + (non-TTY or skip):** abort non-zero with the existing multi-source hint from `resolveCredentials`. Never write a unit.
5. **Always validate** the resolved/entered key against the server via `validateAndFetchIdentity` (existing, `cli/chorus-client.mjs`) before writing the unit; on failure, abort non-zero and do not write. Persist the identity (`agentUuid`, `agentName`) alongside the creds, same as `chorus login`.

Q-map: Q1-A (persist any source), Q2-A (always validate), Q8-A (flag OR non-TTY skips prompts but still persist+validate+abort-if-none), Q9-A (validate even in skip mode).

## Interactive multi-cwd config (`resolveInstallCwds`)

1. Compute the already-configured set with `resolveDaemonCwds(flags, {env})` (existing, `cli/daemon-config.mjs`) but distinguish "explicitly configured" from the `[undefined]` process-cwd default. Configured ⇔ a `--cwd` flag was passed OR `daemon.json` has a non-empty `cwds` array.
2. **Configured, or skip/non-TTY:** use the configured set as-is (no prompt). If neither flag nor file set anything in skip/non-TTY mode, fall back to the current process cwd (today's single-path default).
3. **Unconfigured + TTY + not skip:** run the wizard —
   - Pre-seed the current directory as the suggested first entry (operator presses Enter to accept, or types a path).
   - Loop "Add a working directory (blank to finish):" accumulating entries; blank line ends the loop.
   - Normalize + de-dup each entry with the same rules `resolveDaemonCwds` uses (`~` expansion, absolute resolution, first-seen de-dup).
4. Persist the chosen set to `daemon.json` `cwds` via `updateDaemonConfig` (same merge writer). This is the **single source of truth**; the unit gets no `--cwd`.

Q-map: Q3-A (repeat-loop, blank ends, cwd pre-seeded), Q4-A (prompt only when unconfigured), Q5-A (persist to daemon.json cwds only).

## Unit generator change

`buildServiceArgs` (`cli/daemon-service.mjs`) currently appends `--cwd <path>` per configured path; `renderSystemdUnit` / `renderLaunchdPlist` embed that in `ExecStart` / `ProgramArguments`. Because cwds now live in `daemon.json` (which the daemon reads via `resolveDaemonCwds` tier 3), the unit must **stop** emitting `--cwd` so the two sources cannot drift and a plain `chorus daemon` sees the same paths. `--agent` / `--chorus-only` are still captured (they have no config-file equivalent that install writes). The existing "quote every ExecStart token" correctness property is preserved for the node/script paths.

## Module Contracts

- **Credential persistence:** only ever through `updateDaemonConfig` (atomic tmp+rename, 0600, shallow field-merge). Never hand-write `daemon.json`. Never bake the secret key into the unit (rejected design — weaker isolation than a 0600 file).
- **Cwd normalization:** reuse `resolveDaemonCwds`'s `normalizeCwd` + de-dup semantics so wizard-entered paths and flag/env/file paths are treated identically.
- **Abort contract:** any install that cannot end with a valid, validated credential in `daemon.json` exits non-zero and writes no unit (`installService` is never called). "No silent errors."
- **Skip trigger:** `flags.yes === true` OR `!isTTY`. Both suppress every prompt; neither suppresses resolve/persist/validate/abort.

## Implementation Plan

1. `cli/client-args.mjs`: parse `--yes` / `-y` into `flags.yes`; extend `daemonHelpText` SERVICE section + `chorus.mjs` help.
2. `cli/daemon-service.mjs`: drop `--cwd` from `buildServiceArgs` (keep `--agent` / `--chorus-only`); adjust the two renderers + their tests/scenarios.
3. `cli/daemon.mjs`: add `resolveInstallCredentials` + `resolveInstallCwds` (pure, injected IO) and call them at the top of the `install` branch before `installService`; thread `isTTY` + `flags.yes`.
4. Unit tests for every branch (resolve/persist/validate/abort; wizard loop/blank/pre-seed/skip-when-configured; skip-flag + non-TTY).
5. Docs/help text.

## Risks & Mitigations

- **Validation needs network at install time (Q2/Q9).** Accepted per elaboration; the whole point is to fail at install instead of crash-looping at boot. The error message names the server and the offline-install trade-off was explicitly declined (Q9-A).
- **Re-install must not clobber existing config.** `updateDaemonConfig` is a field-merge, so persisting creds preserves `cwds`/`yoloAckAt`; persisting cwds preserves creds. Covered by existing merge-writer tests + new ones.
- **Live-testing `install` restarts the running daemon** (`enable --now` / `systemctl restart`). Do the end-to-end install→boot verification in an isolated env or under a temporary `SERVICE_NAME`, not against the daemon hosting the session.
- **Dropping `--cwd` from the unit changes an existing scenario** in `daemon-background-lifecycle` (the `--cwd /a --cwd /b` install scenario). That scenario is rewritten in the delta (MODIFIED block) — not left stale.
