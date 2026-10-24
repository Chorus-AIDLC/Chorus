export const TEAM_ROUTING_GUIDANCE = [
  "[Chorus Team routing — authoritative before action]",
  "Before acting on any event below, resolve its root Idea with chorus_get_idea / chorus_get_task / chorus_get_proposal / chorus_get_document, including proposal input ancestry. Fetch chorus_get_idea_team_context({ideaUuid}) for that Idea and every linked input Idea; re-read before delegation, approval or verification. Session anchors, mentions, project Team snapshots and wake text are not authority. Missing or ambiguous ancestry/context for Idea-backed work is a stop, not an unmanaged fallback; confirmed standalone Quick Tasks/documents and session instructions with no Idea keep their legacy flow.",
  "An unassigned Idea stays unassigned: never auto-claim or assign it merely because a Team exists. Only explicit human assignment/selection or verified human authorization proof starts Team automation; creation, self-claim, comments, presence and template binding do not. For managed work the Idea's current logical agent assignee is its orchestrator, not the project's fixed Team lead. Private Team activation requires the receiving agent owner's consent. A delegated product agent must not claim, release or reassign the Idea; it may elaborate and create/submit proposals, not resolve elaboration, approve proposals or verify tasks. These rules take precedence over the generic claim/execute instructions below. For unmanaged work preserve legacy flows.",
  "Only the current active orchestrator routes managed work. A resumed Team handoff must re-read the original entity and current Idea Team context, then resume proposal review, task verification, routing or completion coordination without claim-takeover. Call chorus_recommend_team_agent({ideaUuid,role:\"product\"}) or chorus_recommend_team_agent({ideaUuid,role:\"development\",taskUuid}) and follow its decision/reason. Use chorus_delegate_team_product({ideaUuid,agentUuid}) for product delegation, not Idea reassignment; use task assignment for development. Redelegation invalidates the current turn and schedules a fresh turn: stop, never continue with stale generation authority. Never invent candidates or infer permission from membership. Empty/all-ineligible roles mean manual handling, not fixed-lead fallback. Eligible but all-offline members may fall back only to an eligible online orchestrator as returned by the tool. Honor recommended, lead_decision, manual and paused; ties need the current orchestrator decision, never arbitrary selection.",
  "When state is paused, stop all automated Team actions and request explicit human repair. Non-YOLO proposal approval is human-only; server-confirmed human YOLO belongs to this exact Idea and survives reassignment, but every gate still requires the current actor and existing action permissions. Task verification belongs to the current active orchestrator (with existing permissions), not the delegated product or worker. Respect all linked Idea gates and source generation fences; retain authorized human control. Do not bypass a denied gate, infer YOLO from wake wording, or poll for approval: report the reason and end the turn. No independent Reviewer auto-wake is included; existing independent review is not approval authority.",
].join("\n");

export function withTeamRoutingGuidance(message: string): string {
  return `${TEAM_ROUTING_GUIDANCE}\n\n${message}`;
}

export function buildResumePrompt(entityType: string, entityUuid: string): string {
  return withTeamRoutingGuidance(
    `[Chorus] Your previous run for this ${entityType} was interrupted by a human and is now being resumed. ` +
    `Continue where you left off (entityType: ${entityType}, entityUuid: ${entityUuid}).`,
  );
}

export interface TeamLeadHandoffNotification {
  uuid: string;
  action: string;
  entityType: string;
  entityUuid: string;
  entityTitle: string;
  projectUuid: string;
  message: string;
}

export function buildTeamLeadHandoff(notification: TeamLeadHandoffNotification): string {
  return `[Chorus] Idea orchestrator handoff for ${notification.entityType} '${notification.entityTitle}' ` +
    `(entityType: ${notification.entityType}, entityUuid: ${notification.entityUuid}, projectUuid: ${notification.projectUuid}): ${notification.message}\n` +
    `Fetch the entity and its current Idea/Proposal ancestry, then chorus_get_idea_team_context for the root Idea and all linked input Ideas. ` +
    `Only the current active enrolled Idea assignee orchestrator may resume the appropriate coordination phase: review a submitted proposal, verify submitted tasks, route ready work, or reconcile completion/report state. ` +
    `Stop when paused, stale or no longer orchestrator. Non-YOLO proposal approval remains human-only; server-confirmed Idea-scoped YOLO survives reassignment and permits current-orchestrator approval with existing permissions. Task verification belongs to the current orchestrator. ` +
    `This is not a task assignment or permission to claim/take over the Idea or another agent's task, and it must not wake a reviewer agent.`;
}
