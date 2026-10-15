# Connect TRAE CLI to Chorus

This guide connects [TRAE CLI](https://www.trae.ai/) (`traecli`) to a running Chorus instance. TRAE CLI is a fork of Codex, so Chorus reuses the **Codex plugin package** (`plugins/chorus`, published through `.agents/plugins/marketplace.json`) and the Codex App Server transport for daemon wakes. There is no separate TRAE plugin to install.

> **Tip:** The in-app setup wizard at **Settings → Setup Guide → Open setup guide** has a **TRAE CLI** tab with the same commands. Use this doc if you prefer a reference you can read end to end or automate.

## Prerequisites

- A Chorus instance that is running and reachable (for example `http://localhost:8637` or a deployed URL).
- `traecli` installed and on `PATH`. **Minimum tested version: traecli 0.209.1.** Earlier versions are unverified. Check with `traecli --version`.
- TRAE CLI logged in (`traecli login`, or start `traecli` once and finish the login flow). Chorus does not handle TRAE authentication.
- A Chorus **API key** (create one in the Web UI under **Settings → Agents → Create API Key**). Keys start with `cho_`.

## Step 1: Export environment variables

```bash
export CHORUS_URL="http://localhost:8637"
export CHORUS_API_KEY="cho_your_api_key"
```

You don't need to persist these. Step 2 writes them to `$TRAE_HOME/.env`.

## Step 2: Run chorus agents add

```bash
npm install -g @chorus-aidlc/chorus
chorus agents add --agents trae
```

`chorus agents add` reads `CHORUS_URL` / `CHORUS_API_KEY` from your environment. It is idempotent and safe to re-run. All TRAE paths honor `TRAE_HOME` and fall back to `~/.trae`. The command:

1. Checks that `traecli` is installed.
2. Registers the `chorus-plugins` marketplace through TRAE's own plugin CLI (`traecli plugin marketplace add …`). A second run on an already-registered marketplace is a no-op. On re-runs it upgrades the marketplace (`traecli plugin marketplace upgrade chorus-plugins`).
3. Installs the **Codex plugin package** with `traecli plugin install chorus@chorus-plugins --yes`. This copies the plugin into `$TRAE_HOME/plugins/cache/chorus-plugins/chorus/<version>/` and adds `[marketplaces.chorus-plugins]` and `[plugins."chorus@chorus-plugins"] enabled = true` to `$TRAE_HOME/traecli.toml`. The original `traecli.toml` is backed up before it is changed.
4. Seeds your Chorus credentials once into `~/.chorus/daemon.json` (agent type `trae`).
5. Writes `CHORUS_URL`, `CHORUS_API_KEY` and `CHORUS_AGENT_PROFILE` into `$TRAE_HOME/.env` (mode `0600`, other entries preserved). traecli loads this file into its process environment at startup, so plugin hooks, the model's shell-tool `chorus` calls and native MCP all get your identity with **no manual export**.
6. Writes a **keyless** `[mcp_servers.chorus]` block into `$TRAE_HOME/traecli.toml`:

   ```toml
   [mcp_servers.chorus]
   url = "http://localhost:8637/api/mcp"
   bearer_token_env_var = "CHORUS_API_KEY"
   ```

   traecli turns the named env var (from `$TRAE_HOME/.env`) into the `Authorization: Bearer <key>` header. The key is never stored in `traecli.toml`.
7. If a TRAE App Server daemon is already running, an interactive run asks before restarting it (`traecli app-server daemon restart`) so it picks up the new environment. Non-interactive runs, `--yes` and `CHORUS_DAEMON_HEADLESS=1` never restart it. If no daemon is running, the installer does not start one. Unlike Codex, `traecli app-server daemon version` exits non-zero when no daemon is running, so the installer reports the restart as deferred ("daemon state could not be determined").

Non-interactive install (CI, sandboxes):

```bash
chorus agents add --agents trae \
  --url https://chorus.example.com \
  --api-key cho_xxx --yes
```

### `.env` overrides the shell

Like Codex, traecli lets `$TRAE_HOME/.env` **override** a conflicting value exported in your shell or by a parent process. Two consequences:

- To switch identity, re-run `chorus agents add --agents trae` (it asks before repointing an existing profile on a TTY) or edit `$TRAE_HOME/.env`. Exporting a different `CHORUS_API_KEY` has no effect.
- **Daemon:** if several Chorus agents use the TRAE backend, give **each one its own `TRAE_HOME`**. Otherwise the shared `.env` replaces the per-agent credentials the daemon exports and every wake runs as the same agent. See [DAEMON.md](DAEMON.md#per-backend-key-delivery-important).

## Step 3: Trust the Chorus hooks

The plugin ships Chorus lifecycle hooks (SessionStart check-in plus PostToolUse reviewer nudges after `chorus_pm_submit_proposal`, `chorus_submit_for_verify` and `chorus_admin_verify_task`). **traecli runs plugin hooks only after you trust them.** Open `traecli` and accept the hook-trust review for the `chorus@chorus-plugins` hooks. Until you do, the hooks don't run: no automatic check-in and no reviewer reminders. Repeat this whenever a plugin update changes the hook definitions. (`--dangerously-bypass-hook-trust` skips the review for one invocation. It is not recommended.)

TRAE and Codex run the same hook scripts. Each script detects TRAE when the plugin is installed under `$TRAE_HOME/plugins/` and then uses TRAE wording ("TRAE port" banner, sub-agents started with the `Agent` tool instead of Codex's `spawn_agent`). Skill routing points at the installed plugin's skills (`$PLUGIN_ROOT/skills/<name>/SKILL.md`), and the PostToolUse hooks accept TRAE's string-encoded `tool_response`. Set `CHORUS_HOOK_RUNTIME=trae` or `codex` to force the detection.

## Step 4: Optional connection check

This check is manual and uses your model provider. Open `traecli` and type:

```
check in to chorus
```

TRAE calls `chorus_checkin()` through the MCP server and reports your agent identity, permissions and recent activity. The Chorus workflow skills (`$chorus`, `$develop`, `$proposal`, `$yolo` and others) come from the same plugin as Codex. One difference: the skills describe sub-agents with Codex's `spawn_agent` tool, but TRAE's sub-agent tool is **`Agent`** (plus `Skill` and `SendMessage`).

To list MCP servers: `traecli mcp list`.

## Daemon usage

Let Chorus wake TRAE automatically for assigned tasks, mentions and elaboration answers:

```bash
chorus daemon --agent trae
```

Or make it the default with `{ "agent": "trae" }` in `~/.chorus/daemon.json`, or use `"agentType": "trae"` on one entry of `agents[]`. Each wake launches an isolated `traecli app-server --listen stdio://` process. It uses the same protocol, thread resume and permission-mode mapping as the Codex backend (see [DAEMON.md](DAEMON.md#trae-cli-daemon)). Thread IDs are stored separately from Codex in `~/.chorus/trae-sessions.json`. To point at a specific binary, set `CHORUS_TRAE_PATH=/path/to/traecli`.

For a foreground launch with the agent's Chorus connection injected: `chorus agents run --name <agent> --type trae`.

## Troubleshooting

- **`traecli not found`**: install TRAE CLI and make sure `traecli` is on `PATH`, or set `CHORUS_TRAE_PATH`.
- **No Chorus tools / `401 Unauthorized`**: `$TRAE_HOME/.env` is missing the key, the key was revoked, or an old App Server daemon is still running with stale environment. Re-run `chorus agents add --agents trae` and let it restart the daemon (or run `traecli app-server daemon restart` yourself once work is saved).
- **Hooks never fire**: trust the Chorus hooks (Step 3) and check that `chorus@chorus-plugins` is enabled in `$TRAE_HOME/traecli.toml`.
- **Wrong agent identity in daemon wakes**: several TRAE agents share one `TRAE_HOME`. Give each its own (see above).
- **Marketplace upgrade says "is not configured as a Git marketplace"**: this is expected for a local-path source (`CHORUS_MARKETPLACE_SOURCE_TRAE`). The installer treats it as a no-op and reinstalls the plugin.

## Next

- Codex walkthrough (shared plugin package): [CONNECT_CODEX.md](CONNECT_CODEX.md)
- Daemon reference: [DAEMON.md](DAEMON.md)
- Other MCP-capable agents: [CONNECT_OTHER_AGENTS.md](CONNECT_OTHER_AGENTS.md)
