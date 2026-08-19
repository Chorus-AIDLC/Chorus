# daemon-add-agent-type Specification

## Purpose
TBD - created by archiving change daemon-add-agent-type-prompt. Update Purpose after archive.
## Requirements
### Requirement: Add / first-login flows offer an agent-backend selection

The daemon credential commands that add or first-configure an agent SHALL let the operator choose the agent backend (agent type) for that agent, in addition to the Chorus URL and API key. This covers `chorus login` (single-agent), `chorus login --add` / `chorus daemon add` (append), and the `chorus install` "Add another agent?" loop. The selection MUST be offered both interactively (a numbered menu on a TTY) and non-interactively (the existing `--agent` flag).

#### Scenario: Interactive add prompts for a backend

- **WHEN** an operator runs `chorus daemon add` (or `chorus login --add`) on a
  TTY without passing `--agent`, and supplies a valid URL and API key
- **THEN** a numbered agent-backend menu is displayed after the URL/key prompts
- **AND** the chosen backend is persisted as the new `agents[]` entry's
  `agentType`

#### Scenario: `--agent` flag is honored non-interactively

- **WHEN** an operator runs an add / login command with `--agent codex`
- **THEN** no backend menu is shown for that agent
- **AND** the agent is configured with the `codex` backend

#### Scenario: Non-TTY add never blocks on the menu

- **WHEN** an add / login command runs without a TTY (piped or scripted) and no
  `--agent` flag
- **THEN** no backend menu is shown and the command does not block waiting for
  input
- **AND** no backend value is written for that agent (it inherits the daemon
  default at resolve time)

### Requirement: No explicit backend choice inherits the daemon default

The command SHALL write no backend value for an agent when the operator makes no explicit choice — pressing Enter at the menu, entering an unrecognized value, running without a TTY, and passing no `--agent` flag. An appended `agents[]` entry MUST omit `agentType` (so it inherits the daemon's top-level default at resolve time); a single-agent login MUST omit the top-level `agent` field (so it resolves to the default backend, claude-code). The command MUST NOT write a literal `claude-code` value on an empty selection.

#### Scenario: Enter at the menu inherits the default

- **WHEN** the operator presses Enter (empty input) at the backend menu during
  an append flow
- **THEN** the new `agents[]` entry is written without an `agentType` key
- **AND** at daemon start that agent resolves to the daemon's top-level default
  backend

#### Scenario: Single-agent login without a choice omits the backend field

- **WHEN** `chorus login` (single-agent) completes with no `--agent` flag and no
  menu selection
- **THEN** `~/.chorus/daemon.json` is written without a top-level `agent` key
- **AND** the daemon resolves that agent to claude-code

### Requirement: The backend menu is a single shared source of truth

The interactive backend menu presented by the add / login / install-add flows SHALL be the same menu list used by the daemon-level install backend selection, so the advertised backends never diverge between entry points. Adding or removing an advertised backend MUST be a single edit that all prompts pick up.

#### Scenario: Add-flow menu matches the install backend menu

- **WHEN** the add / login backend menu is displayed
- **THEN** it lists exactly the backends advertised by the install backend menu
  (currently claude-code, codex, kiro; `dsh` de-advertised)
- **AND** re-advertising a backend in the shared list makes it appear in every
  prompt without a further code change

