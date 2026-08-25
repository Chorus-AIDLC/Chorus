# kiro-plugin-installer Specification

## Purpose
TBD - created by archiving change add-kiro-cli-plugin. Update Purpose after archive.
## Requirements
### Requirement: Kiro registered as the fourth plugin surface in docs
The change SHALL register Kiro as a plugin surface: a `docs/CONNECT_KIRO.md` connect guide paralleling `docs/CONNECT_CODEX.md`, and updates to surface-count statements in `docs/MCP_TOOLS.md` and the `plugin-maintenance` skill (surface list + bump recipe). The connect guide SHALL document that Kiro is configured via `chorus agents add` (the native cross-platform file-template installer specified under `agent-plugin-install`), and that live in-Kiro activation (e.g. `/chorus-idea`, `kiro --agent chorus`) is the user's manual verification step. The legacy `public/install-kiro.sh` is a deprecation stub that redirects to `chorus agents add` (see `chorus-cli-bootstrap-migration`) and SHALL NOT be presented as the install command.

#### Scenario: Connect guide names the `chorus agents add` install path
- **WHEN** `docs/CONNECT_KIRO.md` is read
- **THEN** it shows `chorus agents add` (after `npm install -g @chorus-aidlc/chorus`) as the way to install the Chorus plugin for Kiro, including default-global vs workspace behavior, and how to activate `/chorus-*` skills and the `chorus` main agent in Kiro — and does NOT present `install-kiro.sh | bash` as the install command

#### Scenario: Surface count updated where stated
- **WHEN** a doc or skill that enumerates the plugin surfaces is read after this change
- **THEN** it lists Kiro alongside Claude Code, Codex, and OpenClaw

