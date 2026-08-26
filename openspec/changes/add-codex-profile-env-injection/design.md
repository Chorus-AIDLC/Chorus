# Technical Design: Codex `config.toml` `[shell_environment_policy]` credential injection

## Overview

Extend the `once`-scoped `credential-seed` step (`cli/init/steps/credential-seed.mjs`) so
that, for a selected **Codex** identity, it upserts the Chorus connection credentials —
`CHORUS_URL`, `CHORUS_API_KEY`, `CHORUS_AGENT_PROFILE` — into the `[shell_environment_policy]`
`set` table of that agent's `~/.codex/config.toml`. This is the Codex analogue of the
Claude Code `~/.claude/settings.json` `env` write (`writeClaudeSettingsEnv`) and the dsh
`$DSH_HOME/.env` write (`writeDshCredentialsEnv`) in the same file — same invariants
(idempotent, merge-preserving, `0600` atomic, key never echoed) — but the target is a
**TOML** file.

The native MCP client is already export-free (literal `[mcp_servers.chorus]` Bearer written
by `codex plugin add`); this write is for the **hook / CLI layer**. The daemon-wake path
already injects these three vars at spawn (`cli/codex-spawner.mjs:277-283`); this change
brings **interactive** launch to parity.

## Why all three, and why ungated (the corrected scope)

An earlier draft proposed writing only `CHORUS_AGENT_PROFILE` (multi-agent only), on the
assumption that the hook/CLI layer auto-singles the key from `daemon.json`. **That was
wrong** (caught by the proposal-reviewer, verified in code):

- `plugins/chorus/hooks/on-session-start.sh:16-22` hard-requires `CHORUS_URL`+`CHORUS_API_KEY`
  in the environment before it runs; without them it prints "not configured" and skips the
  checkin. (The Claude Code hook is identical — `public/chorus-plugin/bin/on-session-start.sh:27`.)
- `plugins/chorus/hooks/chorus-mcp-call.sh` resolves via `CHORUS_AGENT_PROFILE`+CLI OR
  url+key; it **never** issues a bare `chorus mcp call`, so `resolveMcpCredentials`'
  auto-single (`cli/credentials.mjs`) is unreachable through the hooks.

So a **single**-agent interactive Codex also needs env present — hence the write is
**ungated** (every selected Codex agent), matching how CC writes `settings.json` env
unconditionally.

### Resolution order (owner direction; already implemented, no hook edit)

Owner (idea comment): *reference the Claude Code plugin; prefer the `chorus` CLI ≥ 0.17.0 +
`CHORUS_AGENT_PROFILE`, fall back to url+apikey.* This is **exactly** what the Codex
`chorus-mcp-call.sh` and the CC `chorus-api.sh:253-281` already do:

1. **Preferred:** `CHORUS_AGENT_PROFILE` present + `chorus` CLI ≥ 0.17.0 → `chorus mcp call
   --agent <profile>` (the CLI reads the key from `~/.chorus/daemon.json`).
2. **Fallback:** CLI absent/old → `CHORUS_URL`+`CHORUS_API_KEY` (CLI url+key path, else curl).

