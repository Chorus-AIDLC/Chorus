# Design — Codex credential sink → `~/.codex/.env`

## Context

Prior work (idea 31400d33, branch `feat/codex-config-env-injection`, unmerged) shipped a
Codex credential write into `config.toml` `[shell_environment_policy].set`. That closed the
shell-tool path but left interactive plugin hooks needing a manual `export`. This refactor
moves the sink to `~/.codex/.env` for full Claude-Code parity, on the same branch (one
coherent PR that ships the correct design).

## Env-injection mechanisms in codex-cli 0.150.1 (source-verified)

Which config surface reaches which Codex subprocess type — the whole basis for the sink
choice:

| Mechanism | exec/shell tool | plugin hooks | native MCP (HTTP) | Evidence |
|---|---|---|---|---|
| `config.toml` `[shell_environment_policy].set` | ✅ | ❌ | ❌ | `protocol/src/shell_environment.rs:90` (`populate_env` step 4); `core/src/unified_exec/process_manager.rs:1285` |
| plugin hook process env | — | ✅ = Codex process env snapshot + 4 `*PLUGIN*` vars only | — | `hooks/src/registry.rs:77` (`std::env::vars_os()`); `hooks/src/engine/command_runner.rs` (`env_clear()`→`envs(snapshot)`+`envs(plugin)`); `hooks/src/engine/discovery.rs:261` |
| **`~/.codex/.env` (dotenv)** | ✅ (`inherit=All`, default excludes off) | ✅ (loaded into process env → hook snapshot) | ❌ | `arg0/src/lib.rs:159` `load_dotenv()`, `:303` `find_codex_home().join(".env")`, `:312` `set_filtered`→`std::env::set_var` (filters only `CODEX_*`; overrides shell) |
| `[mcp_servers.chorus]` `bearer_token_env_var` (HTTP MCP auth) | — | — | ✅ | HTTP transport; resolves `CHORUS_API_KEY` from the process env (which `~/.codex/.env` populates) → `Authorization: Bearer <key>`. Written **by Chorus** (keyless), NOT by `codex plugin add` — see Decision 7. |

**Conclusion.** `~/.codex/.env` is the only single write that reaches BOTH hooks and the shell
tool. Combined with the keyless `[mcp_servers.chorus]` `bearer_token_env_var` block (Decision 7),
which resolves the key from that same `.env`, it makes interactive Codex fully export-free —
matching CC's `settings.json` `env` model, including
its **override-the-shell** precedence (`.env` uses `set_var`, which overwrites an existing
ambient value).

## Decisions

### 1. Sink = `~/.codex/.env`, replacing the config.toml policy write

Remove the `config.toml` `[shell_environment_policy].set` write from credential-seed. `.env`
covers the shell tool too (`inherit=All`), so keeping both would be a redundant second secret
sink. `config.toml` is no longer touched by **credential-seed**. (The native-MCP block IS
written into `config.toml` — but by the plugin-install step, keyless, per **Decision 7 below**,
which supersedes the earlier assumption that `codex plugin add` writes a literal Bearer.)

### 2. Writer: reuse the dsh dotenv pattern

`writeDshCredentialsEnv` (same file) is a tested dotenv upsert: 0600, atomic temp+rename,
idempotent, merge-preserving (replaces managed keys in place, drops duplicates, tolerates an
`export ` prefix, preserves unrelated lines), key never echoed. The Codex writer is the same
shape targeting `resolveCodexEnvPath(env)` = `(CODEX_HOME || ~/.codex)/.env`.

- **Preferred:** extract a shared `upsertDotenv({ path, managed })` helper that both
  `writeDshCredentialsEnv` and the new `writeCodexEnvFile` call, so the invariants live in one
  place. If extraction proves invasive to dsh's tested behavior, fall back to a
  `writeCodexEnvFile` that mirrors dsh's proven code (still one small, well-tested function).
  Either way the observable behavior and tests are the contract.

### 3. Repoint detection mirroring Claude Code (closes N1)

Add `readCodexEnvProfile(path)` — parse `~/.codex/.env` (via `node:util` `parseEnv`, as the
dsh tests already do) and return its `CHORUS_AGENT_PROFILE`, or undefined on
missing/unreadable. In the codex-only block, mirror the CC `isRepoint` branch: if an existing
profile differs (by UUID) from the identity being written, TTY prompts before overwriting
(declining leaves the existing identity and directs the operator to edit `~/.codex/.env`, not
export — because `.env` overrides the shell); non-TTY overwrites with a WARNING naming
old→new. Equal identity = idempotent re-write. Comparison uses the UUID, never the key.

### 4. Success note + hint suppression

On success, set `codexEnvWritten` (unchanged flag; `init.mjs` already suppresses the
`export CHORUS_AGENT_PROFILE` hint on it). The success note becomes accurate and simpler than
today's: the write wires BOTH the interactive hooks (SessionStart check-in / PostToolUse) AND
the shell-tool `chorus` calls with no manual export — the old "hooks residual, start from an
exporting shell" caveat is deleted. No wrapper. Key never echoed. On failure: actionable
WARNING naming the three keys + how to set them in `~/.codex/.env` (or export), key value
never printed.

### 5. Plugin mode — keep the `codex plugin add` marketplace install (unchanged)

