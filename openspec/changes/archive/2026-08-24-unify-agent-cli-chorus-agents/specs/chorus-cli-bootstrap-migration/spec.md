# chorus-cli-bootstrap-migration Specification Delta

## ADDED Requirements

### Requirement: Product-facing surfaces name `chorus agents add`

Every product-facing surface that instructs a user to configure an agent SHALL name the command `chorus agents add` (never the retired `chorus init`). This covers the in-app Install Guide and its `en`/`zh`/`ja`/`ko` translations, the `CONNECT_*` docs (and `.zh`), the READMEs, `MCP_TOOLS.md`, the deprecation stubs (`install-*.sh` / `dsh-credentials.sh`), the Kiro `.kiro` bundle manifest, the per-surface `chorus/SKILL.md`, and the plugins' SessionStart banners. A grep for a user-facing `chorus init` instruction MUST return nothing outside `openspec/changes/archive/**` (immutable history) and historical blog posts.

#### Scenario: Install guide names the new command
- **WHEN** a user reads any agent tab of the in-app Install Guide (any locale)
- **THEN** the configuration step reads `chorus agents add` (with `npm install -g @chorus-aidlc/chorus@0.17.0` first), not `chorus init`

#### Scenario: Deprecation stubs point at the new command
- **WHEN** a retired `install-*.sh` / `dsh-credentials.sh` stub runs
- **THEN** it prints the two-step setup naming `chorus agents add` and exits non-zero

### Requirement: Standalone `chorus-cli` skill on every surface

The plugin skill set SHALL include a standalone `chorus-cli` skill on all six surfaces (Claude Code, Codex, Kiro, Pi, dsh, OpenClaw) that concisely teaches an agent to install the CLI, configure agents (`chorus agents add` / `chorus agents remove` / `chorus agents`), use the connection environment variables (`CHORUS_URL` / `CHORUS_API_KEY` / `CHORUS_AGENT_PROFILE`), and drive MCP operations (`chorus mcp call/whoami/list`, `--arg-file`, `--agent`). The skill MUST be registered/discoverable on each surface (auto-discovery on Claude Code + Codex; explicit enumeration updated on the npm-package surfaces), and the `openspec-aware` skill MUST reference it for CLI install/config/identity basics while retaining its own document-mirror mechanics.

#### Scenario: openspec-aware defers CLI basics to chorus-cli
- **WHEN** an agent reads `openspec-aware` §2 on any surface
- **THEN** it finds a pointer to the `chorus-cli` skill for install/configure/identity basics, and `chorus-cli` documents `chorus agents add|remove` and the profile env var

#### Scenario: Skill is discoverable per surface
- **WHEN** a plugin surface lists its skills
- **THEN** `chorus-cli` is present (auto-discovered or enumerated per that surface's convention)
