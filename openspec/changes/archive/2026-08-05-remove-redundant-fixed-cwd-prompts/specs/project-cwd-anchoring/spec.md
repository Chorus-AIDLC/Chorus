## MODIFIED Requirements

### Requirement: Fixed-anchor UI suppresses cwd selection

Every project workflow surface that would otherwise ask for an Agent instance or cwd SHALL
hide that picker when a fixed target exists. Assignment and stage-entry surfaces other
than the Proposal header MUST display a read-only anchor summary and a route to manage the
preference in Project Settings. The Proposal header MUST suppress its redundant read-only
anchor card while retaining fixed-target execution behavior.

#### Scenario: Fixed target is ready
- **WHEN** a fixed Agent target is available on an assignment or stage-entry surface other than the Proposal header
- **THEN** the surface MUST display the resolved host and cwd
- **AND** no selectable instance or temporary-directory control may be rendered

#### Scenario: Proposal header has a fixed target
- **WHEN** Proposal actions resolve a fixed Agent target
- **THEN** the Proposal header MUST NOT render `FixedCwdAnchor`
- **AND** proposal actions MUST retain the fixed target for execution without showing an alternate cwd picker

#### Scenario: Multiple Agents have fixed targets
- **WHEN** a project has independent fixed cwd preferences for Agent A and Agent B
- **THEN** selecting either Agent outside the Proposal header MUST display only that Agent's anchor
- **AND** changing one preference MUST NOT alter the other Agent's UI or resolution
