// cli/prompts.mjs
// Per-notification-action prompt builders. Ported from the OpenClaw plugin's
// event-router wake messages. The spawned Claude is headless and acts only
// through the chorus_* MCP tools — these prompts tell it what happened and
// which tools to use.

/**
 * @typedef {Object} NotificationDetail
 * @property {string} uuid
 * @property {string} projectUuid
 * @property {string} entityType
 * @property {string} entityUuid
 * @property {string} entityTitle
 * @property {string} action
 * @property {string} message
 * @property {string} actorType
 * @property {string} actorUuid
 * @property {string} actorName
 */

/** @param {NotificationDetail} n @param {string} entityType */
function mentionGuidance(n, entityType) {
  return (
    `After completing your work, post a comment on this ${entityType} using ` +
    `chorus_add_comment with @mention: @[${n.actorName}](${n.actorType}:${n.actorUuid})`
  );
}

/**
 * Build the wake prompt for a notification, or null if the action has no
 * wake (caller ignores those). Mirrors the OpenClaw event-router handlers.
 * @param {NotificationDetail} n
 * @returns {string | null}
 */
export function buildPrompt(n) {
  switch (n.action) {
    case "task_assigned":
      return (
        `[Chorus] Task assigned: ${n.entityTitle}. Task UUID: ${n.entityUuid}, ` +
        `Project UUID: ${n.projectUuid}. Use chorus_get_task to review the task, ` +
        `then chorus_claim_task to start work.\n${mentionGuidance(n, "task")}`
      );
    case "mentioned":
      return (
        `[Chorus] You were @mentioned in ${n.entityType} '${n.entityTitle}' ` +
        `(entityType: ${n.entityType}, entityUuid: ${n.entityUuid}, projectUuid: ${n.projectUuid}): ${n.message}\n` +
        `Review the ${n.entityType} and use chorus_get_comments (targetType: "${n.entityType}", ` +
        `targetUuid: "${n.entityUuid}") to see the conversation, then respond.\n${mentionGuidance(n, n.entityType)}`
      );
    case "elaboration_requested":
      return (
        `[Chorus] Elaboration requested for idea '${n.entityTitle}' ` +
        `(ideaUuid: ${n.entityUuid}, projectUuid: ${n.projectUuid}). ` +
        `Use chorus_get_elaboration to review the questions.`
      );
    case "elaboration_answered":
      return (
        `[Chorus] Elaboration answers were submitted for idea '${n.entityTitle}' ` +
        `(ideaUuid: ${n.entityUuid}, projectUuid: ${n.projectUuid}). Use chorus_get_elaboration to review the ` +
        `answers, then either resolve the elaboration (chorus_pm_validate_elaboration) and proceed to a proposal, ` +
        `or open another round (chorus_pm_start_elaboration) if gaps remain.\n${mentionGuidance(n, "idea")}`
      );
    case "proposal_rejected":
      return (
        `[Chorus] Proposal '${n.entityTitle}' was REJECTED (proposalUuid: ${n.entityUuid}, ` +
        `projectUuid: ${n.projectUuid}). Review note: "${n.message}". Use chorus_get_proposal to review, ` +
        `fix issues with chorus_pm_update_task_draft / chorus_pm_update_document_draft, then ` +
        `chorus_pm_validate_proposal and chorus_pm_submit_proposal to resubmit.\n${mentionGuidance(n, "proposal")}`
      );
    case "proposal_approved":
      return (
        `[Chorus] Proposal '${n.entityTitle}' was APPROVED (proposalUuid: ${n.entityUuid}, ` +
        `projectUuid: ${n.projectUuid}). Its documents and tasks have been created. Use ` +
        `chorus_get_unblocked_tasks (projectUuid: "${n.projectUuid}") to find tasks ready to start.\n${mentionGuidance(n, "proposal")}`
      );
    case "idea_claimed":
      return (
        `[Chorus] Idea '${n.entityTitle}' was assigned to you (ideaUuid: ${n.entityUuid}, ` +
        `projectUuid: ${n.projectUuid}). Use chorus_get_idea to review it, then claim it ` +
        `(chorus_claim_idea) to begin elaboration.\n${mentionGuidance(n, "idea")}`
      );
    case "task_reopened":
      return (
        `[Chorus] Task '${n.entityTitle}' was reopened and needs rework (taskUuid: ${n.entityUuid}, ` +
        `projectUuid: ${n.projectUuid}). Use chorus_get_task and chorus_get_comments to see the ` +
        `verification feedback, then fix the issues.\n${mentionGuidance(n, "task")}`
      );
    case "task_verified":
      return (
        `[Chorus] Task '${n.entityTitle}' was verified and is now done (taskUuid: ${n.entityUuid}, ` +
        `projectUuid: ${n.projectUuid}). Use chorus_get_unblocked_tasks (projectUuid: "${n.projectUuid}") ` +
        `to see whether this unblocked any tasks that are now ready to start.`
      );
    default:
      return null;
  }
}

/**
 * Actions that produce a wake. Used by the router to decide whether to enqueue.
 *
 * Covers the notifications that imply the agent should act — an explicit
 * @mention, assignment, lifecycle transitions it owns, and unblock signals.
 * Deliberately NOT woken:
 *   - comment_added             (fires for EVERY comment to the task's
 *                                assignee+creator, not just ones directed at the
 *                                agent — too noisy; an @mention is the real
 *                                "I need you" signal and arrives as `mentioned`)
 *   - task_status_changed       (high-frequency, usually a side effect of own work)
 *   - task_submitted_for_verify (reviewer/owner channel; verification is its own flow)
 *   - report_created            (informational summary)
 * The switch in buildPrompt is the source of truth — keep them in sync (a test
 * asserts every WAKE_ACTIONS entry yields a non-null prompt).
 */
export const WAKE_ACTIONS = new Set([
  "task_assigned",
  "mentioned",
  "elaboration_requested",
  "elaboration_answered",
  "proposal_rejected",
  "proposal_approved",
  "idea_claimed",
  "task_reopened",
  "task_verified",
]);
