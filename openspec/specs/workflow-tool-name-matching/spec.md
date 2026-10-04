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
Pi SHALL identify workflow operations solely from each event's outer `toolName` using the same arbitrary-prefix complete-ending rule as dsh. This includes Pi 1.x native default codemode child events and direct MCP events with real `mcp__<server>__<tool>` names. Pi SHALL NOT special-case gateway names or inspect `input.tool` to identify a workflow.

#### Scenario: Gateway namespace in a target identifier
- **WHEN** an eligible event's outer identifier is `custom.gateway.chorus_submit_for_verify`
- **THEN** the existing enabled reminder is delivered using the uniform outer-name rule

#### Scenario: Opaque wrapper or unrelated outer tool
- **WHEN** the outer identifier is `mcp`, `mcp__chorus`, `bash`, or another non-target name and its arguments contain `tool: "chorus_submit_for_verify"`
- **THEN** no workflow reminder is delivered

#### Scenario: Arguments do not affect target identification
- **WHEN** an eligible outer identifier ends exactly in a target operation and its input is missing, malformed, or names a different tool
- **THEN** Pi identifies the outer operation without reading its input

#### Scenario: Native default codemode exposes eligible child events
- **WHEN** native Pi 1.x codemode invokes `chorus_pm_submit_proposal`, `chorus_submit_for_verify`, or `chorus_admin_verify_task` on a configured MCP server
- **THEN** each child `tool_call` and `tool_result` event carries the real `mcp__<server>__<tool>` name and the codemode call ID in `parentToolCallId`
- **AND** the child's own outer `toolName` identifies the operation using the existing arbitrary-prefix complete-ending rule
- **AND** an eligible successful child result delivers its existing enabled reviewer reminder without requiring direct exposure

#### Scenario: Native direct MCP uses the same matcher
- **WHEN** an eligible successful native direct MCP result has an outer `toolName` ending exactly in any of the three workflow operations
- **THEN** Pi delivers the same existing enabled reviewer reminder using the uniform outer-name rule

#### Scenario: Codemode parent does not duplicate child delivery
- **WHEN** one eligible successful MCP child result delivers a reminder and its enclosing `codemode` result and execution-end events also arrive
- **THEN** those parent and execution-end events produce no additional reviewer reminder
- **AND** operation names in the parent script or arguments do not affect identification

#### Scenario: Native names retain complete-ending boundaries
- **WHEN** a native MCP tool name ends in an incomplete or differently cased operation, or a complete target operation followed by `_extra`, whitespace, or a newline
- **THEN** Pi produces no workflow reminder without trimming or coercing the name

#### Scenario: Native child failure or disabled reviewer
- **WHEN** a target native MCP child result reports an error, Chorus is unconfigured, or the relevant reviewer switch is disabled
- **THEN** Pi produces no workflow reminder even if the enclosing codemode script completes successfully

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

### Requirement: Pi 1.x native workflow verification uses the actual host pipeline
Verification SHALL exercise default codemode and direct MCP routes through the actual Pi 1.x SDK pipeline and Chorus extension with a local MCP fixture. It SHALL record real events and steering reminders for all three workflow operations, success and suppression cases, and absence of duplicate parent injection. It SHALL require neither real business writes nor model-provider credentials, and SHALL distinguish SDK host evidence from mocked offline tests.

#### Scenario: Default codemode host success for each operation
- **WHEN** the SDK executes each of the three workflow operations through native default codemode against the local fixture with Chorus configured and its reviewer enabled
- **THEN** the evidence records the SDK version, reproducible command, real child `tool_call` and `tool_result` names/IDs, and matching `parentToolCallId`
- **AND** the observable steering messages contain exactly one existing corresponding reviewer reminder per successful child invocation
- **AND** enclosing parent and execution-end events produce no additional reminder

#### Scenario: Direct host success for each operation
- **WHEN** the SDK executes each of the three workflow operations as a native direct MCP call against the local fixture
- **THEN** the evidence records real MCP event names and exactly one equivalent reviewer steering reminder per eligible successful invocation

#### Scenario: Host verification covers suppression
- **WHEN** the local fixture returns a workflow error, the relevant reviewer toggle is disabled, Chorus is unconfigured, or the invoked outer name is a near miss or unrelated tool with workflow-looking arguments
- **THEN** host evidence records no reviewer reminder for that invocation
- **AND** failed codemode children remain suppressed even when their parent script succeeds

#### Scenario: Deterministic execution retains the real host boundary
- **WHEN** a deterministic local assistant/tool-call source supplies execution without model-provider credentials
- **THEN** native MCP execution, Pi's event dispatch, the actual Chorus handlers, and observable steering delivery still run through the SDK
- **AND** fabricated event dispatch, direct handler invocation, or mocked native MCP is not reported as host verification

#### Scenario: Packaged reviewers can reach native default MCP
- **WHEN** each packaged reviewer's actual tool list is applied to a native default-codemode SDK session
- **THEN** `codemode` and `tool_search` are allowed alongside its existing read-only project tools
- **AND** the bundled dispatcher expands Pi's nested-tool hard allowlist with native Chorus query/checkin/comment names discovered in the parent, excluding submission/admin/mutation operations
- **AND** the session can execute native fixture MCP reads including `chorus_list_tasks` and `chorus_list_projects`, plus `chorus_add_comment`, without modifying project files or real Chorus entities
- **AND** only these explicitly permitted list operations are added from parent discovery, while generic list names and business mutations remain excluded

#### Scenario: Fixture isolation and evidence limits
- **WHEN** host verification is run and reported
- **THEN** it uses isolated session/configuration resources, local MCP and bookkeeping endpoints, and dummy credentials without real Chorus mutations
- **AND** the report separates SDK pipeline results from offline tests and records any unexecuted case as unverified rather than inferring a pass
