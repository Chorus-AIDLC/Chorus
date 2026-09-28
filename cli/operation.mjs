import { CONVERSATIONAL_IDEA_DESCRIPTION_MAX_CHARS, RESEARCH_INSTRUCTION_PREFIX } from "./operation-contract.mjs";
import { composeConversationalIdeaInstruction, composeResearchInstruction } from "./operation-prompts.mjs";

// Canonical operations are identified by their trigger, never by prompt text.
export const OPERATION_ACTIONS = new Set(["idea_creation_requested", "research_requested"]);

const identity = (value) => typeof value === "string" && value.length > 0 && value.length <= 100;

/** Validate before dedup/admission. Routing authority always comes from the session. */
export function validateOperation(trigger, payload, { sessionId, directIdeaUuid, projectUuid }) {
  const creation = trigger === "idea_creation_requested";
  const fields = creation
    ? ["version", "kind", "ideaUuid", "projectUuid", "mode", "researchFirst", "descriptionText"]
    : ["version", "kind", "ideaUuid"];
  if (!OPERATION_ACTIONS.has(trigger) ||
      !payload || typeof payload !== "object" || Array.isArray(payload) ||
      Object.keys(payload).length !== fields.length ||
      fields.some((field) => !Object.hasOwn(payload, field)) ||
      payload.version !== 1 || payload.kind !== (creation ? "idea_creation" : "research") ||
      !identity(payload.ideaUuid) || payload.ideaUuid !== directIdeaUuid ||
      sessionId !== directIdeaUuid ||
      (creation && (!identity(payload.projectUuid) ||
        (projectUuid !== undefined && payload.projectUuid !== projectUuid) ||
        !["elaborate", "decompose"].includes(payload.mode) ||
        typeof payload.researchFirst !== "boolean" ||
        typeof payload.descriptionText !== "string" || !payload.descriptionText.trim() ||
        payload.descriptionText.length > CONVERSATIONAL_IDEA_DESCRIPTION_MAX_CHARS))) {
    throw new Error("Operation protocol error: invalid payload or session/Idea identity mismatch");
  }
  return payload;
}

export function isExactOperation(n) {
  return OPERATION_ACTIONS.has(n?.action) ||
    (n?.action === "human_instruction" &&
      n.instructionText?.startsWith(RESEARCH_INSTRUCTION_PREFIX));
}

export function buildOperationPrompt(n) {
  const p = validateOperation(n.action, n.operationPayload, {
    sessionId: n.sessionId, directIdeaUuid: n.directIdeaUuid, projectUuid: n.projectUuid,
  });
  return p.kind === "research"
    ? composeResearchInstruction(p.ideaUuid)
    : composeConversationalIdeaInstruction(p);
}
