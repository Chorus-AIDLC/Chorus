# Technical Design: Claude Code `settings.json` env injection

## Overview

Extend the `once`-scoped `credential-seed` step (`cli/init/steps/credential-seed.mjs`)
so that, in addition to seeding `~/.chorus/daemon.json` `agents[]`, it writes the Chorus
connection credentials into Claude Code's user-global `~/.claude/settings.json` `env`
block for the selected Claude Code identity. This is the direct analogue of the existing
dsh `$DSH_HOME/.env` write (`writeDshCredentialsEnv` in the same file) — same invariants
(idempotent, merge-preserving, 0600 atomic, key never echoed), but the target is a JSON
object rather than a dotenv file.

### Why settings.json `env` is the single lever (verified against Claude Code docs)

`~/.claude/settings.json`'s `env` is injected at **session start**, before the MCP client
connects, and is inherited by hook subprocesses and Bash/CLI tools. So three keys there
satisfy simultaneously:

- **(a) native MCP auth** — the plugin `.mcp.json` interpolates `${CHORUS_URL}/api/mcp`
  and `Bearer ${CHORUS_API_KEY}` from `env` at connect time;
- **(b) plugin hooks** — inherit the env;
- **(c) skill / Bash `chorus` CLI** — inherit the env (and `CHORUS_AGENT_PROFILE` pins
  which agent the CLI resolves from `daemon.json`).

