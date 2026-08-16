// cli/prompts.mjs
// Per-notification-action prompt builders. Ported from the OpenClaw plugin's
// event-router wake messages. The spawned Claude is headless and acts only
// through the chorus_* MCP tools — these prompts tell it what happened and
// which tools to use.
//
// HEADLESS GUARD (add-daemon-headless-interaction-guard): a daemon-woken session
// has NO human at the terminal, so it must never call AskUserQuestion or any
// blocking terminal prompt — that would hang or be silently dropped. buildPrompt
// prepends HEADLESS_PREAMBLE (below) to EVERY non-null wake body so the rule rides
// every turn, new or --resume (the daemon rebuilds the prompt on each wake, so a
// per-turn prefix persists across resumes without touching the spawn argv — there
// is deliberately no --append-system-prompt; see claude-spawner.mjs). The preamble
// also names the CHORUS_DAEMON_HEADLESS=1 env signal the spawner sets.

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
 * @property {{type: string, uuid: string, name: string} | null} [orchestrator]
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
 * Orchestrator-handoff guidance, appended to every wake body by buildPrompt. This is
 * the SINGLE home of the "hand back to the agent that dispatched you" instruction —
 * it is runtime PE (it depends on who the wake resolved as orchestrator), so it lives
 * here in the wake prompt, NOT in the static skill docs. Its OpenClaw twin is
 * `buildOrchestratorGuidance` in packages/openclaw-plugin/src/event-router.ts —
 * KEEP THE TWO WORDINGS IN SYNC.
 * Returns null unless the resource has an AGENT orchestrator; a human-assigned
 * resource hands back to the human via the per-event actor @mention (mentionGuidance).
 * @param {NotificationDetail} n
 */
function orchestratorGuidance(n) {
  if (n.orchestrator?.type !== "agent") return null;
  return (
    `Your orchestrator for this resource is @${n.orchestrator.name}.\n` +
    `At a human-only gate you cannot cross, or when this child resource is complete, hand control ` +
    `back by commenting on the resource and mentioning ` +
    `@[${n.orchestrator.name}](agent:${n.orchestrator.uuid}) with the decision needed or completion ` +
    `evidence, then leave any human-gated resource pending and end the turn. Do not @mention the ` +
    `orchestrator for ordinary internal progress.`
  );
}

/**
 * Shared headless preamble prepended to EVERY wake prompt (add-daemon-headless-
 * interaction-guard). A daemon-woken session is a headless `claude -p` run with no
 * human at the terminal, so AskUserQuestion (and any blocking terminal prompt) reaches
 * no one — it hangs or is dropped, stalling the agent or forcing a unilateral decision.
 * This block tells the agent that fact and routes every human-decision point through
 * Chorus's async channels instead.
 *
 * Wording note: the re-routing guidance names `chorus_add_comment` and describes the
 * elaboration panel in prose ON PURPOSE — it must NOT embed the literal
 * `chorus_pm_start_elaboration` / `chorus_pm_validate_elaboration` tool names, because
 * this preamble rides EVERY wake including `elaboration_verified` (write-the-proposal),
 * whose contract is that it never mentions the answer-questions tools. Keep it that way.
 * The reference-attachment nudge (strengthen-reference-association) names `references[]` /
 * `chorus_add_reference` only — never the elaboration tools — so it is safe on every wake.
 *
 * Kept compact: it is paid on every wake, so each line costs tokens per wake.
 */
export const HEADLESS_PREAMBLE = [
  "[Headless daemon session] You are a headless `claude -p` session woken by the Chorus",
  "daemon. There is NO human at the terminal, and the environment variable",
  "CHORUS_DAEMON_HEADLESS=1 is set.",
  "",
  "Do NOT call AskUserQuestion or any interactive / blocking terminal prompt — it reaches",
  "no one and will hang or be silently dropped. Whenever you would ask the human something,",
  "route it through Chorus instead: post a comment with chorus_add_comment and @mention the",
  "requester, and/or open an elaboration round the human answers in the Chorus UI panel.",
  "",
  "A few examples (not exhaustive): when a skill says to present elaboration questions via",
  "AskUserQuestion, open an elaboration round and @mention the requester in a comment so they",
  "answer in the UI; when a skill says to ask permission before skipping a step, do not skip",
  "silently — record the reason in a Chorus comment; when a skill offers to write a report,",
  "create it directly or skip it, never prompt for it.",
  "",
  "When working an idea/proposal/task, if you come across an external link that is evidence",
  "(a precedent issue/PR, a reference implementation, official docs, a paper/blog), attach it",
  "via references — prefer the inline references[] param at creation time over a post-hoc",
  "chorus_add_reference. Make it a reflex, not an afterthought.",
  "",
  "After you post something that needs a human decision, END THE TURN and leave the work",
  "pending — do not poll or wait for a synchronous reply. The human's later comment or",
  "elaboration answer wakes a fresh turn that continues the work.",
].join("\n");

