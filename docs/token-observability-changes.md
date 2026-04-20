# Token Observability Changes Summary

## Architecture Overview

Token usage is tracked per-assistant-turn via `TokenUsageRecord` table (decoupled from AgentSession). The CC Stop hook fires every assistant turn, uploading the full transcript turns + entity timeline to the server. Server does attribution and dedup.

## Changed Files

### Shell Scripts (Plugin)

**`public/chorus-plugin/bin/on-stop.sh`**
- Stop hook fires every assistant turn (async)
- Extracts turns (per-assistant-message usage with timestamp) from transcript
- **NEW**: Extracts entity timeline from transcript's MCP tool_use blocks (was: tool-log.jsonl)
- Builds payload via temp files + jq --slurpfile (avoids shell arg length limits)
- POSTs to `/api/agent-report/token-usage` with `sourceSessionId` for dedup

**`public/chorus-plugin/bin/on-subagent-stop.sh`**
- Layer 3 added: parses sub-agent transcript for turns + timeline, POSTs to server
- **NEW**: Extracts entity timeline from sub-agent's own transcript (was: tool-log.jsonl filtered by agent_id)
- Passes `sessionUuid` (Chorus session) so server can distinguish sub-agent vs main agent records

**`public/chorus-plugin/bin/on-session-end.sh`**
- Same transcript-based timeline extraction as on-stop.sh
- Final upload on session close

**`public/chorus-plugin/hooks/hooks.json`**
- Added Stop hook entry with nested format: `{matcher: "", hooks: [{type, command, async: true}]}`

### Server (API + Service)

**`src/app/api/agent-report/token-usage/route.ts`**
- Accepts `{sourceSessionId?, sessionUuid?, turns[], timeline[]}`
- Calls `attributeTokenUsage()` for per-turn entity attribution
- **NEW**: Calls `resolveProjectUuids()` (plural) for per-record projectUuid resolution
- Each record gets projectUuid based on its own entityUuid, not a single shared value

**`src/services/observability.service.ts`**

Key functions:
- `attributeTokenUsage()` — per-turn records with timeline entity matching via `findActiveEntity()` (carry-forward: last timeline entry before turn timestamp)
- **NEW**: `resolveProjectUuids()` — batch-queries all entity UUIDs, returns Map<entityUuid, projectUuid>. Replaces old `resolveProjectUuid()` which returned a single value for all records
- `insertAttributedTokenUsage()` — uses `prisma.createMany` with `skipDuplicates` on `(sourceSessionId, turnTimestamp)` unique constraint
- `getIdeaLifecycleTokens()` — **NEW phase token logic**: uses `sessionUuid` to split tokens between phases:
  - proposal entity + sessionUuid → review (sub-agent reviewer)
  - proposal entity + no sessionUuid → proposal drafting (main agent)
  - task entity + sessionUuid → execution (sub-agent dev)
  - task entity + no sessionUuid → verify (main agent admin)
  - idea entity → elaboration

### Database

**`prisma/schema.prisma`**
- Added `TokenUsageRecord` model with `@@unique([sourceSessionId, turnTimestamp])` for dedup
- Removed `tokenUsage` JSON field from `AgentSession`

## Key Design Decisions

1. **Timeline from transcript, not tool-log.jsonl** — Each agent's transcript is independent. tool-log.jsonl is shared and mixes agents. Transcript has MCP tool_use blocks with entity UUIDs in input params.

2. **Per-record projectUuid** — A single CC session may span multiple projects. Each record's entityUuid resolves to its own projectUuid. Records without entity get null projectUuid.

3. **sessionUuid distinguishes main agent vs sub-agent** — Sub-agents have Chorus sessions (sessionUuid set). Main agent records have sessionUuid null. This is used for phase attribution in lifecycle views.

4. **Server-side dedup** — Stop hook uploads full transcript every turn. `skipDuplicates` on `(sourceSessionId, turnTimestamp)` prevents re-insertion. Only new turns get inserted.

5. **Server resolves projectUuid** — Client doesn't need to track project. Server looks up entity → project via DB (task→proposal→project, idea→project, proposal→project).

## Known Limitations

- **Long CC sessions across projects**: The carry-forward entity attribution means turns between entity tool calls inherit the last entity. In a single-project session this is correct. In a multi-project session, turns after switching projects but before the first entity tool call in the new project may still be attributed to the previous project's entity.
- **Stale data from old uploads**: Records inserted by older code versions (single projectUuid, tool-log.jsonl timeline) remain in the DB. They are dedup-protected and won't be overwritten. For clean testing, use a brand new project in a fresh CC session.

## Testing Checklist

To verify E2E in a **new CC session** (important — avoids stale data):

1. Create a new project
2. Create idea, claim, skip elaboration (generates idea entity timeline entries)
3. Create proposal with doc + task drafts, submit (generates proposal entity entries)
4. Spawn proposal-reviewer sub-agent (generates reviewer token upload via on-subagent-stop)
5. Approve proposal (materializes tasks)
6. Spawn dev sub-agent to execute task (generates task entity + dev token upload)
7. Verify task as admin
8. Check observability page: project total should be reasonable (not millions)
9. Check idea detail → Tokens tab: lifecycle phases should have distinct non-zero values
10. Check proposal detail: Total Tokens and Tool Calls should reflect actual work
11. Verify Review phase shows reviewer's tokens (non-zero), separate from Proposal drafting
12. Verify Execution phase shows dev's tokens, separate from Verify phase
