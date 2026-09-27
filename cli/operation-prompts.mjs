// Shared by the server compatibility snapshot and payload-driven CLI execution.
// Keep historical entry prefixes: older clients use the Research prefix for isolation.
import { RESEARCH_INSTRUCTION_PREFIX } from "./operation-contract.mjs";

const PROJECT_INSTRUCTION_LABEL_MAX_CHARS = 200;

/**
 * Compose the conversational-idea wake instruction (template v2 — the REVIEWED CONTRACT
 * between the conversational create-idea entry and the woken daemon agent, superseding
 * the client-side create→claim template of add-conversational-idea-entry).
 *
 * The idea is PRE-CREATED and already instance-assigned + elaborating, so both templates
 * direct EDIT (never create, never claim — a claim would fail on the existing assignee).
 *  - `elaborate` (default): edit → optional research → elaboration → panel guidance → end turn.
 *  - `decompose`: edit the CONTAINER → keep isContainer → one lightweight scope-clarifying
 *    elaboration → propose candidate CHILDREN as a structured elaboration round (one
 *    single-select question per child, ≤15/round, never a multi-select) → end turn → on the
 *    confirm re-wake create each accepted child via chorus_pm_create_idea with
 *    parentUuid=<container>, children starting `open`, no auto-elaboration; the container's
 *    own status stays `elaborated`. The confirm re-wake rides the EXISTING
 *    `elaboration_answered` wake — no new wake/notification action is introduced.
 *
 * English (agent-facing, matching cli/prompts.mjs precedent); the user's description
 * passes through VERBATIM under the delimiter. Exported for unit tests: the template's
 * wording is code, and any change is a review-visible diff.
 * @param {{ideaUuid: string, projectUuid: string, projectName?: string|null,
 *   descriptionText: string, mode?: 'elaborate'|'decompose', researchFirst?: boolean}} params
 */
