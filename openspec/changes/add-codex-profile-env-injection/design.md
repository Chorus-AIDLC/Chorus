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

Writing all three makes **both** paths available and — critically — satisfies the
`on-session-start.sh` url+key preflight. So **no plugin-hook code change is needed**; the
correct behavior falls out of the existing resolution logic once the env is present.

## What `[shell_environment_policy].set` covers — and the one honest unknown

`[shell_environment_policy]` (config schema in `codex-rs`) governs the environment Codex
hands to its **exec/shell tool** — reliably covering the model's own `chorus` shell calls.

**The unknown (spike, task 2):** whether that env also reaches Codex's **plugin lifecycle
hook** subprocesses (`SessionStart` → `on-session-start.sh`, `PostToolUse` →
`chorus-mcp-call.sh`), which run through a separate spawn path
(`codex-rs/core/src/hook_runtime.rs`). Verify against the installed `codex`; if hooks are
NOT covered, the shell-tool path still works and the residual hook gap is surfaced via an
actionable WARNING + the manual `export` hint (NOT a wrapper — owner rejected it).

> **Hallucination-aware:** the implementer MUST re-verify (a) the exact `set` TOML spelling
> Codex accepts (`[shell_environment_policy.set]` table vs inline `set = { … }`), (b) that
> the key is still stored as a literal `Authorization: Bearer` in `[mcp_servers.chorus]`,
> and (c) hook-subprocess env inheritance — against the installed `codex --version`, not
> memory.

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
