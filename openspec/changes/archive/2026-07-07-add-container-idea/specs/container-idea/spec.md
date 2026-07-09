# container-idea Specification

## ADDED Requirements

### Requirement: An Idea SHALL carry an explicit `isContainer` flag orthogonal to lineage

The `Idea` model SHALL have a boolean field `isContainer` defaulting to `false`. The flag is set explicitly by a user or agent and is independent of `parentUuid`: an idea MAY be a container with or without a parent, and a non-container idea MAY have child ideas. Adding the field SHALL be a single additive migration (`ALTER TABLE "Idea" ADD COLUMN "isContainer" BOOLEAN NOT NULL DEFAULT false`) with no index and no data backfill. The flag SHALL be surfaced on the Idea DTO returned by read paths so that clients can render container affordances.

#### Scenario: New ideas default to non-container

- **WHEN** an idea is created without specifying `isContainer`
- **THEN** its `isContainer` value MUST be `false`
- **AND** it MUST behave exactly as ideas did before this change

#### Scenario: A non-container idea may still have children

- **GIVEN** an idea with `isContainer = false`
- **WHEN** a child idea is derived from it (created with `parentUuid` set to it)
- **THEN** the operation MUST succeed
- **AND** the parent's `isContainer` MUST remain `false`

#### Scenario: The container flag is present on read payloads

- **GIVEN** an idea with `isContainer = true`
- **WHEN** a client fetches the idea via `chorus_get_idea` (or the idea read REST route)
- **THEN** the response MUST include `isContainer: true`

### Requirement: A container idea MAY elaborate but MUST NOT create a proposal

A container idea SHALL retain the full elaboration lifecycle unchanged. However, creating a Proposal whose `inputType = "idea"` and whose input idea has `isContainer = true` MUST be rejected at the service layer (`createProposal`), which is the single choke point for every proposal-creation entry point (MCP tool, REST route, server action, full-page form). The rejection MUST return a clear error and MUST NOT persist a Proposal row. Only proposal creation is blocked — task creation and claim-for-development on the idea are NOT additionally restricted by this change.

#### Scenario: Elaboration on a container succeeds

- **GIVEN** an idea with `isContainer = true`
- **WHEN** an agent starts and answers an elaboration round on it, then resolves elaboration
- **THEN** every elaboration operation MUST succeed exactly as for a non-container idea

#### Scenario: Proposal creation from a container is rejected

- **GIVEN** an idea with `isContainer = true`
- **WHEN** any caller attempts to create a Proposal with `inputType = "idea"` and that idea in `inputUuids`
- **THEN** the service MUST reject the request with a clear error message
- **AND** no Proposal row MUST be persisted

#### Scenario: Proposal creation from a mixed input set including a container is rejected

- **GIVEN** a proposal-creation request with multiple input ideas, at least one of which has `isContainer = true`
- **WHEN** the request reaches `createProposal`
- **THEN** the request MUST be rejected
- **AND** no Proposal row MUST be persisted

#### Scenario: Proposal creation from a non-container idea is unaffected

- **GIVEN** an idea with `isContainer = false`
- **WHEN** a caller creates a Proposal with `inputType = "idea"` and that idea in `inputUuids`
- **THEN** the Proposal MUST be created as before

### Requirement: The container flag SHALL be freely reversible without cascade

Setting or clearing `isContainer` SHALL be permitted at any time via the idea edit paths (`chorus_edit_idea`, `PATCH /api/ideas/[uuid]`, and the panel edit action). Toggling the flag MUST NOT delete, close, or otherwise mutate any Proposal, Task, Document, or Activity already linked to the idea. When an idea that already has proposals is flagged as a container, the container proposal guard applies only to **new** proposal creation; pre-existing proposals remain intact and readable.

#### Scenario: Toggling to container preserves existing proposals

- **GIVEN** an idea with `isContainer = false` that already has one or more Proposals
- **WHEN** it is edited to set `isContainer = true`
- **THEN** the edit MUST succeed
- **AND** all pre-existing Proposals, Tasks, and Documents MUST remain unchanged
- **AND** subsequent attempts to create a NEW proposal from the idea MUST be rejected

#### Scenario: Toggling back to non-container re-enables proposal creation

- **GIVEN** an idea with `isContainer = true`
- **WHEN** it is edited to set `isContainer = false`
- **THEN** creating a Proposal from it MUST succeed again

### Requirement: `chorus_edit_idea` and `chorus_pm_create_idea` SHALL accept `isContainer`

The `chorus_edit_idea` MCP tool SHALL accept an optional `isContainer` boolean and count it toward the "at least one field provided" precondition, passing it through to `updateIdea`. The `chorus_pm_create_idea` MCP tool SHALL accept an optional `isContainer` boolean and pass it through to `createIdea`. Both tools remain gated on `idea:write`.

#### Scenario: Editing only the container flag is a valid edit

- **GIVEN** an existing idea
- **WHEN** `chorus_edit_idea` is called with only `ideaUuid` and `isContainer`
- **THEN** the call MUST NOT be rejected by the empty-edit guard
- **AND** the idea's `isContainer` MUST be updated to the provided value

#### Scenario: Creating an idea as a container

- **WHEN** `chorus_pm_create_idea` is called with `isContainer: true`
- **THEN** the created idea's `isContainer` MUST be `true`

### Requirement: The idea detail panel SHALL expose a container toggle, badge, hidden proposal CTA, and read-only child rollup

In the idea detail panel, a user SHALL be able to toggle the idea's container status. A container idea SHALL display a "Container" badge. On a container idea, the proposal-progression call(s)-to-action (Verify Elaborate / Start Development / Yolo) SHALL be hidden and the "Derive child idea" action SHALL be the primary progression path. The lineage section SHALL display a read-only child-completion rollup counting direct children whose derived status is `done` over the total number of direct children. No new stored status field SHALL be introduced for this rollup. All user-facing strings SHALL be internationalized in both `en` and `zh` locales.

#### Scenario: Container badge and hidden proposal CTA

- **GIVEN** an idea with `isContainer = true` open in the detail panel
- **THEN** a "Container" badge MUST be visible
- **AND** the Verify Elaborate / Start Development / Yolo CTAs MUST NOT be shown
- **AND** a "Derive child idea" action MUST be available

#### Scenario: Toggling container from the panel

- **GIVEN** a non-container idea open in the detail panel
- **WHEN** the user toggles it to container
- **THEN** the panel MUST call the idea edit action with `isContainer: true`
- **AND** after refresh the container affordances MUST be shown

#### Scenario: Read-only child-completion rollup

- **GIVEN** a container idea with 5 direct children of which 3 have derived status `done`
- **WHEN** the detail panel renders the lineage section
- **THEN** it MUST display a read-only "3/5" (children done / total) indicator
- **AND** this indicator MUST NOT be editable
