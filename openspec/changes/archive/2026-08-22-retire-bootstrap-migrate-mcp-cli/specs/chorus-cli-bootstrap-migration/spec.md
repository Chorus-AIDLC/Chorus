# chorus-cli-bootstrap-migration Specification

## ADDED Requirements

### Requirement: Plugin bash MCP wrappers prefer `chorus mcp` and fall back to the bundled bash path

Each plugin surface's bash MCP wrapper SHALL, for its MCP-over-HTTP tool-call path, prefer the
`chorus mcp call` CLI when the `chorus` binary is on `PATH`, and SHALL otherwise fall back to its
existing `curl`-based logic. The wrappers covered are `chorus-api.sh`'s `mcp-tool` subcommand (Claude
Code and Kiro), `chorus-mcp-call.sh` (Codex and Pi), and the dsh MCP-call wrapper. The wrapper SHALL
remain the single credential resolver and SHALL pass its resolved connection settings to the CLI
explicitly via `--url` and `--api-key`. The wrapper's local, non-MCP subcommands (`state-*`,
`hook-output`, `session-read`/`session-list`) SHALL be left unchanged; the wrapper file SHALL NOT be
deleted. Wrappers SHALL remain Bash 3.2 compatible.

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

### Requirement: Per-agent install scripts are deprecation stubs pointing to `chorus init`

The per-agent install scripts SHALL be reduced to a Bash 3.2 deprecation stub that names
`npx @chorus-aidlc/chorus init` as the replacement and carries no inline install logic. The affected
scripts are `public/install-codex.sh`, `public/install-opencode.sh`, `public/install-kiro.sh`, and
`public/dsh-credentials.sh`. When a TTY is attached and `chorus`/`npx` is available the stub SHALL
`exec` `chorus init`; otherwise (for example a non-interactive `curl | bash`) it SHALL print the
command to run and exit non-zero. The `install-kiro.sh` ↔ `cli/init/file-template.mjs` manifest-parity
test SHALL be updated so the manifest is owned solely by the JavaScript installer.

#### Scenario: Interactive run redirects into `chorus init`

- **WHEN** a deprecated installer is run on an interactive terminal with `npx` (or `chorus`) available
- **THEN** it SHALL print the deprecation notice and `exec` `chorus init`

#### Scenario: Piped run fails loudly with the replacement command

- **WHEN** a deprecated installer is executed non-interactively (e.g. `curl … | bash`, no TTY)
- **THEN** it SHALL print the `npx @chorus-aidlc/chorus init` command and exit with a non-zero status
  rather than silently doing nothing

### Requirement: Root `install.sh` remains the CDK deployer and is out of scope

The repository-root `install.sh` (the CDK/AWS server deployer) SHALL remain unchanged by this
migration; it is not a per-agent plugin installer and `chorus init` does not replace it.

#### Scenario: CDK deployer untouched

- **WHEN** this change is applied
- **THEN** `install.sh` at the repository root SHALL be byte-identical to before the change

### Requirement: Product-facing surfaces direct users to `chorus init`

Product-facing surfaces SHALL present `chorus init` (or `npx @chorus-aidlc/chorus init`) as the way to
configure an agent, instead of a `curl … | bash` installer command. The affected surfaces are the
in-app Install Guide component, the landing page integration section, the `docs/CONNECT_*.md` connect
guides (and their localized variants), the READMEs, and the `docs/design.pen` mockups. Any changed
user-facing string SHALL be updated in all four supported locales (en/zh/ja/ko) and SHALL render
correctly in both light and dark themes. Historical release blog posts are exempt (left as archive).

#### Scenario: Install Guide shows `chorus init`

- **WHEN** a user views the in-app Install Guide for any supported agent tab
- **THEN** the setup command SHALL be `chorus init` (or `npx @chorus-aidlc/chorus init`), not a
  `curl | bash` installer, with the live-or-placeholder API key still shown for the user to supply

#### Scenario: Locale parity for changed strings

- **WHEN** a user-facing install string is changed by this migration
- **THEN** the corresponding key SHALL resolve in English, Chinese, Japanese, and Korean without
  missing-key fallback
