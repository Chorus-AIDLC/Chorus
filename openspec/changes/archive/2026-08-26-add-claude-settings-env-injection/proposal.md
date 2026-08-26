# Write Chorus credentials into Claude Code's `settings.json` env

## Why

Today `chorus agents add` seeds each agent's Chorus credentials only into the
centralized `~/.chorus/daemon.json`. The Claude Code plugin ships a `.mcp.json`
whose `url` / `Authorization` header reference `${CHORUS_URL}` / `${CHORUS_API_KEY}`.
Those variables are **not** set anywhere for an interactive session, so a human who
launches Claude Code by hand must first `export CHORUS_URL` and `export CHORUS_API_KEY`
themselves — and today's `profileExportHint` only prints the optional
`CHORUS_AGENT_PROFILE` line, never the URL/key the native MCP client actually needs.
The result: after `chorus agents add`, interactive Claude Code silently connects with
an **unexpanded `${CHORUS_API_KEY}`** placeholder and the Chorus MCP tools never appear.

Claude Code exposes exactly the right hook: the `env` block in `settings.json` is
injected at session start, **before** the MCP client connects, and it also reaches
hook subprocesses and the Bash/CLI `chorus` calls. Writing three keys there covers the
native MCP auth, the plugin hooks, and the skill CLI in **one place** — no manual
export. This is the ✅-confirmed-by-docs Claude Code half of the cross-harness
credential-injection research (parent idea `9d1549ba`), and it mirrors the already-shipped
dsh `$DSH_HOME/.env` credential channel.

## What Changes

- `chorus agents add`, for a selected Claude Code (`claude`) agent, writes
  `CHORUS_URL` / `CHORUS_API_KEY` / `CHORUS_AGENT_PROFILE` into the **user-global**
  `~/.claude/settings.json` `env` block via an idempotent, merge-preserving,
  0600 atomic upsert (never touching a git-tracked project `.claude/settings.json`).
- **Multi-agent (elaboration Q2 → b), corrected for the real flow:** a single
  `chorus agents add` run configures the `claude` id at most once (`resolveSelection`
  dedups), so multiple Claude Code identities arise only across *repeated* runs. The
  command detects a **repoint** — an existing `env.CHORUS_AGENT_PROFILE` that differs from
  the identity being written — and never overwrites it silently: prompt on a TTY (decline
  leaves the existing identity), WARN on a non-TTY overwrite. Same identity = idempotent.
- On a successful write the manual `export` hint for that agent is suppressed
  (mirroring dsh's `profileInEnv`).
- **Precedence (verified against docs; elaboration R2 → a):** settings.json `env`
  OVERRIDES shell/CLI env — Claude Code replaces the shell-inherited value at session
  start — so our write is authoritative. `chorus agents add` prints a one-line non-secret
  heads-up when the ambient shell already exports a *different* CHORUS_* identity, and the
  docs state the precedence.
- **Failure / declined repoint (elaboration Q4 → a):** the file is **never** clobbered.
  Because `profileExportHint` prints only `CHORUS_AGENT_PROFILE` (never URL/KEY) it cannot
  fix native MCP, so the command emits an **actionable WARNING** naming all three env keys
  and how to add them to `settings.json` — **referencing the API key without printing it**
  (never-echo preserved).
- Documentation and skill surfaces are updated to reflect that interactive Claude Code no
  longer requires a manual export after `chorus agents add`.

## Capabilities

- `chorus-init` — MODIFIED: (1) relax the blanket "MUST NOT write any API key into a
  coding-agent's own config file" clause into a scoped-exception invariant (daemon.json
  remains the source of truth; convenience writes are governed by their own requirements);
  (2) add a dsh-parallel "left untouched, clear manually" note for `~/.claude/settings.json`
  to the `chorus agents remove` requirement. ADDED: "Claude Code interactive credentials
  via `~/.claude/settings.json` env".

## Impact

- **Code:** `cli/init/steps/credential-seed.mjs` (new `writeClaudeSettingsEnv` + repoint
  wiring), `cli/init.mjs` (`profileExportHint` suppression), `cli/agents.mjs` (one-line
  settings.json note on `remove`), `cli/__tests__/*`.
- **Docs/skill:** `docs/CONNECT_CLAUDE_CODE.md` (+`.zh`), in-app Install Guide + i18n
  (en/zh/ja/ko), the `chorus-cli` skill env section across its surfaces, `docs/MCP_TOOLS.md`
  if it references the manual export.
- **Out of scope (elaboration Q3 → a):** `chorus agents remove` does NOT strip these env
  keys (it prints a one-line "clear manually" note, mirroring dsh's `$DSH_HOME/.env`); a
  later re-add overwrites them idempotently. Project-level / `.local.json` targets and
  per-cwd writes are out of scope (Q1 → user-global only).
- No DB schema, no server change, no new dependency. Backward compatible: an existing
  `settings.json` (or its absence) is preserved/created without disturbing unrelated keys.
