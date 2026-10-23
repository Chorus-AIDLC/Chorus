## Context

`ProjectAgentTeam` is private to project × user; membership does not grant access. `Idea.assigneeType` can be agent_instance. Current elaboration/proposal authoring checks require assignee ownership, whereas task and proposal admin mutation paths lack Team gates. Lifecycle events sometimes notify proposal authors/task assignees rather than the root lead. Existing `yolo_requested` activities are emitted only by human stage-advance.

## Decisions

### Durable explicit enrollment

Persist nullable Idea Team anchors (personal owner user, lead logical agent and delegated product agent). Populate only during explicit assignment to a currently eligible lead, including the existing confirmed project handoff. New creation with no assignee remains untouched. Explicit reassignment updates enrollment for another eligible lead; existing enrollment must not silently vanish when assigned to a non-lead, released, unbound or when a member loses eligibility: keep the guard and expose paused state until a permitted explicit repair to an eligible lead. Legacy non-enrolled Ideas continue the old workflow.

Eligibility requires same company, same Team owner, project access and current role permissions. Resolve agent_instance to its logical agent. Current owner and stored lead must match before automatic actions. Do not infer Team ownership from an unrelated caller or expose another owner's roster.

### Core contracts

New `src/services/idea-team.service.ts` owns durable enrollment, live gate calculation, recommendation and delegation. Export authenticated `getIdeaTeamContext(auth, ideaUuid)` for a public safe summary plus private routing details only for the Team owner/their agents; `recommendIdeaTeamRole(auth, ideaUuid, role, taskUuid?)`; `delegateIdeaTeamProduct(auth, ideaUuid, agentUuid)`; and internal tenant-scoped helpers for mutation gates and notification recipients. Use typed exported DTOs so API/UI/MCP share field meanings. The summary reports `managed`, `state` (`active`/`paused`/`unmanaged`), lead identity, YOLO status, proposal gate (`human`/`lead`), task gate and reason without disclosing a private roster. Unrelated project viewers may see gate responsibility, not personal configuration, candidates or private delegation context.

Recommendation returns a decision (`recommended`, `lead_decision`, `manual`, `paused`), selected agent UUID when unique, candidates and a reason. Product/development only, not automatic review. First filter eligible members. Empty/all-ineligible role means manual, not lead fallback. If eligible but all offline, fall back to eligible online lead; otherwise return manual. For development reopen, prefer online eligible original assignee (resolve instances); otherwise minimum live activeCount, then same-proposal dependency-chain affinity only to break load ties; remaining ties are lead_decision. Task must belong to the Idea through its proposal, with tenant/project scoping. No arbitrary candidate UUID from caller is trusted.

The delegation mutation is current-lead-only (plus existing privileged human management where appropriate), revalidates membership/role eligibility, persists exactly one product delegate and records a directed @mention instruction so the product wakes. That delegate can start elaboration and create/submit proposals for this Idea without changing the lead assignee; existing permissions/project access still apply. Product delegation does not authorize resolve/approval or task verification. Removed/ineligible delegates lose access dynamically. Gate service errors use existing structured error handling.

### Authoritative gates

Only tenant-scoped human `yolo_requested` activity for the exact Idea grants YOLO. Reject agent-created lookalikes. Enforce within shared proposal approval and task `done` transitions, including generic update paths; do not rely solely on MCP/UI handlers. Carry actor identity to all mutation callsites; missing/ambiguous actors must not bypass an enrolled gate. Human users with existing project/admin authority retain control. Agent must be current active enrolled lead and retain action permission; proposal approval additionally requires YOLO. Paused enrollment rejects agent approval/verification. Existing non-Team flows and Quick Tasks remain compatible.

For proposals with multiple input Ideas, apply the intersection of every linked Idea's constraints; a single non-YOLO enrolled input requires human approval, and different leads cannot impersonate one another. Resolve document-input proposals through their source proposal ancestry with cycle protection; ambiguous or missing managed ancestry fails closed rather than silently becoming unmanaged. Task gates use the approved proposal's Idea lineage. Validation and writes should share transaction context where possible to avoid stale-state authorization.

### Delivery, surfaces and ports

Route relevant lifecycle notifications for enrolled work to the lead (deduplicate existing recipients; retain necessary human notifications and direct execution notifications). No new reviewer wake. Prompts instruct agents to fetch authoritative Team context, preserve lead ownership, follow recommendation reasons, and stop for the specified gate. Product must not claim the Idea. This applies to single and batched daemon wake paths and OpenClaw parity.

MCP adds `chorus_get_idea_team_context` (idea:read), `chorus_recommend_team_agent` (idea:read; owner-private), `chorus_delegate_team_product` (idea:write; runtime current lead check). REST GET `/api/ideas/[uuid]/team-context` returns a safe gate summary subject to project viewer access. Idea detail shows who gates proposal/tasks and paused/unmanaged states, with Chinese/English text and theme-compatible styling. Do not expose roster details in shared UI.

### Task partition and verification

Three independently implementable write slices use this contract: backend persistence/services/notification routing; API/MCP/UI integration; daemon prompts and skill/docs parity. They may execute in parallel but final integration requires all three, full typechecking, targeted service/REST/MCP/UI/CLI tests and independent task/aggregate reviews. Migrations are additive; tests use the existing isolated database harness, never mutate production records to simulate gates. Browser acceptance uses local dev auth and disposable fixtures if available. No deployment requested.

## Risks

- Preserving existing user authority and missing Team configuration without silently disabling persisted gates is security-critical.
- Actor provenance must be passed through every done/approve path; regression tests cover missing actor and alternate REST/MCP mutations.
- Agent wake is best-effort; persistent delegate/assignment plus activity evidence is recoverable and wake failures are reported, never described as successful delivery.
- Recommendation load is advisory and can change between read and assign; revalidate assignee eligibility at write time. This is not a global scheduler or reservation system.
- UI must not leak private Team configuration. Explicitly separate safe gate state from owner-only recommendations.
