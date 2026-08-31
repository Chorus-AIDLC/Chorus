## Context

The UI assignment action resolves an agent's project cwd target before calling `assignIdea`. When the owner's project preference is fixed, it persists the matching AgentInstance plus cwd provenance and only then emits the actor-bearing `assigned` activity that drives the wake pipeline.

The MCP handler currently validates the target and calls `assignIdea` directly. Without an explicit `instanceUuid`, it persists a plain agent assignment even when the project has a fixed target. Operational evidence shows that this path can persist successfully without reaching the online worker. A later call that adds a pin must be treated as a fresh delegation, even when the logical agent identity is unchanged.

## Goals / Non-Goals

**Goals:**

- Make MCP agent assignments use the same project-fixed target resolution as UI assignments.
- Persist target provenance before the wake-triggering activity.
- Guarantee a newly responsible agent emits a wake-triggering `assigned` activity while same-agent target updates are deduplicated.
- Preserve existing authorization, validation, status, and user-assignment behavior.

**Non-Goals:**

- Changing notification preference semantics.
- Refactoring task assignment or UI assignment.
- Adding a new wake transport or bypassing the existing activity/notification pipeline.

## Decisions

### Resolve with the caller owner's user context

`resolveProjectAgentCwdTarget` keys project preferences by user. An MCP agent acts on behalf of its owner, so the handler will pass `auth.ownerUuid` as `actorUserUuid`. This mirrors the UI's authenticated user context without inventing agent-scoped cwd preferences.

Alternative: skip resolution and retain wake-time online-first routing. This is rejected because it preserves the observed mismatch and ignores project-fixed routing.

### Project-fixed preference takes precedence over an explicit instance

The handler will use the resolver's AgentInstance whenever `target.source === "project_fixed"`; otherwise it retains the caller's explicit `instanceUuid`. This is the same precedence rule as `claimIdeaToAgentAction` and keeps a project root stable.

Alternative: always prefer the MCP argument. This is rejected because it would keep MCP and UI semantics divergent.

### Keep the existing activity as the deduplicated wake trigger

After assignment succeeds, the handler will create an `assigned` activity only when the logical assignee is new or changes to a different agent. Its value includes the effective instance and project-fixed cwd provenance. A same-owning-agent re-pin persists through `assignIdea` but skips the activity so it cannot create a duplicate notification or daemon turn.

Alternative: add direct daemon wake plumbing. This is rejected because activity-driven notification and turn creation already provide attribution, preferences, and routing.

## Risks / Trade-offs

- [A same-agent re-pin does not restart an idle worker] → This is the selected deduplication semantic; callers that need another turn must use an explicit instruction/mention path.
- [Owner preference lookup can be stale or offline] → Reuse the resolver's existing availability and durable-instance behavior; assignment persistence remains authoritative.
- [Mocks may hide resolver integration errors] → Add both handler-level assertions and the real tool-to-daemon-turn integration scenario.

## Migration Plan

No data migration is required. Deploy the handler and tests together. Rollback restores the previous MCP-only behavior without changing stored schema.

## Open Questions

None.
