# Remove the hardcoded 0.17.0 pin from Chorus CLI install prompts

## Why

When a user creates an agent API key, the in-app Install Guide tells them to run
`npm install -g @chorus-aidlc/chorus@0.17.0` before `chorus agents add`. Chorus has since shipped
0.18 → 0.20, so every new user following the guide installs a stale CLI. The same pinned command is
copied into the connect docs, `MCP_TOOLS.md`, and the retired per-agent install stubs. The pin was a
one-time bootstrap choice from the `retire-bootstrap-migrate-mcp-cli` /
`unify-agent-cli-chorus-agents` changes and was never bumped.

## What Changes

- **Install Guide UI** (`src/components/install-guide/AgentInstallGuide.tsx`): every agent tab
  (Claude Code, Codex, Kiro, dsh, OpenCode) shows `npm install -g @chorus-aidlc/chorus` with no
  version suffix; its component test asserts the unpinned command.
- **i18n tips** (`messages/{en,zh,ja,ko}.json` — Kiro `step2Tip`, dsh `step3Tip`, OpenCode
  `step2Tip`): "(pinned to version 0.17.0)" becomes "installs the latest Chorus CLI globally"
  (localized).
- **Retired install stubs** (`public/install-{codex,kiro,opencode}.sh`,
  `public/dsh-credentials.sh`): `INSTALL_CMD` and header comments drop the pin;
  `public/test-install-codex.sh` follows.
- **Docs & comments**: `docs/CONNECT_*.md` (+ `.zh`), the install line in `docs/MCP_TOOLS.md`, and the
  comment in `cli/init/steps/credential-seed.mjs`.
- **Kept**: the plugin MCP wrappers' `chorus >= 0.17.0` minimum-version check (a compatibility floor
  for the `chorus mcp` subcommand, not an install pin) is unchanged.

Decisions come from elaboration round 1 on the source Idea: scope = UI + docs + scripts (README
excluded); keep the floor check; tip wording = "latest".

## Capabilities

### Modified Capabilities

- `chorus-cli-bootstrap-migration`: the deprecation-stub and Install Guide requirements now name the
  unpinned `npm install -g @chorus-aidlc/chorus` command.

## Impact

- Text-only change across UI, i18n, docs and bash stubs; no API, schema, or runtime behaviour change.
- Out of scope: README `@0.20.0` pins (bumped by the release process), historical blog posts,
  `openspec/changes/archive/**`, `scripts/coordinated-npm-release` test fixtures, and historical
  "Since 0.17.0 …" notes in `MCP_TOOLS.md`.
