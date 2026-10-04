# Connect Codex to Chorus

This guide walks through connecting the [Codex CLI](https://github.com/openai/codex) to a running Chorus instance. Codex has its own standalone Chorus plugin (under `plugins/chorus`, published via `.agents/plugins/marketplace.json`) — a separate package from the Claude Code plugin, with its own set of skills and supported features. The `chorus agents add` command wires it into Codex's `~/.codex/config.toml`.

> **Tip:** The in-app setup wizard at **Settings → Setup Guide → Open setup guide** walks you through the same steps interactively, including API-key creation. Use this doc if you prefer a reference you can read end-to-end or automate.

## Prerequisites

- Chorus instance running and reachable (e.g. `http://localhost:8637` or a deployed URL)
- `codex` CLI installed (`npm i -g @openai/codex`)
- A Chorus **API Key** (create one in the Web UI under **Settings → Agents → Create API Key**). Keys start with `cho_`.

## Step 1: Export environment variables

```bash
export CHORUS_URL="http://localhost:8637"
export CHORUS_API_KEY="cho_your_api_key"
```

> Add these to `~/.bashrc` or `~/.zshrc` if you want them to persist across shells.

## Step 2: Run chorus agents add

```bash
chorus agents add --agents codex
```

`chorus agents add` reads `CHORUS_URL` / `CHORUS_API_KEY` from your environment (Step 1). It is idempotent and safe to re-run. It will:

1. Verify `codex` is installed.
2. Register the `chorus-plugins` marketplace (or upgrade it if already registered).
3. Install the Chorus plugin through Codex's own plugin CLI, which writes `[plugins."chorus@chorus-plugins"]` into `~/.codex/config.toml` (backing up your original once) and enables Codex lifecycle hooks. Chorus hooks are bundled in the plugin and load automatically once it is installed.
4. Seed your Chorus credentials once into `~/.chorus/daemon.json`.
5. Write `CHORUS_URL` / `CHORUS_API_KEY` / `CHORUS_AGENT_PROFILE` into `~/.codex/.env` (mode `0600`, idempotent, preserving your other entries). Codex loads this dotenv file into its **own process environment** at startup, so both its plugin hooks and the model's shell-tool `chorus` calls resolve your agent identity with **no manual export**.
6. Write the native-MCP server block `[mcp_servers.chorus]` into `~/.codex/config.toml` with `url` + `bearer_token_env_var = "CHORUS_API_KEY"` — a **keyless** reference (no API key is stored in `config.toml`). Codex resolves that env var (from the `~/.codex/.env` in step 5) into the `Authorization: Bearer <key>` header when it connects to MCP.
7. After credentials and MCP configuration are successfully written, handle an already-running **Codex App Server** as described below. This is separate from the Chorus daemon. Plugin-only refreshes do not enter this restart flow.

If `CHORUS_URL` / `CHORUS_API_KEY` aren't set, `chorus agents add` prompts for them interactively (provided you have a TTY). Don't have the `chorus` CLI yet? Install it globally with `npm install -g @chorus-aidlc/chorus`, then run `chorus agents add --agents codex`.

### What needs no export

For a Codex process started with the updated configuration, the `~/.codex/.env` file supplies the managed credentials without manual exports. Writing this file does **not** refresh an existing App Server's environment, and does not by itself prove connectivity. The credentials are used by:

- **Plugin lifecycle hooks** (the SessionStart check-in and PostToolUse automations) — Codex snapshots its process environment (populated from `~/.codex/.env`) into each hook subprocess, so the check-in fires without exporting anything in your shell.
- **The model's own `chorus` shell calls** (the skill CLI) — resolved from that same process env. Resolution prefers `CHORUS_AGENT_PROFILE` + the `chorus` CLI (≥ 0.17.0, which reads the key from `~/.chorus/daemon.json`) and falls back to `CHORUS_URL` + `CHORUS_API_KEY`.
- **Native MCP tools** — `[mcp_servers.chorus]` uses `bearer_token_env_var = "CHORUS_API_KEY"`, which Codex resolves from the same process env into `Authorization: Bearer <key>` at connect time. The key is never stored in `config.toml` (Codex does **not** expand `${VAR}` inside `http_headers`, which is why the dedicated `bearer_token_env_var` field is used).

> Re-run `chorus agents add` to refresh persisted credentials. Codex uses `~/.codex/.env`; the Chorus CLI also retains agent credentials in `~/.chorus/daemon.json`. Daemon-woken Codex processes receive the three variables from Chorus. The Step 1 exports remain useful for installer and terminal CLI calls; already-running processes still need their own environment refreshed.

### Safely restart an existing App Server

All Codex paths here honor `CODEX_HOME`, falling back to `$HOME/.codex`. After successful configuration, the installer checks restart command support and daemon running state with bounded read-only commands. On supported versions, `codex app-server daemon version` reports the status as JSON; do not assume a `daemon status` command exists.

- **Interactive terminal:** a running, supported daemon gets a dedicated `[y/N]` question warning that restarting can interrupt other sessions. Only an explicit `y` or `yes` permits the restart. The child receives the persisted `CHORUS_URL`, `CHORUS_API_KEY`, and `CHORUS_AGENT_PROFILE` instead of stale inherited values; secrets are not placed in command arguments or diagnostics.
- **Noninteractive, `--yes`, or `CHORUS_DAEMON_HEADLESS=1`:** no restart prompt and no automatic restart. `--yes` does not authorize this disruptive operation. The summary explains what remains pending.
- **No running daemon:** the installer does not start one. **Unsupported/unknown status:** no speculative restart or automatic Codex upgrade. **Failed configuration or declined identity repoint:** no restart with mismatched credentials. **Failed restart:** written configuration remains; read the recovery guidance and retry manually when safe.

The new step reports configuration/restart command outcomes only. It does **not** add credential-validity, MCP discovery, or model-turn verification; existing installer checks are unchanged. A successful restart command is not a claim that MCP is ready. Reopening only the terminal UI may reconnect to the same old backend.

For a deferred restart, first save work in all affected sessions. In a trusted terminal, load only the managed values from the actual dotenv file (without printing them), then restart the supported daemon. This example uses Node's dotenv parser rather than sourcing the file as shell code:

```bash
node --input-type=module <<'JS'
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseEnv } from 'node:util';
import { spawnSync } from 'node:child_process';
const codexHome = process.env.CODEX_HOME || join(process.env.HOME || homedir(), '.codex');
const saved = parseEnv(readFileSync(join(codexHome, '.env'), 'utf8'));
const childEnv = { ...process.env, CODEX_HOME: codexHome };
for (const name of ['CHORUS_URL', 'CHORUS_API_KEY', 'CHORUS_AGENT_PROFILE']) {
  if (!saved[name]?.trim()) throw new Error(`Missing ${name} in Codex dotenv file`);
  childEnv[name] = saved[name];
}
const result = spawnSync('codex', ['app-server', 'daemon', 'restart'], {
  env: childEnv, stdio: 'ignore', timeout: 30000,
});
console.log(result.status === 0 ? 'Restart command succeeded; MCP not verified.' : 'Restart command failed; configuration retained.');
process.exitCode = result.status === 0 ? 0 : 1;
JS
```

Run this only after checking that the intended daemon is running and `codex app-server daemon restart --help` is supported. If either is uncertain, inspect your Codex version's management instructions instead; do not use the example to start an absent service.

## Step 3: Optional manual connection check

This is a user-initiated check, not an automatic installer step, and can use your model provider. After any necessary backend restart, open Codex and type:

```
check in to chorus
```

Codex will call `chorus_checkin()` via the MCP server and report back with your agent identity, permissions, and recent activity. The Chorus workflow skills (`$chorus`, `$develop`, `$proposal`, `$yolo`, etc.) are also available.

## Non-interactive install (CI / sandboxed environments)

Configuration can finish while App Server restart remains pending. No TTY, `--yes`, and headless runs never auto-restart the Codex backend; use a later interactive run or the manual recovery steps above.

Pass the connection explicitly and skip prompts with `--yes` — no TTY required:

```bash
npm install -g @chorus-aidlc/chorus
chorus agents add --agents codex \
  --url https://chorus.example.com \
  --api-key cho_xxx --yes
```

## Troubleshooting

- **`codex not found in PATH`** — Install it: `npm i -g @openai/codex`.
- **`401 Unauthorized`** on `check in` — The process may hold an old key, or the key may be wrong or revoked. Refresh credentials with `chorus agents add` and safely restart any existing App Server. Recreate a revoked key under Settings → Agents. `[mcp_servers.chorus]` uses `bearer_token_env_var`, so there's no literal key to edit in `config.toml`.
- **`Environment variable CHORUS_API_KEY … is not set`** from Codex MCP startup — The resolved Codex `.env` is missing the key, wasn't loaded, or the backend predates the update. Re-run `chorus agents add --agents codex` and follow the safe restart guidance above; exporting a key or reopening the terminal UI alone does not refresh an existing backend.
- **`URL must start with http:// or https://`** — `CHORUS_URL` missing the scheme. Use `http://` or `https://`.
- **Marketplace source conflict** — You previously registered `chorus-plugins` from a different URL. The installer detects this and auto-re-registers; check the `!` warnings it prints.
- **Hook didn't fire on first launch** — Open `/plugins` inside Codex and confirm `chorus@chorus-plugins` is installed/enabled, then open `/hooks` to review/trust the bundled Chorus hooks. Hooks run after the plugin cache is materialized.

## Next

- Skill docs (tools reference): `plugins/chorus/skills/chorus/SKILL.md` (the standalone version served as `/skill/chorus/SKILL.md` on your Chorus instance comes from `public/skill/chorus/SKILL.md`)
- Workflow overview: run `$chorus` inside Codex
- To connect Claude Code instead, see [CONNECT_CLAUDE_CODE.md](CONNECT_CLAUDE_CODE.md)
- For any other MCP-capable agent (Cursor, Continue, custom, etc.), see [CONNECT_OTHER_AGENTS.md](CONNECT_OTHER_AGENTS.md)