/**
 * Build the wake prompt for a notification, or null if the action has no
 * wake (caller ignores those). Prepends HEADLESS_PREAMBLE to every non-null body
 * (a null body — unknown action / empty human_instruction — stays null so the router
 * still skips it and no contentless subprocess is spawned). The per-action body is
 * produced by buildPromptBody below.
 * @param {NotificationDetail} n
 * @returns {string | null}
 */
export function buildPrompt(n) {
  const body = buildPromptBody(n);
  if (body == null) return null;
  const handoff = orchestratorGuidance(n);
  return `${HEADLESS_PREAMBLE}\n\n${body}${handoff ? `\n\n${handoff}` : ""}`;
}

/**
 * Build ONE combined wake prompt for a coalesced batch of same-session notifications
 * (add-daemon-wake-coalescing, tech design §C2). The daemon serializes wakes per session
 * key; while a turn runs, later same-key wakes pile up and — when the slot frees — are
 * drained together into a single `claude --resume` turn. This composes their one prompt.
 *
 * Rules:
 *  - **Size 1** → delegate to `buildPrompt(n)` verbatim, so the single-event path is
 *    BYTE-IDENTICAL to today (and all current prompt tests keep passing). This is keyed on
 *    the count of RENDERABLE events (non-null body): a batch that reduces to a single
 *    renderable event — e.g. a real wake plus an empty `human_instruction` — also takes
 *    the single-event path.
 *  - **Size > 1 renderable** → `HEADLESS_PREAMBLE` ONCE (it is a per-turn guard, paid once
 *    per turn, not per event), then a short backlog preamble, then one labeled block per
 *    event in ARRIVAL order, each block being the reused per-action `buildPromptBody(n)` so
 *    every event keeps its own tool hints and @mention guidance.
 *  - **Same-entity collapse (Q2)**: events sharing `(action, entityUuid)` collapse into one
 *    block at the group's FIRST-SEEN position, noting the occurrence count and showing the
 *    NEWEST message. This is safe only because such actions' full content is re-derivable
 *    server-side (comments via chorus_get_comments, task lifecycle via chorus_get_*).
 *  - **`human_instruction` is NEVER collapsed (Q3, Round-1 BLOCKER-2)**: every queued chat
 *    message carries `action=human_instruction` and `entityUuid=directIdeaUuid`, and its
 *    text lives ONLY on the turn/notification (not re-fetchable), so collapsing to
 *    newest-only would silently drop earlier chat and defeat the feature. Each renders its
 *    full body as its own block, in arrival order.
 *  - Events whose body is null (empty `human_instruction`, non-wake action) are omitted; a
 *    batch with no renderable event returns null (the router then spawns nothing).
 *
 * @param {NotificationDetail[]} notifications  Arrival-ordered batch (FIFO drain order).
 * @returns {string | null}
 */
