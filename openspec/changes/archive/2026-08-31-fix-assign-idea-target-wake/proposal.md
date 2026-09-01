## Why

`chorus_pm_assign_idea` claims parity with the UI assignment action but does not resolve the project-fixed cwd target before persisting an agent assignment. This can leave a plain-agent assignment whose initial wake is not delivered.

## What Changes

- Resolve agent assignment targets through `resolveProjectAgentCwdTarget` using the calling agent owner's project preferences, matching the UI action.
- Persist project-fixed instance and cwd provenance before emitting the `assigned` activity.
- Emit a delegation wake only when the logical agent assignee is new or changes; same-agent pin/cwd updates remain persisted but wake-deduplicated.
- Update the MCP tool description to document automatic project-fixed pinning and same-agent wake deduplication.
- Add unit and integration regressions for automatic pinning and same-agent plain-to-pinned wake suppression.

## Capabilities

### New Capabilities

None.

### Modified Capabilities

- `idea-lifecycle-assignment`: Align MCP agent assignment target resolution and same-assignee wake deduplication with the UI path.

## Impact

- `src/mcp/tools/pm.ts`
- `src/services/project-agent-cwd.service.ts` integration from the MCP handler
- MCP assignment unit tests and assignment-to-daemon-turn integration tests
- No schema, API input, or dependency changes