export function composeConversationalIdeaInstruction(params) {
  // Name is display sugar; bound this user-controlled metadata independently of
  // the description. The complete UUID remains the authoritative machine anchor.
  const projectName = params.projectName?.trim();
  const displayName = projectName && projectName.length > PROJECT_INSTRUCTION_LABEL_MAX_CHARS
    ? `${projectName.slice(0, PROJECT_INSTRUCTION_LABEL_MAX_CHARS - 1)}…`
    : projectName;
  const projectLabel = displayName
    ? `"${displayName}" (projectUuid: ${params.projectUuid})`
    : `projectUuid: ${params.projectUuid}`;

  const researchInstruction = [
    params.researchFirst
      ? "The user explicitly requested lightweight research before clarification."
      : "Research is optional: use automatic judgment for a concrete, externally verifiable factual gap.",
    "An explicit request to skip research in the user's instructions takes precedence.",
    "Follow the shared research skill before the first formal elaboration: one bounded pass, approximately 2–5 minutes, at most 5 deeply read relevant sources; reuse existing evidence.",
    "Save useful findings in the existing Idea content, preserving the user's meaning, and attach evidence with real ref:UUID citations. Do not create or claim this already-created Idea.",
    "If tools are unavailable, results are empty, or the budget is exhausted, record the limitation and continue the normal steps in this turn. Do not research user preferences; ask through the elaboration panel when needed.",
    "This initialization request applies once, not on every later wake or stage re-entry.",
  ].join(" ");

  if (params.mode === "decompose") {
    return [
      `[Chorus container-decompose entry] A new CONTAINER idea has been PRE-CREATED for project ${projectLabel} from the user's description below, and it is already assigned to you (status: elaborating, isContainer: true).`,
      `  ideaUuid: ${params.ideaUuid}`,
      ``,
      `This conversation IS that container idea's root session. The user wants help DECOMPOSING it into child ideas. Do the following, in order:`,
      `1. Edit the container via chorus_edit_idea: derive a concise title from the description and polish the content (keep the user's meaning). The current title is a placeholder.`,
      `2. Ensure it stays a container: it was pre-created with isContainer=true — do NOT clear that flag (a container groups its child ideas and MUST NOT get a proposal of its own).`,
      `Before step 3: ${researchInstruction}`,
      `3. Run ONE lightweight elaboration round (chorus_pm_start_elaboration) to clarify the decomposition scope/dimension — how to slice the work into children. Keep it short; you may self-answer in headless or ask the user, then continue.`,
      `4. Propose the candidate child ideas AS A STRUCTURED ELABORATION ROUND (chorus_pm_start_elaboration) for the user to review/edit/confirm — use ONE elaboration question PER proposed child (the child's title as the question text, a short rationale as its description), single-select. Elaboration questions are single-select and a round is capped at 15 questions, so propose at most 15 candidates per round and NEVER a single multi-select question; if you need more children, propose them across additional rounds. Do NOT create any child ideas yet — this round is the preview the user accepts/edits/declines per child.`,
      `5. End the turn. The user's answers in the idea's elaboration panel will wake this same conversation (the existing elaboration-answered wake).`,
      `6. On that re-wake, create each ACCEPTED child via chorus_pm_create_idea with parentUuid=${params.ideaUuid}. Each child starts in the "open" state — do NOT auto-elaborate them. The container's OWN status stays "elaborated"; creating children does not advance or alter it.`,
      ``,
      `Reference reflex: whenever an external link is evidence for this work (a precedent issue/PR, a reference implementation, official docs, a paper/blog), attach it via references — prefer the inline references[] param at creation time over a post-hoc chorus_add_reference.`,
      ``,
      `--- User's idea description ---`,
      params.descriptionText,
    ].join("\n");
  }

  return [
    `[Chorus conversational idea entry] A new idea has been PRE-CREATED for project ${projectLabel} from the user's description below, and it is already assigned to you (status: elaborating).`,
    `  ideaUuid: ${params.ideaUuid}`,
    ``,
    `This conversation IS that idea's root session — its elaboration and lifecycle wakes will continue here. Do the following, in order:`,
    `1. Edit the idea via chorus_edit_idea: derive a concise title from the description and polish the content (keep the user's meaning; you may restructure). The current title is a placeholder.`,
    `2. ${researchInstruction}`,
    `3. After that optional step, start elaboration on the idea (chorus_pm_start_elaboration), following the idea skill — do NOT wait for another wake. Post a short summary of your questions in this conversation and direct the user to answer in the idea's elaboration panel.`,
    `4. End the turn. The user's panel answers will wake this same conversation.`,
    ``,
    `Reference reflex: whenever an external link is evidence for this idea (a precedent issue/PR, a reference implementation, official docs, a paper/blog), attach it via references — prefer the inline references[] param at creation time over a post-hoc chorus_add_reference.`,
    ``,
    `--- User's idea description ---`,
    params.descriptionText,
  ].join("\n");
}

/** @param {string} ideaUuid */
export function composeResearchInstruction(ideaUuid) {
  return [
    `${RESEARCH_INSTRUCTION_PREFIX} Explicit, one-time research request for ideaUuid: ${ideaUuid}.`,
    "This is the existing Idea's root conversation. Before research and again before saving, re-read the Idea, ALL related proposals/tasks and execution history including theme descendants. If development has begun, report that the stage changed and STOP without research or edits.",
    "Invoke the shared research skill for ONE bounded pass (approximately 2–5 minutes, at most 5 deeply read sources). Reuse existing evidence. An explicit user instruction to skip research takes precedence. Tools unavailable, empty results, or exhausted budget: record the limitation and stop.",
    "Attach useful sources through existing references and obtain real UUIDs. Read the latest Idea content immediately before saving and MERGE concise findings, source citations using ref:UUID, implications, unknowns, and the stopping reason; preserve user text and existing evidence.",
    "Preserve all elaboration rounds, questions, answers and resolved state. Do not create or claim an Idea, start elaboration, submit or modify a Proposal, change task status, or start development. If findings affect an approved proposal, only record the impact and revision needs in the Idea.",
    "Report the findings and END this turn. This menu invocation does not resume the Idea or Proposal workflow. A later explicit Research request may run another bounded pass.",
  ].join("\n");
}