Writing all three makes **both** resolution paths available **wherever the env reaches** —
which the task-2 spike found is the shell/exec tool, but NOT the lifecycle hooks (see
"What `[shell_environment_policy].set` covers" below). So for the model's shell-tool
`chorus` calls this is fully wired with no export; for the SessionStart/PostToolUse hooks
(which inherit Codex's process env, not the shell policy) an interactive launch still needs
the shell to export the vars. **No plugin-hook code change and no wrapper** either way (the
resolution order already lives in the hooks); the residual interactive-hook gap is surfaced,
not hidden.

## What `[shell_environment_policy].set` covers — VERIFIED (task-2 spike)

**Method.** Source inspection of the local `codex-rs` checkout for **codex-cli 0.146.1**
(the installed version) plus a scripted run of the writer. A live interactive `codex`
session was **not** driven (this ran headless — no TTY/model), so the verdict rests on the
source of truth (how Codex builds each subprocess's env) rather than runtime observation.
Two spawn paths were traced:

- **Shell/exec tool** applies `shell_environment_policy` — `codex-rs/core/src/unified_exec/process_manager.rs:1156`
  (and `1169`, `1206`) and `codex-rs/core/src/tools/handlers/shell/shell_command.rs:104`
  read `context.turn.config.permissions.shell_environment_policy` when building the tool's
  environment. So `[shell_environment_policy].set` **reaches the shell/exec tool**.
- **Plugin lifecycle hooks** run through the `codex_hooks` crate. The command runner
  `codex-rs/hooks/src/engine/command_runner.rs` → `build_command()` (lines 164-191) spawns
  the hook via `Command::new(<shell>)` and applies **only** `command.envs(&handler.env)` —
  the hook declaration's own static `env`. It does **not** call `env_clear`, so the hook
  process inherits **Codex's own process environment**, and it does **not** consult
  `shell_environment_policy` at all (no reference to it anywhere in `codex-rs/hooks/`).

**Verdict.** `[shell_environment_policy].set` covers the **shell/exec tool but NOT the
plugin lifecycle hooks**. The SessionStart (`on-session-start.sh`) and PostToolUse
(`chorus-mcp-call.sh`) hooks receive whatever env `codex` itself was launched with (plus the
static `handler.env`) — the daemon-wake path sets that at spawn (`cli/codex-spawner.mjs:277-283`),
but an INTERACTIVE launch does not unless the user's shell already exports the vars.

**Consequence for this change:**
- ✅ The write to `[shell_environment_policy].set` **does** make the model's own shell-tool
  `chorus mcp call` invocations (the skill-CLI path) resolve identity with no export.
- ❌ It does **not** wire the SessionStart check-in / PostToolUse hooks for interactive
  launch — no config-file mechanism can, since hooks inherit Codex's process env and
  `shell_environment_policy` is not applied to them. Per the owner's "不加也行" (accept the
  gap) and NO-wrapper decision, this residual is **surfaced, not silently suppressed**: the
  Codex success note tells the operator that to fire the hooks interactively they must launch
  `codex` from a shell exporting `CHORUS_URL`/`CHORUS_API_KEY`/`CHORUS_AGENT_PROFILE` (the
  daemon-wake path already does this automatically). No `chorus launch codex` wrapper.

## Architecture

### New writer: `writeCodexShellEnvCreds`

Signature mirrors the dsh / Claude Code writers:

```
writeCodexShellEnvCreds({ configPath, url, apiKey, agentProfile }, deps?) -> string  // path written
```

**Approach — targeted textual upsert, NOT a TOML parse+reserialize.** The repo has **no**
TOML-parser dependency and treats `config.toml` as text everywhere today
(`install-methods.mjs` uses `.includes()`); adding a parser would violate the cross-platform
"pure-JS, no native bindings" rule, and a full reserialize would reformat the file and drop
comments — disturbing the `[mcp_servers.chorus]` block. So the writer edits text surgically,
mirroring `writeDshCredentialsEnv`'s preserve-every-other-line discipline:

1. **Read** the existing `config.toml` (missing → start empty). An existing file whose
   managed region can't be safely edited → **throw** (caller treats a throw as a write
   failure → WARNING; never clobber).
2. **Canonical managed region:** a `[shell_environment_policy.set]` dotted-table section
   holding `CHORUS_URL` / `CHORUS_API_KEY` / `CHORUS_AGENT_PROFILE`.
   - `[shell_environment_policy.set]` header present → upsert the three managed keys within
     it (section = header to the next top-level `[` header or EOF), preserving all other
     keys and everything else verbatim.
   - `[shell_environment_policy]` present with an inline `set = { … }` → upsert the three
     keys inside that inline table; if it can't be edited unambiguously, throw (→ WARNING).
   - Neither present → append a fresh `[shell_environment_policy.set]` section with the
     three managed lines (valid TOML alongside an existing `[shell_environment_policy]`
     header as long as no duplicate `set` key is introduced).
3. **Atomic `0600` write:** temp file (`0o600`) in the same dir → `rename`. Create
   `~/.codex` if absent.
4. Return the path. The API key is only ever written into the `0600` file — never argv,
   never a log.

DI seams (`read` / `write` / `mkdir` / `rename`) match `writeDshCredentialsEnv` so unit
tests stay pure. Idempotent: a re-run with the same values reproduces the file.

### Wiring (ungated for the `codex` selection)

Gate on the `codex` selection id (exactly how dsh gates on `dsh` and Claude Code on
`claude`), with **no** multi-agent condition — write for every selected Codex agent. Write
this agent's own `identity.uuid` as `CHORUS_AGENT_PROFILE`, plus the resolved `url` +
validated `apiKey`, into the `config.toml` under the agent's `CODEX_HOME`
(`env.CODEX_HOME || ~/.codex`). Two Codex agents on one machine already require separate
`CODEX_HOME`s (each `config.toml` holds one literal Bearer — `cli/codex-spawner.mjs:22`);
this writer follows that same per-`CODEX_HOME` model.

### Hint suppression + failure UX

- On a **successful** write, stamp `codexEnvWritten: true` on that agent's `credential-seed`
  outcome (parallel to dsh's `profileInEnv` / Claude Code's `settingsEnvWritten`).
  `profileExportHint` in `cli/init.mjs` is extended to `continue` past any outcome carrying
  it.
