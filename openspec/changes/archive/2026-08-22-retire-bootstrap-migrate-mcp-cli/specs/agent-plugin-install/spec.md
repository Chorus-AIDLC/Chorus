# agent-plugin-install Specification (delta)

## MODIFIED Requirements

### Requirement: kiro plugin installed via a native cross-platform file-template

Kiro has no plugin CLI; for kiro the plugin-install step SHALL install the Chorus plugin by dropping the `.kiro/` file template natively in pure JavaScript (no bash, cross-platform), fetching the template assets from the connected Chorus instance at `$CHORUS_URL/kiro-plugin/…`: copy the Chorus skills, the main `chorus` agent and reviewer subagents, the steering document, and the hook scripts, substitute the absolute hook-binary path for the `__CHORUS_BIN__` placeholder, and merge the `chorus` MCP server into `settings/mcp.json` while preserving existing servers and backing up the original first. Each asset fetch MUST be verified; if the instance cannot serve an asset the step MUST report `failed` naming the unreachable URL rather than leaving a partial drop. The artifact manifest (skills, reviewer agents, hook scripts) MUST be owned by this JavaScript installer (`cli/init/file-template.mjs`) as the single source of truth; the legacy `public/install-kiro.sh` is now a deprecation stub that installs nothing (see `chorus-cli-bootstrap-migration`), so there is no second installer to keep the manifest in sync with. The Chorus API key MUST remain an environment reference in the merged server, never a literal.

#### Scenario: kiro template installed
- **WHEN** kiro is selected and the Chorus `.kiro/` template is not yet installed
- **THEN** the step copies the skills/agents/steering/hooks, substitutes `__CHORUS_BIN__` with the resolved absolute path, merges the `chorus` server into `settings/mcp.json` (other servers preserved, original backed up), and reports `installed`

#### Scenario: __CHORUS_BIN__ placeholder must not survive
- **WHEN** the main agent's hook commands are written
- **THEN** the installer fails loudly if any `__CHORUS_BIN__` placeholder remains unsubstituted

#### Scenario: kiro template already present is skipped
- **WHEN** the Chorus skills, `agents/chorus.json`, and the `chorus` MCP server are all already present
- **THEN** the step reports `skipped` (or repairs only the missing delta) and preserves unrelated user configuration
