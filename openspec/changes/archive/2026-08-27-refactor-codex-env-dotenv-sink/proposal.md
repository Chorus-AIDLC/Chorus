# Refactor Codex `agents add` credential sink → `~/.codex/.env` (Claude-Code parity)

## Why

`chorus agents add` currently writes the three Chorus credential vars (`CHORUS_URL`,
`CHORUS_API_KEY`, `CHORUS_AGENT_PROFILE`) into `~/.codex/config.toml`
`[shell_environment_policy].set`. Verified against **codex-cli 0.150.1** source, that table
only feeds Codex's **exec/shell tool** (`create_env`/`populate_env` in
`protocol/src/shell_environment.rs`) — it does **not** reach Codex's **plugin lifecycle
hooks**. Hooks `env_clear()` then replay a snapshot of Codex's own process env
(`hooks/src/registry.rs` → `std::env::vars_os()`) plus four `*PLUGIN*` path vars, and the
hook config has no `env` field. So an INTERACTIVE Codex session's SessionStart check-in and
PostToolUse hooks (`plugins/chorus/hooks/on-session-start.sh:16` hard-requires
`CHORUS_URL`+`CHORUS_API_KEY`) still need the user to `export` in the launching shell — the
exact gap versus Claude Code, whose one `~/.claude/settings.json` `env` write covers native
MCP + hooks + shell with no export.

Codex has an equivalent single-write mechanism we did not use: **`~/.codex/.env`**. Its arg0
dotenv loader (`codex-rs/arg0/src/lib.rs:159` `load_dotenv()` → `:303`
`find_codex_home().join(".env")` → `:312` `set_filtered` `std::env::set_var`) loads the file
into Codex's **own process env** at startup, filtering only `CODEX_*` keys (our `CHORUS_*`
pass) and **overriding** ambient shell values. That process env is what hooks snapshot and
what the shell tool inherits (`inherit=All`, default excludes off so `CHORUS_API_KEY`
survives). ⇒ `~/.codex/.env` is the Codex analogue of CC's `settings.json` `env`: one write
covers **hooks + shell tool**, export-free.

Native MCP uses that same key: `chorus agents add` writes a **keyless** `[mcp_servers.chorus]`
into `config.toml` with `bearer_token_env_var = "CHORUS_API_KEY"` (HTTP transport, not stdio
`env`), which Codex resolves from the same `~/.codex/.env` process env into
`Authorization: Bearer <key>` at connect. (Codex does NOT expand `${VAR}` inside `http_headers`,
so the dedicated `bearer_token_env_var` field is used — no literal key in `config.toml`.) So
`~/.codex/.env` + the keyless MCP block = **interactive Codex fully export-free — hooks, shell
tool, and native MCP** — true Claude Code parity, with the key in exactly one place.

## What Changes

1. **Credential sink swap (core).** The Codex branch of the credential-seed step writes the
   three vars into `~/.codex/.env` (dotenv upsert) instead of `config.toml`
   `[shell_environment_policy].set`. The config.toml policy write is removed — it is
   redundant now that `.env` also covers the shell tool. Reuses the existing, tested dsh
   dotenv-writer pattern (`writeDshCredentialsEnv`): 0600, atomic temp+rename, idempotent,
   merge-preserving upsert, key never echoed, tolerates an `export ` prefix.
2. **Keyless native-MCP block.** `chorus agents add` writes `[mcp_servers.chorus]` into
   `config.toml` with `url` + `bearer_token_env_var = "CHORUS_API_KEY"` (no literal key), after
   `codex plugin add` (which does not write it — its `ON_INSTALL` is metadata-only). Any legacy
   literal `Authorization` is migrated away. This also fixes daemon-wake MCP auth (the
   spawner-exported `CHORUS_API_KEY` now reaches Codex MCP). credential-seed itself never
   touches `config.toml`.
3. **CC-parity repoint detection (closes prior code-review N1).** Because `.env` overrides
   the shell, a cross-run identity change is detected (read existing
   `CHORUS_AGENT_PROFILE` from `~/.codex/.env`): TTY prompt, non-TTY WARNING — mirroring the
   Claude Code `readClaudeSettingsProfile` behavior.
4. **Plugin mode: keep `codex plugin add` marketplace (already the most appropriate).** The
   investigation confirmed `chorus agents add` already installs via
   `codex plugin marketplace add` + `codex plugin add chorus@chorus-plugins`
   (`install-methods.mjs:115,118`) — the native plugin mode that registers hooks (it does NOT
   write the MCP block — Chorus does, per #2). No migration is needed; the `.env` sink is what
   makes those already-registered hooks actually fire.
5. **Removal note + docs.** `chorus agents remove <codex>` note points at `~/.codex/.env`
   (creds left, cleared manually) alongside the untouched keyless `config.toml`
   `[mcp_servers.chorus]` block. Docs
   (`CONNECT_CODEX` en/zh), `messages/{en,zh,ja,ko}.json` `step2Tip`, and the OpenSpec
   `chorus-init` spec are updated from "config.toml + export residual" to "`~/.codex/.env`,
   export-free (hooks included)".

## Capabilities

- `chorus-init` — modifies the Codex credential-seed sink, the removal side-file note, and
  the seeding-exception clause; replaces the Codex interactive-credentials requirement; and
  adds a requirement for the keyless `config.toml` `[mcp_servers.chorus]` `bearer_token_env_var`
  block.

## Impact

- **Behavior:** interactive Codex hooks (check-in / PostToolUse) run with no manual export —
  the "start codex from a shell exporting the three vars" residual disappears — and native MCP
  authenticates from the same `~/.codex/.env` (via `bearer_token_env_var`), including for
  daemon-woken sessions (previously blocked by a literal `config.toml` key).
- **Code:** `cli/init/steps/credential-seed.mjs` (dotenv writer + helpers + codex block),
  `cli/init/codex-mcp-config.mjs` (new — keyless `[mcp_servers.chorus]` writer) +
  `cli/init/install-methods.mjs` `installCodex` wiring, `cli/init.mjs` (hint suppression,
  unchanged flag), `cli/agents.mjs` (remove note), `cli/codex-spawner.mjs` (comment); tests.
- **Docs/i18n:** `docs/CONNECT_CODEX.md`/`.zh.md`, `messages/{en,zh,ja,ko}.json`,
  `plugins/chorus/{README.md,skills/chorus/SKILL.md}`.
- **Security:** `~/.codex/.env` stores the `cho_` key in plaintext at 0600 — the SAME
  sensitivity as CC's `settings.json` (and the literal Bearer the old manual Codex setup
  required); the key is now in exactly one place and `config.toml` holds no literal key, so
  the net exposure surface shrinks.
- **Daemon-wake unaffected:** `cli/codex-spawner.mjs` sets `CHORUS_*` on the spawned child
  directly and is independent of both the interactive sink and `.env`.
- **Out of scope:** sibling harnesses (Kiro / opencode / OpenClaw); any live interactive E2E
  is a manual owner step (headless cannot drive an interactive Codex session).
