# Write Chorus credentials into Codex `config.toml` `[shell_environment_policy]` for interactive launch

## Why

Codex's native MCP is already export-free — `chorus agents add` (via `codex plugin add`) writes a **literal** `[mcp_servers.chorus]` `Authorization: Bearer <key>` into `~/.codex/config.toml`, and Codex does not expand `${VAR}` in `http_headers`, so native MCP authenticates with no shell env. But the **plugin hook / CLI layer does not**:

- `plugins/chorus/hooks/on-session-start.sh:16-22` HARD-requires `CHORUS_URL`+`CHORUS_API_KEY` in the environment — else it prints "not configured" and skips the SessionStart checkin.
- `plugins/chorus/hooks/chorus-mcp-call.sh` resolves via `CHORUS_AGENT_PROFILE` (+ the `chorus` CLI ≥ 0.17.0) **or** `CHORUS_URL`+`CHORUS_API_KEY`; it **never** makes a bare auto-single `chorus mcp call`, so `resolveMcpCredentials`' auto-single is unreachable through the hooks.

So after `chorus agents add`, an INTERACTIVE Codex launched by hand has **no** Chorus env, and its plugin hooks silently degrade (checkin skipped) — for a **single** agent as much as for multiple (the earlier "single-agent already export-free" assessment was wrong for the hook layer; native MCP tools still work, the hooks don't). The daemon-wake path already injects all three vars at spawn (`cli/codex-spawner.mjs:277-283`), precisely because the hooks need them; this change brings the interactive path to parity.

This mirrors the just-shipped Claude Code sibling (idea `b24be271`, change `add-claude-settings-env-injection`), which writes `CHORUS_URL` / `CHORUS_API_KEY` / `CHORUS_AGENT_PROFILE` into `~/.claude/settings.json` `env`. Owner direction (idea comment): **reference the Claude Code plugin implementation; prefer the `chorus` CLI ≥ 0.17.0 + `CHORUS_AGENT_PROFILE` path, fall back to url+apikey** — which is exactly the resolution order the Codex `chorus-mcp-call.sh` and the CC `chorus-api.sh:253-281` already implement.

## What Changes

- `chorus agents add`, for a selected Codex (`codex`) agent, writes `CHORUS_URL` + `CHORUS_API_KEY` + `CHORUS_AGENT_PROFILE` into the `[shell_environment_policy]` `set` table of that agent's `~/.codex/config.toml`, via an idempotent, TOML-preserving, `0600` atomic upsert. The literal `[mcp_servers.chorus]` Bearer written by `codex plugin add` is left intact (native MCP unchanged).
- **Ungated — for EVERY selected Codex agent** (single- and multi-agent alike), because the hooks need the env even for one agent (they never auto-single). Mirrors how CC writes `settings.json` env unconditionally.
- **Resolution order is unchanged and needs no hook edit.** Writing all three makes both paths available: the hook/CLI layer prefers `CHORUS_AGENT_PROFILE` + `chorus` CLI (key read from `daemon.json`) and falls back to url+key when the CLI is absent/old; and url+key satisfy `on-session-start.sh`'s preflight. No plugin-hook code change; no `chorus launch codex` wrapper (owner rejected the wrapper).
- **One honest unknown (spike, task 2).** `[shell_environment_policy].set` governs Codex's exec/shell tool, so it reliably covers the model's own `chorus` shell calls. Whether it also reaches Codex's plugin lifecycle hook subprocesses (a separate spawn path, `codex-rs/core/src/hook_runtime.rs`) is verified against the installed `codex`. If hooks do NOT inherit it, the shell-tool path still works and the residual hook gap is surfaced via an actionable WARNING + the manual `export` hint — never a wrapper, never a silent skip.
- **On success** the manual `export` hint for that agent is suppressed. **On write failure** (locked/unwritable, or malformed/ambiguous existing TOML) the file is never clobbered and a WARNING names the three env keys and how to set them, referencing the API key without printing it.
- Docs / skill surfaces are updated to reflect that interactive Codex no longer needs a manual export after `chorus agents add`.

## Capabilities

- `chorus-init` —
  - **MODIFIED** "Per-selected-agent credential seeding into centralized daemon config": add the Codex `~/.codex/config.toml` `[shell_environment_policy]` env write to the enumerated set of governed convenience key-writes (daemon.json stays the source of truth).
  - **MODIFIED** "Agent removal via `chorus agents remove`": add `~/.codex/config.toml` to the credential side-files left untouched with a clear-manually note (Q6 → a).
  - **ADDED** "Codex interactive credentials via `config.toml` `[shell_environment_policy]`".

## Impact

- **Code:** `cli/init/steps/credential-seed.mjs` (new `writeCodexShellEnvCreds` + wiring for the `codex` selection), `cli/init.mjs` (`profileExportHint` suppression via a `codexEnvWritten` flag), `cli/agents.mjs` (one-line `~/.codex/config.toml` note on `remove`), `cli/__tests__/*`. No plugin-hook change (the resolution order already exists).
- **Docs/skill:** `docs/CONNECT_CODEX.md` (+ `.zh`), the in-app Install Guide + i18n (en/zh/ja/ko), the `chorus-cli` skill env section, `docs/MCP_TOOLS.md` if it references a Codex manual export.
- **Verification:** a spike against the installed `codex` CLI to determine hook-subprocess coverage of `[shell_environment_policy].set`; the finding is baked into the design doc and the fallback behavior.
- **Secret posture (literal_0600):** the API key gains a second on-disk copy — the `[shell_environment_policy].set` env value alongside the existing `[mcp_servers.chorus]` Bearer, both in the `0600` `config.toml`. This is inherent to Codex (its `http_headers` can't reference an env var, so the two consumers need two forms) and is consistent with CC (`settings.json` env) and dsh (`$DSH_HOME/.env`). No key is ever printed.
- **Out of scope:** the `chorus launch codex` wrapper (owner rejected); the macOS-GUI-can't-read-shell-env path (elaboration Q3 → c); `chorus agents remove` reverse-cleanup (Q6 → a — note only); every other harness (separate sibling ideas under `9d1549ba`).
- No DB schema, no server change, no new dependency. Backward compatible: an existing `config.toml` (or its absence) is preserved/created without disturbing unrelated sections; single-agent daemon-wake behavior is unchanged.
