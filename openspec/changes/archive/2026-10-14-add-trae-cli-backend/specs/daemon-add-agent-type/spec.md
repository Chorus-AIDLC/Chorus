## MODIFIED Requirements

### Requirement: The backend menu is a single shared source of truth

The interactive backend menu presented by the add / login / install-add flows SHALL be the same menu list used by the daemon-level install backend selection, so the advertised backends never diverge between entry points. Adding or removing an advertised backend MUST be a single edit that all prompts pick up.

#### Scenario: Add-flow menu matches the install backend menu

- **WHEN** the add / login backend menu is displayed
- **THEN** it lists exactly the backends advertised by the install backend menu
  (currently claude-code, codex, kiro, pi, trae; `dsh` de-advertised)
- **AND** re-advertising a backend in the shared list makes it appear in every
  prompt without a further code change

#### Scenario: trae is selectable from the shared menu

- **WHEN** the operator picks the TRAE CLI entry in the add / login / install backend menu
- **THEN** the new agent is persisted with `agentType: "trae"`
- **AND** the same entry appears in every prompt that uses the shared menu