`chorus agents add` already installs the Codex plugin via `codex plugin marketplace add
Chorus-AIDLC/Chorus` + `codex plugin add chorus@chorus-plugins --json`
(`install-methods.mjs:115,118`) — the native marketplace mode, which registers the hooks. That
is already the most appropriate plugin mode (the closest analogue to CC's plugin install); the
`.env` sink is precisely what lets those already-registered hooks fire. We keep the marketplace
install **unchanged** — no migration to any other plugin mode. (The plugin-install step DOES
gain a keyless `[mcp_servers.chorus]` writer per **Decision 7**, because `codex plugin add`
does not write the MCP block itself.)

### 6. Daemon-wake path unchanged

`cli/codex-spawner.mjs:272-283` sets `CHORUS_URL`/`CHORUS_API_KEY`/`CHORUS_AGENT_PROFILE`
directly on the spawned child's env — already export-free and independent of both the
interactive sink and `~/.codex/.env`. Not touched.

### 7. Chorus writes `[mcp_servers.chorus]` with `bearer_token_env_var` (added mid-implementation)

Spikes against codex-cli 0.150.1 established:
- `codex plugin add`'s `authentication: ON_INSTALL` is **metadata only** — it never prompts and never writes `[mcp_servers.chorus]` (`cli/src/plugin_cmd.rs:151-176`; `core-plugins/src/manager.rs:2033,2098`). The `authentication` enum has only `ON_INSTALL`/`ON_USE` (no "off"), so it is not a lever.
- Our plugin bundle manifest declares no `mcpServers`, so **nothing in the `chorus agents add` flow writes `[mcp_servers.chorus]` today** — the native MCP server is only configured by manual user edits (a gap).
- `[mcp_servers.chorus]` with only `url` + `bearer_token_env_var = "CHORUS_API_KEY"` is a valid StreamableHttp config (`config/src/mcp_types.rs:447,535-552`); Codex resolves the env var → `Authorization: Bearer <key>` at connect (`codex-mcp/src/rmcp_client.rs:831-856,1176`). `${VAR}` in a plain `http_headers` value is NOT expanded — hence the dedicated field, not string interpolation.

Decision: `chorus agents add` writes `[mcp_servers.chorus]` itself, keyless, via `bearer_token_env_var = "CHORUS_API_KEY"` (the key stays only in `~/.codex/.env`). Home: `install-methods.mjs` `installCodex`, AFTER `codex plugin add` (authoritative; no race — ON_INSTALL writes nothing) and on the already-installed idempotent path. New module `cli/init/codex-mcp-config.mjs` (`resolveCodexConfigPath`, `codexMcpUrl` `/api/mcp` normalization, `writeCodexMcpServer` targeted TOML upsert that also strips a legacy literal `http_headers.Authorization`). Mirrors Kiro's existing env-ref MCP install (`install-methods.mjs:372`).

**Bonus (daemon-wake MCP auth fix):** the spawner exports `CHORUS_API_KEY` into the woken child (`codex-spawner.mjs:272-283`); with `bearer_token_env_var` that key now reaches Codex MCP auth — previously blocked because a literal `config.toml` Bearer ignored the daemon-exported key (`codex-spawner.mjs:16-22`). No launcher wrapper.

## Change surface

- `cli/init/steps/credential-seed.mjs`: replace `writeCodexShellEnvCreds` →
  `writeCodexEnvFile` (dotenv); `resolveCodexConfigPath` → `resolveCodexEnvPath`; add
  `readCodexEnvProfile`; keep `isCodexSelection`; rewire the codex-only block (repoint +
  export-free success note + failure WARNING); keep `codexEnvWritten`.
- `cli/init.mjs`: `profileExportHint` still keys on `codexEnvWritten` — no logic change
  (comment updated to say `.env`).
- `cli/agents.mjs`: remove-note points at `~/.codex/.env` (+ the untouched config.toml
  Bearer).
- Tests: `cli/__tests__/init-credential-seed.test.mjs` — rewrite the `writeCodexShellEnvCreds`
  block to the dotenv writer (create/preserve-unrelated/idempotent/0600, parseEnv round-trip),
  and the seedCredentials codex block (writes `.env`, single-agent still written, repoint
  TTY/non-TTY, export-free success note, failure WARNING, non-codex untouched). Adjust the
  `init.test.mjs` / `agents.test.mjs` codex assertions.
- Docs/i18n: `docs/CONNECT_CODEX.md`/`.zh.md`, `messages/{en,zh,ja,ko}.json` `step2Tip`.

## Risks & mitigations

- **`.env` override precedence.** `set_filtered` `set_var` overwrites an ambient shell
  `CHORUS_*`; this matches CC's `settings.json` precedence and is why repoint detection +
  "edit the file, don't export" guidance exist. Documented.
- **Plaintext key.** `~/.codex/.env` holds `cho_` at 0600 — same as today's config.toml
  Bearer / CC settings.json. No new exposure.
- **Live interactive parity** (hooks actually fire from `.env`) is source-conclusive but not
  unit-testable; a live interactive Codex E2E is a manual owner step (headless can't drive an
  interactive session). Called out, not silently skipped.
- **dotenvy edge cases** (quoting/`export` prefix) are already covered by the dsh writer's
  tests and `node:util` `parseEnv` round-trip assertions, which the Codex tests reuse.