- On **write failure** (locked/unwritable, or an ambiguous existing structure the writer
  refuses to edit) the file is left untouched and the command emits an **actionable
  WARNING** naming the three env keys the interactive session needs and how to set them
  (add them under `[shell_environment_policy.set]` in `~/.codex/config.toml`, or `export`
  them), **referencing the API key without printing its value**.

### `chorus agents remove` note (Q6 → a; dsh / Claude Code parallel)

Reverse-cleanup stays out of scope. Mirroring the dsh `$DSH_HOME/.env` and Claude Code
`~/.claude/settings.json` "left untouched, clear manually" notes, `chorus agents remove`
SHALL print a one-line note that `~/.codex/config.toml` may still carry the removed agent's
CHORUS_* env (under `[shell_environment_policy].set`) and its literal Bearer (under
`[mcp_servers.chorus]`), and can be cleared by hand. Note only; no removal.

## Module Contracts

- **Outcome flag:** `credential-seed` outcomes MAY carry `codexEnvWritten: true`;
  `cli/init.mjs profileExportHint` MUST treat it identically to the existing `profileInEnv`
  / `settingsEnvWritten` short-circuit (`continue` past that agent).
- **All three keys, ungated:** the writer takes `url` + `apiKey` + `agentProfile` and runs
  for every selected Codex agent (single- and multi-agent alike).
- **Preserve everything else:** the write touches only the three managed keys under
  `[shell_environment_policy].set`; `[mcp_servers.chorus]`, plugin entries, and all other
  sections/comments survive verbatim (byte-for-byte outside the managed keys).
- **Never echo the key:** neither the writer, the summary, nor the WARNING prints `apiKey`;
  only the `config.toml` path and non-secret fields (URL, profile UUID) may be surfaced.
- **Target file:** ONLY `~/.codex/config.toml` under the agent's `CODEX_HOME`.
- **No hook edit, no wrapper:** the resolution order already lives in `chorus-mcp-call.sh`;
  do not add a launcher wrapper.

## Implementation Plan

1. Add `writeCodexShellEnvCreds` to `credential-seed.mjs` (targeted textual TOML upsert; DI
   seams).
2. In `seedCredentials`, for the `codex` selection: call the writer with the resolved
   `url` + validated `apiKey` + `identity.uuid`; stamp `codexEnvWritten` on success, or emit
   the WARNING on failure.
3. Extend `profileExportHint` suppression in `cli/init.mjs` for `codexEnvWritten`.
4. Add the one-line `~/.codex/config.toml` note to `chorus agents remove` (`cli/agents.mjs`).
5. Unit + integration tests (writer preserve/idempotent/0600/throw-on-ambiguous; ungated
   wiring for single + multi agent; failure WARNING; hint suppression).
6. **Spike (task 2):** verify hook-subprocess coverage of `[shell_environment_policy].set`
   against the installed `codex`; record the finding here; confirm the export-hint fallback
   for the residual hook gap if hooks are not covered.
7. Docs / skill sweep.

## Risks & Mitigations

- **Corrupting a hand-edited `config.toml` (esp. the literal Bearer)** → targeted textual
  upsert touching only the managed keys; throw (→ WARNING, no clobber) on ambiguous
  structure; atomic temp+rename; unit-tested against a fixture with an `[mcp_servers.chorus]`
  block.
- **Claiming hook coverage we don't have** → gated behind the task-2 spike; the proposal
  claims only shell-tool coverage until verified; the export-hint fallback covers the
  residual honestly. Note: even if hooks are NOT covered, the write is still correct — it is
  what the daemon already does at spawn — the residual is only the *interactive* hook path.
- **Second on-disk key copy** → inherent to Codex (http_headers can't reference an env var);
  both copies are in the `0600` `config.toml`, consistent with CC + dsh; key never printed.
- **Over-building** → no wrapper, no plugin-hook change, no marker file; the resolution
  order already exists.
- **TOML spelling drift** → implementer verifies the accepted `set` spelling against the
  installed `codex` before finalizing the canonical form.

## Out of Scope

- The `chorus launch codex` wrapper (owner rejected).
- The macOS-GUI-can't-read-shell-env path (elaboration Q3 → c).
- `chorus agents remove` reverse-cleanup (Q6 → a — note only).
- Every other harness (Kiro / opencode / OpenClaw — separate sibling ideas under `9d1549ba`).
- `design.pen`: no new UI screen (CLI-only); Install Guide copy edits are text-only and
  owner-waivable per prior CLI-only changes.