export function buildBatchPrompt(notifications) {
  if (!Array.isArray(notifications) || notifications.length === 0) return null;

  // Keep only events with a renderable per-action body, in arrival order.
  const items = [];
  for (const n of notifications) {
    const body = buildPromptBody(n);
    if (body != null) items.push({ n, body });
  }
  if (items.length === 0) return null;
  // One renderable event → byte-identical single-event prompt (delegates to buildPrompt so
  // the exact "PREAMBLE\n\nbody" shape is preserved). Covers a true batch of size 1 and a
  // batch that reduced to one renderable event after null-body events were dropped.
  if (items.length === 1) return buildPrompt(items[0].n);

  // Group into ordered blocks. Collapsible actions merge by (action, entityUuid) at their
  // first-seen slot; human_instruction is exempt and always gets its own block.
  const blocks = [];
  const collapseIndex = new Map(); // "action::entityUuid" -> index into `blocks`
  for (const { n, body } of items) {
    if (n.action === "human_instruction") {
      blocks.push({ notif: n, body, count: 1 });
      continue;
    }
    const groupKey = `${n.action}::${n.entityUuid ?? ""}`;
    const existing = collapseIndex.get(groupKey);
    if (existing != null) {
      const g = blocks[existing];
      g.count += 1;
      g.notif = n; // newest wins (arrival order → last member is newest)
      g.body = body; // newest body
    } else {
      collapseIndex.set(groupKey, blocks.length);
      blocks.push({ notif: n, body, count: 1 });
    }
  }

  // Backlog preamble. N = number of renderable events that arrived (not the collapsed block
  // count) — collapse is a rendering optimization; each collapsed block states its own count.
  const backlogPreamble =
    `You have ${items.length} queued Chorus events on this session that arrived while you ` +
    `were busy — handle them together, in order; each is labeled with its type below.`;

  const rendered = blocks.map((g, idx) => {
    const n = g.notif;
    const entityType = n.entityType || "session";
    const entityUuid = n.entityUuid || "";
    const header = `### Event ${idx + 1} — ${n.action} on ${entityType} ${entityUuid}`.replace(/\s+$/, "");
    const collapseNote =
      g.count > 1
        ? `\n(${g.count} ${n.action} events on this ${entityType} arrived — showing the newest ` +
          `below; earlier ones are re-derivable via the entity's own chorus_get_* tools.)`
        : "";
    return `${header}${collapseNote}\n\n${g.body}`;
  });

  return [HEADLESS_PREAMBLE, backlogPreamble, ...rendered].join("\n\n");
}

/**
 * The per-action wake body (without the headless preamble). Mirrors the OpenClaw
 * event-router handlers; returns null for actions that have no wake.
 * @param {NotificationDetail} n
 * @returns {string | null}
 */