> **Hallucination-aware:** the implementer MUST re-verify this behavior (env injection
> timing, `${VAR}` interpolation in `.mcp.json` `url`/`headers`, and the
> unexpanded-placeholder-on-missing-var behavior) against the official Claude Code docs
> ([mcp.md](https://code.claude.com/docs/en/mcp.md),
> [env-vars.md](https://code.claude.com/docs/en/env-vars.md)) attached to the idea, rather
> than trusting model memory or this document.

### Precedence: settings.json `env` overrides the shell (VERIFIED against docs)

env-vars.md · *Precedence* (verified 2026-08-26): *"When the same variable is set in both
your shell and a settings file `env` block, the settings file value applies. Claude Code
writes each `env` entry into the process environment at startup and again when the file
changes, **replacing the value inherited from the shell**. A few variables are
special-cased…"* So our write is **authoritative**: interactive Claude Code uses the
settings.json identity even if the user's shell exports a different `CHORUS_*` — which is
exactly what makes "zero manual export" reliable. The flip side is a surprise for a user
who deliberately exported another identity in their shell; see the heads-up below. This
precedence MUST be stated in the user docs (task 2).

### Ambient-shell conflict heads-up (elaboration R2 → a)

Because settings.json wins, `chorus agents add` SHALL print a one-line heads-up when it
detects that the **ambient shell** (the `env` the command itself runs under) already
carries a **different** `CHORUS_*` identity than the one being written — so the operator
knows their shell export will be overridden for interactive Claude Code. Detection never
PRINTS a secret, but an in-memory equality check is fine (reviewer Note 2): the **primary
signal** is comparing `env.CHORUS_AGENT_PROFILE` (a UUID) to the agent being written;
`env.CHORUS_API_KEY`, when present, MAY also be compared **in memory** to the key being
written (a plain `!==`, never printing either value). The heads-up fires when either
differs. Same identity, or nothing exported, prints nothing. This is a heads-up, not a
warning-of-failure — the write still succeeds and is authoritative.

## Architecture

### New writer: `writeClaudeSettingsEnv`

Signature mirrors `writeDshCredentialsEnv`:

```
writeClaudeSettingsEnv({ settingsPath, url, apiKey, agentProfile }, deps?) -> string  // path written
```

Behavior:

1. **Read + parse** the existing `settings.json` if present. On a **missing** file →
   start from `{}`. On an **existing but unparseable** file → **throw** (do NOT clobber
   a file we cannot safely merge — the caller treats a throw as a write failure, Q4).
2. **Merge**: set `parsed.env = { ...parsed.env, CHORUS_URL: url, CHORUS_API_KEY: apiKey,
   CHORUS_AGENT_PROFILE: agentProfile }`. Every other `env` key and every other top-level
   settings field is preserved verbatim. Only these three managed keys are (re)written;
   an existing user value for one of the three is overwritten to the freshly-seeded value
   (idempotent — a re-run with the same values reproduces the file).
3. **Atomic 0600 write**: `JSON.stringify(parsed, null, 2)` to a temp file (mode `0o600`)
   in the same dir, then `rename` over the target. Create `~/.claude` if absent.
4. Return the path. The API key is only ever written into the 0600 file — never argv,
   never a log. (`CHORUS_AGENT_PROFILE` is a UUID, not a secret.)

Dependency-injection seams (`read` / `write` / `mkdir` / `rename`) match
`writeDshCredentialsEnv` so unit tests stay pure.

### Choosing the identity — cross-run REPOINT detection (elaboration Q2 → b)

**Reviewer B2 correction.** `resolveSelection` (`cli/init/select.mjs`) validates against a
registry of unique harness ids and the interactive checklist dedups, so a **single**
`chorus agents add` run configures the `claude` id **at most once**. There is no
"2+ Claude identities in one run" branch to prompt over — that would be dead code. The
multi-identity case is therefore **across repeated runs**: `settings.json` is
last-write-wins, and the real hazard is *silently repointing* the machine's interactive
identity. Q2 → b ("write a chosen default; never silently pick the wrong one") is realized
as **repoint detection**, gated on the `claude` selection id (exactly how dsh gates on the
`dsh` id):

Before writing, read the existing `env.CHORUS_AGENT_PROFILE` from `~/.claude/settings.json`
and compare (by **UUID**, never by key) to the identity being written:

- **absent** (no CHORUS_* env yet) → write the new identity.
- **present and equal** → idempotent no-op re-write; no prompt, no warning.
- **present and different (repoint)** → NEVER silent:
  - on a **TTY**, prompt "Interactive Claude Code is currently configured as `<old>`;
    repoint it to `<new>`?" (default **No** → skip the write; the new agent remains
    reachable via `chorus mcp` / the daemon, and the operator gets the actionable note
    below to wire it interactively later);
  - **non-TTY**, overwrite **and** emit a WARNING that the interactive identity was
    repointed from `<old-uuid>` to `<new-uuid>`.

### Hint suppression + failure/decline UX (elaboration Q4 → a)

- On a **successful** write the chosen agent's `credential-seed` outcome carries a new flag
  `settingsEnvWritten: true` (parallel to dsh's `profileInEnv: true`); `profileExportHint`
  (`cli/init.mjs`) is extended to skip any outcome carrying it. The write already put
  CHORUS_URL/KEY/PROFILE in `settings.json`, so that session is fully wired — no hint
  needed for it.

- **Reviewer B1 correction — the failure/decline path is NOT "just keep the profile
  hint".** `profileExportHint` prints only `export CHORUS_AGENT_PROFILE=` (a UUID); it
  never prints URL/KEY and therefore **cannot** fix the native MCP client, which
  interpolates `${CHORUS_URL}` / `${CHORUS_API_KEY}` from env — and a hint that *did* print
  the key would violate the never-echo invariant. So when the write **fails** (or a TTY
  repoint is **declined**) the command emits a distinct, **actionable WARNING** that:
  - names the three keys the interactive session needs (`CHORUS_URL`, `CHORUS_API_KEY`,
    `CHORUS_AGENT_PROFILE`),
  - tells the operator to add them to `~/.claude/settings.json`'s `env` block (or export
    them in the shell), and
  - **references the API key without printing its value** (e.g. "the `cho_…` key you just
    entered") — preserving never-echo.

  The `CHORUS_AGENT_PROFILE` export hint MAY still print (it helps the hook/CLI path), but
  it is NOT presented as sufficient to connect native MCP; the WARNING is. The existing
  file is never clobbered.

  **Reviewer Note 1 — the "or export in the shell" alternative depends on the sub-case.**
  On a *write failure* nothing sits in `settings.json` `env`, so a shell export DOES take
  effect → the WARNING may offer "add to settings.json OR export". On a *declined repoint*
  the existing (different) `settings.json` identity REMAINS and — per the precedence above
  — would OVERRIDE a shell export, so that message MUST say "the existing settings.json
  identity stays active; edit `~/.claude/settings.json` to change it" and MUST NOT suggest
  a shell export as a fix.

### `chorus agents remove` note (reviewer note; dsh parallel)

Reverse-cleanup stays **out of scope** (Q3 → a): `chorus agents remove` does NOT strip the
CHORUS_* keys from `~/.claude/settings.json`. But — mirroring the existing dsh
`$DSH_HOME/.env` "left untouched, clear manually" note on the removal requirement — the
command SHALL print a one-line note that `~/.claude/settings.json` may still carry the
removed agent's CHORUS_* env and can be cleared by hand. Note only; no key removal.

## Module Contracts

- **Outcome flag**: `credential-seed` outcomes MAY carry `settingsEnvWritten: true`.
  `cli/init.mjs profileExportHint` MUST treat it identically to the existing
  `profileInEnv` short-circuit (`continue` past that agent).
- **Never echo the key**: neither the writer, the summary, nor the warning path prints
  `apiKey`; only the settings.json **path** and non-secret fields (URL, profile UUID) may
  be surfaced. Same invariant already enforced for dsh.
- **Repoint comparison uses the UUID** (`CHORUS_AGENT_PROFILE`), never the key.
- **Target file**: ONLY `~/.claude/settings.json` (resolve `~` via `homedir()`, honoring
  a test-injected home). Never a project `.claude/settings.json` and never
  `.claude/settings.local.json` (Q1 → user-global only).

## Implementation Plan

1. Add `writeClaudeSettingsEnv` to `credential-seed.mjs` with its DI seams + JSDoc.
2. In `seedCredentials`, for the `claude` selection: read existing
   `env.CHORUS_AGENT_PROFILE`, apply repoint detection (write / idempotent / prompt-or-warn),
   call the writer, and stamp `settingsEnvWritten` (success) or a WARNING (failure/decline)
   on the agent's outcome.
3. Extend `profileExportHint` suppression in `cli/init.mjs`.
4. Emit the ambient-shell conflict heads-up (compare `env.CHORUS_AGENT_PROFILE` / key
   presence to the identity being written; non-secret; only on a genuine mismatch).
5. Add the one-line `~/.claude/settings.json` "clear manually" note to `chorus agents
   remove` (`cli/agents.mjs`), mirroring the dsh `$DSH_HOME/.env` note.
6. Unit + integration tests (see tasks).
7. Sweep docs / skill surfaces (including the settings.json-`env` > shell precedence).

## Risks & Mitigations

- **Clobbering a hand-edited settings.json** → never write on parse failure; atomic
  temp+rename; preserve all unmanaged keys. Unit-tested with a populated fixture.
- **Silent identity repoint across runs** → repoint detection (prompt on TTY / warn on
  non-TTY); idempotent when unchanged. Covered by integration tests.
- **Secret leak** → key only in the 0600 file, never printed (writer, summary, warning,
  remove-note); project git-tracked file never targeted.
- **Non-functional fallback (B1)** → the failure/decline WARNING gives real, non-secret
  instructions rather than relying on the profile-only export hint.
- **Docs drift** → verify env-injection semantics against official docs at implementation
  time rather than trusting memory.

## Out of Scope

- `chorus agents remove` reverse-cleanup of these env keys (Q3 → a) — note only, no removal.
- Project-level / `.claude/settings.local.json` / per-cwd targets (Q1 → user-global only).
- Any other harness (Codex/Kiro/opencode/OpenClaw) — separate sibling ideas under `9d1549ba`.
- `design.pen`: no new UI screen (CLI-only); Install Guide copy edits in the docs task are
  text-only and owner-waivable per prior CLI-only changes.
