## ADDED Requirements

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

### Requirement: Hooks work under TRAE, with TRAE-specific copies when needed

The Chorus plugin hooks SHALL run under traecli's hook runner. Shared Codex hook scripts SHALL stay unchanged. Any script that behaves incorrectly under TRAE — for example SessionStart routing text that points at `~/.codex/skills/...` — SHALL get a TRAE-specific copy. That copy SHALL be selected without changing Codex behavior, and the selection mechanism SHALL be documented in the design. The SessionStart hook under TRAE SHALL complete check-in and inject Chorus context when `CHORUS_URL` and `CHORUS_API_KEY` are present.

#### Scenario: SessionStart under TRAE

- **WHEN** a TRAE session starts with the Chorus plugin installed and complete Chorus credentials in the environment
- **THEN** the SessionStart hook checks in and injects Chorus context whose skill-path routing is valid for TRAE

#### Scenario: Codex unaffected by TRAE copies

- **WHEN** a Codex session starts with the same plugin package
- **THEN** it runs the original Codex hook scripts and its output is unchanged

### Requirement: TRAE CLI is advertised as a supported agent

TRAE CLI SHALL be listed with the other supported agents in the CLI help/menus, README files, docs, landing page and in-app agent install guide. Every new user-facing UI string SHALL exist in both `en` and `zh`, and the UI SHALL render correctly in light and dark themes.

#### Scenario: Install guide lists TRAE

- **WHEN** a user opens the agent install guide
- **THEN** a TRAE CLI entry shows the `chorus agents add` / `chorus daemon --agent trae` setup, localized in the active locale
