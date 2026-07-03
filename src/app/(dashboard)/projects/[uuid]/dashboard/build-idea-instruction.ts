// The create-idea instruction template (add-conversational-idea-entry).
//
// This is the REVIEWED CONTRACT between the conversational create-idea entry and
// the woken daemon agent: with pure conversational mode (elaboration q2=a) the
// frontend never creates the Idea entity, so whether an idea materializes rides
// entirely on the agent following this template. Its shape is deliberately
// imperative and enumerated (create → claim+elaborate → report back), and any
// wording change here is a review-visible diff.
//
// The template is English (agent-facing, matching the daemon prompt precedent in
// cli/prompts.mjs); the user's description passes through VERBATIM — whatever
// language it was written in — under the delimiter.
//
// Char budget: this template's overhead is ~500 chars; the entry surface caps
// user text at USER_TEXT_MAX_CHARS (3000) so the composed instruction stays
// safely under the server's MAX_INSTRUCTION_CHARS (4000).

export function buildIdeaInstruction(
  projectUuid: string,
  projectName: string | undefined,
  userText: string,
): string {
  // Name is display sugar; the uuid is the machine anchor and is always present.
  // A missing name degrades to the uuid-only form rather than rendering "".
  const projectLabel = projectName?.trim()
    ? `"${projectName.trim()}" (projectUuid: ${projectUuid})`
    : `projectUuid: ${projectUuid}`;
  return [
    `[Chorus conversational idea entry] The user is describing a NEW IDEA for project ${projectLabel}.`,
    ``,
    `Do the following, in order:`,
    `1. Create the idea in that project via chorus_pm_create_idea — derive a concise title from the description; use the full description as the idea content.`,
    `2. Claim the idea (chorus_claim_idea) and start elaboration following the idea skill.`,
    `3. Report the created ideaUuid and title back in this session so the user can open it.`,
    ``,
    `--- User's idea description ---`,
    userText,
  ].join("\n");
}