function buildPromptBody(n) {
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
    case "elaboration_verified":
      // A human clicked "Verify Elaborate" (add-elaboration-verify-wake). This is NOT a
      // request to answer questions — the elaboration is DONE and the idea is now
      // `elaborated`. The agent's job on this wake is to WRITE THE PROPOSAL via the
      // existing proposal flow, anchored to the idea's same session that ran elaboration.
      return (
        `[Chorus] Elaboration for idea '${n.entityTitle}' was VERIFIED by a human ` +
        `(ideaUuid: ${n.entityUuid}, projectUuid: ${n.projectUuid}). The idea is now elaborated — do NOT ` +
        `answer elaboration questions. Proceed to WRITE THE PROPOSAL: gather context with chorus_get_idea and ` +
        `chorus_get_elaboration, then author the proposal via the existing proposal flow ` +
        `(chorus_pm_create_proposal / the proposal skill).\n${mentionGuidance(n, "idea")}`
      );
    case "start_development":
      // A human clicked "Start Development" (add-stage-advance-start-development). The
      // idea's proposal is approved and unfinished tasks remain. The agent's job on this
      // wake is the WHOLE remaining execute stage — loop over every claimable task until
      // none remain (elaboration decision Q1), never stopping after a single task.
      return (
        `[Chorus] A human started DEVELOPMENT for idea '${n.entityTitle}' ` +
        `(ideaUuid: ${n.entityUuid}, projectUuid: ${n.projectUuid}). The idea's proposal is approved and ` +
        `unfinished tasks remain. Claim and execute ALL remaining tasks of that proposal in dependency ` +
        `order, following the develop workflow: repeatedly find claimable tasks (chorus_get_unblocked_tasks ` +
        `with projectUuid: "${n.projectUuid}"), claim one (chorus_claim_task), implement it, self-check its ` +
        `acceptance criteria (chorus_report_criteria_self_check), and submit it (chorus_submit_for_verify) — ` +
        `then loop until NO claimable task remains. Do NOT stop after one task. Leave tasks already in ` +
        `to_verify (awaiting human verification) and tasks claimed by other sessions untouched. If nothing ` +
        `is claimable, post a brief status comment on the idea and end the turn.\n${mentionGuidance(n, "idea")}`
      );
    case "yolo_requested":
      // A human clicked "Yolo" (add-stage-advance-yolo). Unlike start_development
      // (always the execute stage), this wake can land at ANY incomplete stage, so the
      // prompt must NOT hard-code a stage — it points the agent at the yolo skill and lets
      // it self-select the entry phase from the idea's current state (no proposal yet →
      // elaborate + write proposal; approved proposal with open tasks → execute; etc.).
      // Honors the "yolo never merges" rule: drive through done + completion report, but
      // never merge or push a PR without explicit human approval.
      return (
        `[Chorus] A human requested a YOLO run for idea '${n.entityTitle}' ` +
        `(ideaUuid: ${n.entityUuid}, projectUuid: ${n.projectUuid}). Drive this idea all the ` +
        `way to done following the yolo skill (the full-auto AI-DLC pipeline: Idea → ` +
        `Elaboration → Proposal → Execute → Verify). First read the idea's current state with ` +
        `chorus_get_idea (plus chorus_get_elaboration / chorus_get_proposals as needed) and ` +
        `RESUME from whatever phase it is already in — do NOT assume a fixed stage: if ` +
        `elaboration isn't resolved, self-elaborate then write the proposal; if a proposal is ` +
        `approved with open tasks, execute them; and so on. Complete the pipeline through the ` +
        `final done state and completion report, but do NOT merge or push a pull request ` +
        `without explicit human approval.\n${mentionGuidance(n, "idea")}`
      );
    case "proposal_rejected":
      return (
        `[Chorus] Proposal '${n.entityTitle}' was REJECTED (proposalUuid: ${n.entityUuid}, ` +
        `projectUuid: ${n.projectUuid}). Review note: "${n.message}". Use chorus_get_proposal to review, ` +
        `fix issues with chorus_pm_update_task_draft / chorus_pm_update_document_draft, then ` +
        `chorus_pm_validate_proposal and chorus_pm_submit_proposal to resubmit.\n${mentionGuidance(n, "proposal")}`
      );
    case "proposal_approved": {
      // Surface the approver's note inline, symmetric with proposal_rejected — so the
      // daemon knows the reviewer's opinion without a follow-up chorus_get_proposal
      // fetch. The server bakes the note into n.message as "... approved. Note: <note>"
      // (buildMessage in notification-listener.ts); an approve WITHOUT a note has no
      // "Note: " marker, so reviewInfo stays empty and the prompt reads cleanly. This
      // mirrors the OpenClaw plugin's proposal_approved handler (event-router.ts).
      const reviewInfo = n.message?.includes("Note: ")
        ? ` Review note: "${n.message.split("Note: ").pop()}".`
        : "";
      return (
        `[Chorus] Proposal '${n.entityTitle}' was APPROVED (proposalUuid: ${n.entityUuid}, ` +
        `projectUuid: ${n.projectUuid}).${reviewInfo} Its documents and tasks have been created. Use ` +
        `chorus_get_unblocked_tasks (projectUuid: "${n.projectUuid}") to find tasks ready to start.\n${mentionGuidance(n, "proposal")}`
      );
    }
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
      //
      // `resumedFrom` (add-crash-execution-resume) distinguishes the resume kind:
      // "crash" gets an explicit exited-abnormally instruction — the previous run may
      // have died mid-edit, so the agent must verify state before continuing.
      // "user" / absent / unknown (older server) keeps the original text unchanged.
      if (n.resumedFrom === "crash") {
        return (
          `[Chorus] The previous run on this ${n.entityType} EXITED ABNORMALLY (crashed) ` +
          `(${n.entityType}Uuid: ${n.entityUuid}), and a user asked to resume it. The crash may ` +
          `have left work half-finished — first re-check the current state with the appropriate ` +
          `chorus_get_* tool (e.g. chorus_get_task / chorus_get_idea) plus chorus_get_comments, ` +
          `and inspect any partial local work (working tree, uncommitted changes, half-written ` +
          `files). Then continue the unfinished work from where the crashed run left off.`
        );
      }
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
  // add-elaboration-verify-wake: a human clicked "Verify Elaborate" — the elaboration is
  // resolved and the idea is `elaborated`. This wakes the assigned daemon PM agent to WRITE
  // THE PROPOSAL (distinct from elaboration_requested/answered, which mean "answer
  // questions"). Arrives as a persisted notification (recipient = the idea's assigned agent),
  // idea-rooted like the other elaboration wakes, so the session anchor/resume contract is
  // unchanged. See buildPrompt's `elaboration_verified` case for the write-proposal prompt.
  "elaboration_verified",
  // add-stage-advance-start-development: a human clicked "Start Development" — the idea's
  // proposal is approved and unfinished tasks remain. Wakes the assigned daemon agent to
  // CLAIM AND EXECUTE ALL remaining tasks (dedicated trigger, session-origin-pinned like
  // elaboration_verified). See buildPrompt's `start_development` case.
  "start_development",
  // add-stage-advance-yolo: a human clicked "Yolo" — wakes the assigned daemon agent to
  // drive the WHOLE idea to done via the yolo skill (dedicated trigger, session-origin-
  // pinned like start_development). Unlike start_development it is stage-adaptive — see
  // buildPrompt's `yolo_requested` case.
  "yolo_requested",
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
