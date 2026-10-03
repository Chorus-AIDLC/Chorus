## MODIFIED Requirements

### Requirement: Per-agent install scripts are deprecation stubs pointing to `chorus agents add`

The per-agent install scripts SHALL be reduced to a Bash 3.2 deprecation stub that names
`npm install -g @chorus-aidlc/chorus` (unpinned, so npm installs the latest release) followed by
`chorus agents add` as the replacement and carries no inline install logic. The affected scripts are
`public/install-codex.sh`, `public/install-opencode.sh`, `public/install-kiro.sh`, and
`public/dsh-credentials.sh`. The stub SHALL print the `npm install -g @chorus-aidlc/chorus` and
`chorus agents add` commands and exit non-zero; it SHALL NOT `exec` `npx` or `chorus agents add`, because
the user is expected to install the CLI globally first. The printed install command MUST NOT carry an
`@<version>` suffix. The `install-kiro.sh` ↔ `cli/init/file-template.mjs` manifest-parity test SHALL be
updated so the manifest is owned solely by the JavaScript installer.

#### Scenario: Interactive run prints the install + init commands

- **WHEN** a deprecated installer is run on an interactive terminal
- **THEN** it SHALL print the deprecation notice, the `npm install -g @chorus-aidlc/chorus`
  command (no version suffix), and `chorus agents add`, then exit non-zero (it SHALL NOT `exec` anything)

#### Scenario: Piped run fails loudly with the replacement commands

- **WHEN** a deprecated installer is executed non-interactively (e.g. `curl … | bash`, no TTY)
- **THEN** it SHALL print the `npm install -g @chorus-aidlc/chorus` + `chorus agents add` commands
  and exit with a non-zero status rather than silently doing nothing

### Requirement: Product-facing surfaces name `chorus agents add`

Every product-facing surface that instructs a user to configure an agent SHALL name the command `chorus agents add` (never the retired `chorus init`). This covers the in-app Install Guide and its `en`/`zh`/`ja`/`ko` translations, the `CONNECT_*` docs (and `.zh`), the READMEs, `MCP_TOOLS.md`, the deprecation stubs (`install-*.sh` / `dsh-credentials.sh`), the Kiro `.kiro` bundle manifest, the per-surface `chorus/SKILL.md`, and the plugins' SessionStart banners. A grep for a user-facing `chorus init` instruction MUST return nothing outside `openspec/changes/archive/**` (immutable history) and historical blog posts. The in-app Install Guide, its translations, the `CONNECT_*` docs, `MCP_TOOLS.md`, and the deprecation stubs SHALL show the CLI install step as the unpinned `npm install -g @chorus-aidlc/chorus`; a grep for `@chorus-aidlc/chorus@0.17` across `src/`, `messages/`, `public/`, `docs/`, and `cli/` MUST return nothing.

#### Scenario: Install guide names the new command
- **WHEN** a user reads any agent tab of the in-app Install Guide (any locale)
- **THEN** the configuration step reads `chorus agents add` (with the unpinned `npm install -g @chorus-aidlc/chorus` first), not `chorus init`

#### Scenario: Install tip describes the latest CLI
- **WHEN** a user reads the Kiro, dsh, or OpenCode install tip in any locale
- **THEN** the tip SHALL say the first command installs the latest Chorus CLI globally, and SHALL NOT mention a pinned version

#### Scenario: Deprecation stubs point at the new command
- **WHEN** a retired `install-*.sh` / `dsh-credentials.sh` stub runs
- **THEN** it prints the two-step setup naming `chorus agents add` and exits non-zero
