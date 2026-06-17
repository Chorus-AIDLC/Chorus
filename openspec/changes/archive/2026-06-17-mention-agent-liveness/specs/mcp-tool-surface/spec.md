## ADDED Requirements

### Requirement: `chorus_search_mentionables` SHALL expose agent liveness fields

The `chorus_search_mentionables` MCP tool SHALL return, for each result entry of
type `agent`, the additive fields `online` (boolean) and `activeCount` (integer)
described by the `mention-agent-liveness` capability, and its tool description SHALL
document them so an agent caller knows the fields exist. The addition SHALL be
backward compatible: it SHALL NOT remove or rename any existing result field, SHALL
NOT change the tool's permission gate, and SHALL NOT add a new permission bit.
Entries of type `user` SHALL NOT carry these fields.

#### Scenario: Agent entries carry online and activeCount

- **WHEN** `chorus_search_mentionables` returns a result entry of type `agent`
- **THEN** the entry MUST include an `online` boolean and an `activeCount` integer

#### Scenario: The tool's permission gate is unchanged

- **WHEN** the liveness fields are added to `chorus_search_mentionables`
- **THEN** the tool MUST remain exposed under its existing gate with no new permission bit
- **AND** no existing result field MUST be removed or renamed
