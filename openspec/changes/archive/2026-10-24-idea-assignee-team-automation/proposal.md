## Why

The deployed Team implementation makes membership in the project's fixed `lead` role a prerequisite for orchestration. Felix instead wants each explicitly assigned Idea owner to coordinate its own work, using the owner's private Team as a collaboration pool. Assignment is the start signal; merely creating an unassigned Idea is not.

This is a follow-up to [deployed PR #642](ref:26370308-0ef2-4eca-bfda-15defa4be6d6), not a revocation of its delivered tasks. Human elaboration round 3 selected `creation_selection_counts`, `verified_human_instruction`, and `same_owner_only`. Comment `c21a09fc-4a03-44fd-9188-af58372d7f51`, recorded in round 4, selected YOLO A: authorization belongs to the Idea and survives reassignment.

## What Changes

- Use the Idea's current logical agent assignee as orchestrator, without requiring Team lead membership or granting extra permissions.
- Start through verified human assignment, including human-selected conversational creation and agent-mediated assignment backed by validated human authorization.
- Do not start on bare creation, agent self-claim, arbitrary comments, template binding, agent presence, or database upgrade.
- Require the receiving agent's owner to authorize use of their private Team; legitimate cross-owner assignment alone does not activate it.
- Fence reassignment with a monotonically increasing generation, invalidate old product delegations and queued orchestration turns, and preserve executing tasks.
- Keep Idea-scoped human YOLO across reassignment, with current-actor and action-permission checks on every gate.
- Keep normal human assignment in the existing assignment modal: selecting the assignee is authorization, with no extra proof button, proof UUID or `chorus:assign` hints. Hide the Team gate panel for unmanaged Ideas; managed Ideas show only compact proposal/task gates and, when paused, the reason. Refresh silently on window focus and every 30 seconds, hiding the panel on errors rather than retaining stale gates.
- This UI cleanup does not revoke D2 verified agent-mediated assignment, human-selected conversational creation, receiver-owner consent, or any existing backend authorization checks.
- Update UI, MCP contracts, maintained runtime/skill ports, tests, and local deployment evidence.

## Capabilities

### New Capabilities

None; this extends the existing orchestration capability.

### Modified Capabilities

- `idea-team-orchestration`: assignee-based enrollment, verifiable start authority, generation-fenced handoff, private-Team consent, and current-orchestrator gates.

## Impact

Changes affect Idea assignment/creation services and all UI/REST/MCP adapters, Prisma through an additive migration, notification admission/recovery, proposal/task authorization, gate UI and translations, and plugin instructions. Preserve the already-applied `20261023091000_idea_team_enrollment` migration and PR #642 transaction-retry fixes.

Not included: independent reviewer orchestration, cross-user Team sharing, automatic owner selection, historical bulk activation, automatic PR merge, or package publication. Local deployment is requested, after proposal approval, implementation, independent verification, and backup.

## Acceptance Summary

Two Ideas assigned respectively to Leo and Tom coordinate independently even when Clay is the Team default lead. Creation without selection stays idle; explicit selection at creation starts once. Verified human delegation works without letting agent-authored text impersonate consent. Reassignment rejects old queued work and old agent gates while preserving Idea-level YOLO. Private routing stays private, legacy work is not silently activated, and the existing local stack remains healthy after incremental deployment.

The existing assignment modal remains sufficient for normal human assignment. Unmanaged Ideas have no Team gate panel; managed Ideas show only proposal approval, task verification and an optional paused reason, without proof controls, legacy/YOLO explanations, loading or error notices. Silent focus/30-second refresh reflects external reassignment, unbinding and pause; failed reads hide stale information, and unmount cleans up refresh listeners and timers.
