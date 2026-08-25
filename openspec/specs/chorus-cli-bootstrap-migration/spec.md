# chorus-cli-bootstrap-migration Specification

## Purpose
TBD - created by archiving change retire-bootstrap-migrate-mcp-cli. Update Purpose after archive.
## Requirements
### Requirement: Plugin bash MCP wrappers prefer `chorus mcp` and fall back to the bundled bash path

Each plugin surface's bash MCP wrapper SHALL, for its MCP-over-HTTP tool-call path, prefer the
`chorus mcp call` CLI when the `chorus` binary is on `PATH`, and SHALL otherwise fall back to its
existing `curl`-based logic. The wrappers covered are `chorus-api.sh`'s `mcp-tool` subcommand (Claude
Code and Kiro), `chorus-mcp-call.sh` (Codex and Pi), and the dsh MCP-call wrapper. The wrapper SHALL
remain the single credential resolver and SHALL pass its resolved connection settings to the CLI
explicitly via `--url` and `--api-key`. The wrapper's local, non-MCP subcommands (`state-*`,
`hook-output`, `session-read`/`session-list`) SHALL be left unchanged; the wrapper file SHALL NOT be
deleted. Wrappers SHALL remain Bash 3.2 compatible. Because the `chorus mcp` subcommand only exists in
chorus `>= 0.17.0`, each wrapper SHALL verify the CLI version (parsed from the bare `X.Y.Z` printed by
`chorus --version`, comparing as `major > 0` OR `minor >= 17`) before delegating: a supported version
delegates as above, while a `chorus` that is present but older than `0.17.0`, or whose version cannot
be parsed, SHALL NOT delegate and SHALL NOT fall back to `curl` — the wrapper SHALL instead print an
error naming the detected version, the required `chorus >= 0.17.0`, and the upgrade command
`npm install -g @chorus-aidlc/chorus`, and exit non-zero.

#### Scenario: CLI present — delegate to `chorus mcp call`

- **WHEN** a hook invokes the wrapper's MCP tool-call path and `chorus` resolves on `PATH`
- **THEN** the wrapper SHALL run `chorus mcp call <tool> <json> --url <resolved-url> --api-key <resolved-key>`
  and propagate its standard output verbatim and its exit code

#### Scenario: CLI absent — fall back to the bundled curl path

- **WHEN** the wrapper's MCP tool-call path runs on a host where `chorus` is not on `PATH`
- **THEN** the wrapper SHALL execute its existing `curl`-based MCP request unchanged, so a plugin-only
  user without the CLI keeps working

#### Scenario: Fallback triggers on absence, not on call failure

- **WHEN** `chorus` is present but the delegated `chorus mcp call` returns a non-zero exit or an error body
- **THEN** the wrapper SHALL propagate that failure rather than re-attempting the request over `curl`

#### Scenario: Escape hatch forces the bash path

- **WHEN** `CHORUS_MCP_NO_CLI` is set in the environment
- **THEN** the wrapper SHALL use its `curl`-based path even if `chorus` is on `PATH`

#### Scenario: CLI present but older than 0.17.0 — actionable upgrade error

- **WHEN** `chorus` is on `PATH` but `chorus --version` reports a version below `0.17.0`, or a version
  string that cannot be parsed into `MAJOR.MINOR`
- **THEN** the wrapper SHALL NOT run `chorus mcp call` and SHALL NOT fall back to its `curl` path, and
  SHALL instead print an error naming the detected version, the required `chorus >= 0.17.0`, and the
  upgrade command `npm install -g @chorus-aidlc/chorus`, then exit with a non-zero status

### Requirement: Skill document-mirror flow prefers `chorus mcp call` with a documented bash fallback

The `openspec-aware` skill's document-mirror instructions, across all six plugin surfaces, SHALL
present `chorus mcp call <tool> <json> --arg-file content=<file>` as the primary way to mirror
OpenSpec document drafts/documents, using `--arg-file` for byte-exact file-content filling in place
of the `json_encode_file` helper. The skill SHALL retain the `chorus-api.sh mcp-tool` +
`json_encode_file` block as an explicitly-marked fallback used when the `chorus` CLI is not on `PATH`.
The `chorus_check_response` halt-on-error discipline SHALL apply to both paths.

#### Scenario: Primary path fills content byte-exactly from a file

- **WHEN** the skill mirrors a document whose body is a local markdown file and `chorus` is available
- **THEN** it SHALL call `chorus mcp call <tool> '<json-without-content>' --arg-file content=<path>`,
  and the mirrored `content` SHALL be byte-identical to the file

#### Scenario: Fallback documented for CLI-absent hosts

- **WHEN** a reader follows the skill on a host without the `chorus` CLI
- **THEN** the skill SHALL provide the `chorus-api.sh mcp-tool` + `json_encode_file` fallback that
  produces the same mirror result

### Requirement: Per-agent install scripts are deprecation stubs pointing to `chorus agents add`

The per-agent install scripts SHALL be reduced to a Bash 3.2 deprecation stub that names
`npm install -g @chorus-aidlc/chorus@<version>` followed by `chorus agents add` as the replacement and
carries no inline install logic. The affected scripts are `public/install-codex.sh`,
`public/install-opencode.sh`, `public/install-kiro.sh`, and `public/dsh-credentials.sh`. The stub
SHALL print the `npm install -g @chorus-aidlc/chorus@<version>` and `chorus agents add` commands and exit
non-zero; it SHALL NOT `exec` `npx` or `chorus agents add`, because the user is expected to install the CLI
globally first. The `install-kiro.sh` ↔ `cli/init/file-template.mjs` manifest-parity test SHALL be
updated so the manifest is owned solely by the JavaScript installer.

#### Scenario: Interactive run prints the install + init commands

- **WHEN** a deprecated installer is run on an interactive terminal
- **THEN** it SHALL print the deprecation notice, the `npm install -g @chorus-aidlc/chorus@<version>`
  command, and `chorus agents add`, then exit non-zero (it SHALL NOT `exec` anything)

#### Scenario: Piped run fails loudly with the replacement commands

- **WHEN** a deprecated installer is executed non-interactively (e.g. `curl … | bash`, no TTY)
- **THEN** it SHALL print the `npm install -g @chorus-aidlc/chorus@<version>` + `chorus agents add` commands
  and exit with a non-zero status rather than silently doing nothing

### Requirement: Root `install.sh` remains the CDK deployer and is out of scope

The repository-root `install.sh` (the CDK/AWS server deployer) SHALL remain unchanged by this
migration; it is not a per-agent plugin installer and `chorus agents add` does not replace it.

#### Scenario: CDK deployer untouched

- **WHEN** this change is applied
- **THEN** `install.sh` at the repository root SHALL be byte-identical to before the change

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

