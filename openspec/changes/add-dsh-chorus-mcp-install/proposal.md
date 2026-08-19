## Why

DeepSeek Harness can consume Chorus over MCP, but Chorus does not yet provide a supported way to install that connection. Daemon-woken and interactive dsh sessions therefore lack the `mcp__chorus__*` tools needed to participate in Chorus workflows.

## What Changes

- Add a public `install-dsh.sh` installer that verifies the dsh CLI and configures Chorus non-interactively from `CHORUS_URL` and `CHORUS_API_KEY`, with terminal prompting as a convenience for direct use.
- Install one home-wide `@deepseek-ai/dsh-mcp-client` row in `$DSH_HOME/cordis.patch.yml`, exposing Chorus tools in every dsh profile.
- Persist Chorus connection values in owner-only `$DSH_HOME/.env`; keep the API key out of the patch, process arguments, and installer output.
- Make installation and credential rotation idempotent while preserving unrelated dsh patch and environment configuration.
- Keep a failed initial Chorus connection non-blocking but visibly report the `mcp-client(chorus)` failure and pending retry.
- Add Bash 3.2 compatibility, isolated installer, config-composition, and real MCP tool smoke checks.

## Capabilities

### New Capabilities

- `dsh-chorus-mcp-install`: Installs and verifies a home-wide, reconnecting Chorus MCP connection for DeepSeek Harness.

### Modified Capabilities

None.

## Impact

- Adds public installer and installer-test assets under `public/`.
- Mutates user-owned `$DSH_HOME/.env` and `$DSH_HOME/cordis.patch.yml` during installation.
- Relies on the `@deepseek-ai/dsh-mcp-client` package shipped with supported dsh releases and its Streamable HTTP transport.
- Does not change Chorus APIs, database schema, or the DeepSeek Harness source repository.
