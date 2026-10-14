# trae-plugin-install Specification

## Purpose
TBD - created by archiving change add-trae-cli-backend. Update Purpose after archive.

## Requirements

### Requirement: TRAE adapter installs the Codex plugin package through traecli's plugin CLI

`chorus agents add` SHALL include a TRAE CLI adapter detected by the `traecli` binary or the `~/.trae` (or `TRAE_HOME`) directory. The adapter SHALL install the Chorus plugin surface by reusing the existing Codex marketplace and plugin package — `traecli plugin marketplace add <source>` (default `Chorus-AIDLC/Chorus`, overridable through `CHORUS_MARKETPLACE_SOURCE_TRAE`) followed by `traecli plugin install chorus@chorus-plugins --yes` — and SHALL NOT add a separate TRAE plugin directory or manifest. Install state SHALL be read from `traecli.toml` (`[marketplaces.chorus-plugins]`, `[plugins."chorus@chorus-plugins"]`). The adapter SHALL back up `traecli.toml` before any CLI mutation and SHALL be idempotent. When the plugin is already installed, an update/refresh request SHALL run `traecli plugin marketplace upgrade chorus-plugins` and reinstall the plugin.

#### Scenario: Fresh TRAE install

- **WHEN** `traecli` is detected and the Chorus marketplace is not registered in `traecli.toml`
- **THEN** the adapter registers the marketplace, installs `chorus@chorus-plugins`, and reports `installed`

#### Scenario: Re-run is idempotent

- **WHEN** `traecli.toml` already lists the marketplace and the plugin
- **THEN** the adapter runs no plugin CLI mutation and reports `skipped` (or `repaired` on an explicit refresh)

#### Scenario: CLI failure is reported, not hidden

- **WHEN** a `traecli plugin` command exits non-zero
- **THEN** the adapter reports `failed` with the command's error text and does not claim success

### Requirement: TRAE adapter writes a keyless Chorus MCP block

After the plugin install, the adapter SHALL write or normalize a `[mcp_servers.chorus]` block in `traecli.toml` with the Chorus MCP URL and `bearer_token_env_var = "CHORUS_API_KEY"`, using the same writer as the Codex adapter with a target-file parameter. It SHALL NOT write the API key into `traecli.toml`. The env-var form SHALL be verified to authenticate on the supported traecli version. If it does not, the adapter SHALL use TRAE's supported keyless mechanism, and this spec and the design SHALL be updated before implementation finishes. A missing Chorus URL SHALL skip the MCP block with a visible note while the plugin surface stays installed.

#### Scenario: MCP block without a secret

- **WHEN** the adapter completes with a resolved Chorus URL
- **THEN** `traecli.toml` contains `[mcp_servers.chorus]` with the URL and an env-var bearer reference, and contains no `cho_` key

### Requirement: Hooks work under TRAE through the shared Codex hook scripts

The Chorus plugin hooks SHALL run under traecli's hook runner using the **same** `hooks/*.sh` scripts that Codex runs; the plugin SHALL NOT ship TRAE-specific copies or a dispatcher. `hooks.json` commands SHALL stay byte-identical to the pre-change Codex commands (`${PLUGIN_ROOT}/hooks/<name>.sh`), so existing Codex users need no hook re-trust. Where wording must differ (session banner; sub-agent tool `spawn_agent` on Codex vs `Agent` on TRAE), the shared script SHALL detect the runtime with a shared helper whose marker is documented in the design, and SHALL default to Codex wording. SessionStart skill routing SHALL point at the installed plugin's own skills (`${PLUGIN_ROOT}/skills/<name>/SKILL.md`), which is valid for both installs. The PostToolUse hooks SHALL extract the entity UUID whether `tool_response` is an object or a JSON-encoded string, and SHALL keep the `tool_input` fallback. The hook scripts SHALL emit no bash errors on stderr, SHALL request MCP list pages within the server's `pageSize` limit (100), and every Codex `spawn_agent` skill item they suggest SHALL carry `name`. The SessionStart hook under TRAE SHALL complete check-in and inject Chorus context when `CHORUS_URL` and `CHORUS_API_KEY` are present.

#### Scenario: SessionStart under TRAE

- **WHEN** a TRAE session starts with the Chorus plugin installed and complete Chorus credentials in the environment
- **THEN** the SessionStart hook checks in and injects Chorus context with a "TRAE port" banner, `Agent`-tool sub-agent wording, and skill-path routing that is valid for TRAE

#### Scenario: Codex keeps its hook commands and wording

- **WHEN** a Codex session starts with the same plugin package
- **THEN** the hook commands are unchanged (no re-trust), and the shared scripts emit Codex wording ("Codex port", `spawn_agent`) with skill routing valid for the Codex install

#### Scenario: String-encoded tool_response

- **WHEN** a PostToolUse event for `chorus_submit_for_verify`, `chorus_pm_submit_proposal` or `chorus_admin_verify_task` carries `tool_response` as a JSON-encoded string
- **THEN** the hook still extracts the entity UUID (from the decoded response, `tool_input` or `post_tool_use.tool_input`) and emits its reminder

### Requirement: TRAE CLI is advertised as a supported agent

TRAE CLI SHALL be listed with the other supported agents in the CLI help/menus, README files, docs, landing page and in-app agent install guide. Every new user-facing UI string SHALL exist in both `en` and `zh`, and the UI SHALL render correctly in light and dark themes.

#### Scenario: Install guide lists TRAE

- **WHEN** a user opens the agent install guide
- **THEN** a TRAE CLI entry shows the `chorus agents add` / `chorus daemon --agent trae` setup, localized in the active locale
