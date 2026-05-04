# Connect OpenCode to Chorus

This guide walks through connecting the [OpenCode CLI](https://opencode.ai) to a running Chorus instance via the community-maintained [`opencode-chorus`](https://www.npmjs.com/package/opencode-chorus) plugin. The plugin ships Chorus MCP tools, reviewer hooks, and the Chorus skill library into OpenCode through OpenCode's native plugin mechanism.

> **Tip:** The in-app setup wizard at **Settings → Setup Guide → Open setup guide** walks you through the same steps interactively, including API-key creation. Use this doc if you prefer a reference you can read end-to-end or automate.

## Prerequisites

- Chorus instance running and reachable (e.g. `http://localhost:8637` or a deployed URL)
- `opencode` CLI installed (see [opencode.ai/docs](https://opencode.ai/docs/))
- A Chorus **API Key** (create one in the Web UI under **Settings → Agents → Create API Key**). Keys start with `cho_`.

## Step 1: Export environment variables

```bash
export CHORUS_URL="http://localhost:8637"
export CHORUS_API_KEY="cho_your_api_key"
```

> Add these to `~/.bashrc` or `~/.zshrc` so OpenCode can read them on startup. The `opencode-chorus` plugin reads `process.env.CHORUS_URL` (or `CHORUS_BASE_URL`) and `process.env.CHORUS_API_KEY` during plugin initialization.
>
> **Note on URL format:** `CHORUS_URL` should be the **root URL** of your Chorus instance (e.g. `https://chorus.example.com`), without the `/api/mcp` suffix. The plugin appends the MCP path internally.

## Step 2: Enable the Chorus plugin

Run the one-shot installer:

```bash
curl -fsSL "$CHORUS_URL/install-opencode.sh" | bash
```

The script is idempotent and safe to re-run. It will:

1. Verify `opencode` is installed (warns if not, but still writes the config).
2. Idempotently add `"opencode-chorus"` to the `plugin` array in `~/.config/opencode/opencode.json`. Existing plugin entries are preserved.
3. Back up the original config to `opencode.json.chorus-bak` (only on first modification) and set file mode to `600`.

**What the script does NOT do:**

- It does **not** write to `~/.bashrc` / `~/.zshrc`. You are responsible for exporting `CHORUS_URL` and `CHORUS_API_KEY` yourself before launching `opencode`.
- It does **not** install the plugin package. OpenCode fetches `opencode-chorus` from npm via Bun the first time you launch it after editing `opencode.json` (cache lives at `~/.cache/opencode/packages/opencode-chorus@latest/`).

### Manual alternative

If you prefer to edit the config by hand, add this to `~/.config/opencode/opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["opencode-chorus"]
}
```

Merge `"opencode-chorus"` into any existing `plugin` array instead of replacing it.

## Step 3: Verify the connection

Launch OpenCode:

```bash
opencode
```

On first launch Bun will fetch `opencode-chorus` from npm (this adds a few seconds the first time). Then ask the agent:

```
check in to chorus
```

The plugin will call `chorus_checkin()` via its MCP client and the agent will report back with your identity, permissions, and recent activity. The Chorus workflow skills (`chorus`, `chorus-develop`, `chorus-proposal`, `chorus-review`, `chorus-yolo`, etc.) are automatically registered under OpenCode.

## Troubleshooting

- **Plugin not loaded.** Clear the package cache and restart OpenCode:
  ```bash
  rm -rf ~/.cache/opencode/packages/opencode-chorus@latest
  ```
  OpenCode will re-fetch the latest version from npm on next launch.

- **Environment variables not taking effect.** Confirm you launched OpenCode from a shell where `CHORUS_URL` and `CHORUS_API_KEY` are exported. Run `env | grep CHORUS_` in the shell to verify. Re-source your shell rc file if needed (`source ~/.zshrc`).

- **`check in` not responding.** Double-check `CHORUS_API_KEY` for typos or trailing whitespace. If the plugin still fails to load on startup, try upgrading OpenCode (`opencode upgrade`). The `opencode-chorus` plugin depends on a recent `@opencode-ai/plugin` SDK version.

- **`401 Unauthorized`.** API key wrong or revoked. Recreate under Settings → Agents, then update `CHORUS_API_KEY` in your shell rc and restart OpenCode.

- **Need to roll back?** The installer saved your original config to `~/.config/opencode/opencode.json.chorus-bak`. Restore with:
  ```bash
  mv ~/.config/opencode/opencode.json.chorus-bak ~/.config/opencode/opencode.json
  ```

## Advanced: use a config file instead of env

If you prefer not to touch your shell rc, `opencode-chorus` also reads from `~/.config/opencode/chorus.json`:

```json
{
  "chorusUrl": "https://chorus.example.com",
  "apiKey": "cho_your_api_key"
}
```

Environment variables take precedence over file values when both are set. The file approach is useful for shared dev containers or when you want to keep secrets out of `~/.zshrc`. Make sure to `chmod 600 ~/.config/opencode/chorus.json` since it contains your API key.

## Next

- Workflow overview: tell the OpenCode agent `load the chorus skill`
- Project-level install: write the same `plugin` array into `./opencode.json` at the project root. OpenCode loads per-project configs on top of the global one.
- To connect Claude Code instead, see [CONNECT_CLAUDE_CODE.md](CONNECT_CLAUDE_CODE.md)
- To connect Codex, see [CONNECT_CODEX.md](CONNECT_CODEX.md)
- For any other MCP-capable agent (Cursor, Continue, custom, etc.), see [CONNECT_OTHER_AGENTS.md](CONNECT_OTHER_AGENTS.md)
