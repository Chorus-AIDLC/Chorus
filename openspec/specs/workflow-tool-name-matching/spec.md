# workflow-tool-name-matching Specification

## Purpose
Ensure Pi and dsh deliver the existing Chorus workflow reminders when host-specific namespaces change, while preserving complete operation-name boundaries and each host's original execution gates.

## Requirements

### Requirement: Workflow identification tolerates any prefix
Pi and dsh SHALL recognize identifiers ending exactly with `chorus_pm_submit_proposal`, `chorus_submit_for_verify`, or `chorus_admin_verify_task`, with arbitrary preceding text or no prefix.

#### Scenario: Supported and custom namespaces
- **WHEN** an eligible successful event names one of the three operations with no prefix, `chorus_`, `mcp__chorus__`, `mcp__chorus.`, `chorus__`, or a custom namespace prefix
- **THEN** the host identifies the same native workflow operation and makes its existing reminder available

#### Scenario: Glued prefix
- **WHEN** an eligible event names `xchorus_submit_for_verify`
- **THEN** the host identifies `chorus_submit_for_verify` without requiring a delimiter

### Requirement: Identification requires a complete ending
Neither host SHALL produce a workflow reminder for a name lacking an exact complete target operation at its end. Empty, missing, and non-string name inputs SHALL be handled without throwing or producing a reminder.

#### Scenario: Extra trailing text
- **WHEN** an identifier ends with a target name followed by `_extra`, whitespace, or a newline
- **THEN** no workflow reminder is produced

#### Scenario: Similar or unrelated tool
- **WHEN** an identifier is an incomplete or differently cased target name, `chorus_checkin`, or another unrelated tool
- **THEN** no workflow reminder is produced

#### Scenario: Malformed input
- **WHEN** an outer tool name is empty, null, missing, an object, a boolean, or a number
- **THEN** no workflow reminder is produced and recognition does not throw

### Requirement: Pi uses one outer identifier matching rule
Pi SHALL identify workflow operations solely from the event's outer `toolName` using the same arbitrary-prefix complete-ending rule as dsh. Pi SHALL NOT special-case gateway names or inspect `input.tool` to identify a workflow.

#### Scenario: Gateway namespace in a target identifier
- **WHEN** an eligible event's outer identifier is `custom.gateway.chorus_submit_for_verify`
- **THEN** the existing enabled reminder is delivered using the uniform outer-name rule

#### Scenario: Opaque wrapper or unrelated outer tool
- **WHEN** the outer identifier is `mcp`, `mcp__chorus`, `bash`, or another non-target name and its arguments contain `tool: "chorus_submit_for_verify"`
- **THEN** no workflow reminder is delivered

#### Scenario: Arguments do not affect target identification
- **WHEN** an eligible outer identifier ends exactly in a target operation and its input is missing, malformed, or names a different tool
- **THEN** Pi identifies the outer operation without reading its input

### Requirement: Existing execution gates and delivery are preserved
Both hosts SHALL retain their original success, configuration, and lifecycle gates. Pi SHALL retain reviewer toggles and its tool-result delivery timing. dsh SHALL retain downstream acceptance, synthetic-call suppression, pending-action deduplication, and daemon-origin suppression.

#### Scenario: Failed or disabled Pi event
- **WHEN** a target event reports an error or its Pi reviewer switch is disabled
- **THEN** no reminder is delivered

#### Scenario: dsh event rejected by an existing gate
- **WHEN** a target event fails, lacks a started agent, is synthetic, has a non-accept downstream decision, or occurs with daemon-origin lifecycle automation disabled
- **THEN** no pending workflow reminder is added

#### Scenario: dsh deduplicated delivery
- **WHEN** multiple successful aliases of the same operation and target are accepted within one turn
- **THEN** one existing reminder is delivered at turn stopping with the original target UUID

### Requirement: Verification distinguishes offline and host evidence
The change SHALL include positive and negative name matrices and event-to-reminder regression tests in both hosts. Verification reports SHALL distinguish mocked offline handler tests from actual host-session evidence.

#### Scenario: Offline checks succeed
- **WHEN** helper and host handler-factory tests pass without a live host session
- **THEN** the report records them as offline verification

#### Scenario: Host environment unavailable
- **WHEN** usable host prerequisites cannot be obtained for an isolated smoke test
- **THEN** the report records host reminder injection as unverified and states the missing prerequisite
