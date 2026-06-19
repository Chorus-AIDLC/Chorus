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
 * @property {string} [instructionText]  Free-text body of a `human_instruction` wake
 *   (子1 — daemon-session-conversation). The server denormalizes the canonical turn
 *   promptText onto the wake notification so the daemon reads it in the
 *   `chorus_get_notifications` call it already makes (zero extra fetch); the
 *   event-router threads it here. Present only for the `human_instruction` action.
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
    case "resource_resumed":
      // A user resumed a previously-interrupted wake (子3 — daemon-interrupt-resume).
      // Resume is entity-generic (task / idea / proposal / document) and arrives as a
      // synthetic dispatch off the reverse CONTROL channel — NOT a persisted
      // notification — so it carries only entityType + entityUuid (no actor / title /
      // project). Because the direct-idea transcript already exists on disk, the
      // daemon's isNewSession probe selects `claude --resume <directIdeaUuid>`
      // automatically, so the woken Claude continues the SAME session where it left
      // off. It intentionally has no @mention (a self-resume has no actor to address).
      return (
        `[Chorus] Your work on this ${n.entityType} was RESUMED after an interrupt ` +
        `(${n.entityType}Uuid: ${n.entityUuid}). Continue where you left off — re-check the ` +
        `current state with the appropriate chorus_get_* tool (e.g. chorus_get_task / ` +
        `chorus_get_idea) plus chorus_get_comments for any new feedback, then resume the work ` +
        `you had started.`
      );
    case "task_verified":
      return (
        `[Chorus] Task '${n.entityTitle}' was verified and is now done (taskUuid: ${n.entityUuid}, ` +
        `projectUuid: ${n.projectUuid}). Use chorus_get_unblocked_tasks (projectUuid: "${n.projectUuid}") ` +
        `to see whether this unblocked any tasks that are now ready to start.`
      );
    case "human_instruction": {
      // A human typed a free-text instruction for this daemon's session (子1 — the 子2
      // UI send box, or a backfilled pending instruction). The canonical text lives on
      // the server-side turn's promptText and is denormalized onto the wake
      // notification as `instructionText`, so the daemon reads it WITHOUT an extra
      // fetch and the event-router threads it here. The instruction is delivered on the
      // session the daemon is already running (idea-anchored or the entity itself), so
      // continuation is naturally `claude --resume` of that session. If the body is
      // empty/missing there is nothing to act on — skip (no prompt) rather than spawn a
      // contentless wake.
      const instruction =
        typeof n.instructionText === "string" ? n.instructionText.trim() : "";
      if (!instruction) return null;
      // Optional entity context: a human_instruction may be attached to an entity
      // (task/idea/proposal/document) or be a bare session instruction. Include the
      // entity hint only when present so the agent knows what it relates to.
      const entityHint =
        n.entityType && n.entityUuid
          ? ` (regarding ${n.entityType} ${n.entityUuid}` +
            (n.projectUuid ? `, projectUuid: ${n.projectUuid}` : "") +
            `)`
          : "";
      const actorHint =
        n.actorName && n.actorType && n.actorUuid
          ? `\nWhen you have addressed it, reply with a comment @mentioning the requester: ` +
            `@[${n.actorName}](${n.actorType}:${n.actorUuid})`
          : "";
      return (
        `[Chorus] New instruction from a human${entityHint}:\n\n` +
        `${instruction}\n\n` +
        `Continue this session and act on the instruction above using the appropriate ` +
        `chorus_* tools. Re-check the current state first (e.g. chorus_get_task / ` +
        `chorus_get_idea / chorus_get_comments) if you need context.${actorHint}`
      );
    }
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
  // 子3 — daemon-interrupt-resume: a user-resumed wake re-dispatches through the
  // wake path so the daemon continues the session via `--resume`. Entity-generic
  // (task / idea / proposal / document); arrives via the reverse CONTROL channel as
  // a synthetic dispatch, NOT a persisted notification.
  "resource_resumed",
  // 子1 — daemon-session-conversation: a human-typed instruction for the daemon's
  // session. Arrives as a persisted notification (recipient = the daemon agent)
  // carrying the free-text body in `instructionText`; the event-router threads that
  // body into buildPrompt. NOTE: buildPrompt's human_instruction branch returns null
  // when the body is empty/missing (nothing to act on) — so this action is a wake
  // action only when it actually carries instruction text.
  "human_instruction",
]);
