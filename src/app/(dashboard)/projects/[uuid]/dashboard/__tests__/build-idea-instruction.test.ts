// buildIdeaInstruction — the create-idea conversational template contract
// (add-conversational-idea-entry). The exact composed output IS the contract
// (the woken agent's behavior rides on it), so the first test pins it verbatim:
// a wording change must show up as a failing diff here, reviewed on purpose.

import { describe, expect, it } from "vitest";
import { buildIdeaInstruction } from "../build-idea-instruction";
import { USER_TEXT_MAX_CHARS } from "@/components/agent-presence/conversational-entry";
import { MAX_INSTRUCTION_CHARS } from "@/components/agent-presence/send-instruction-box";

describe("buildIdeaInstruction", () => {
  it("composes the exact template: project label, three enumerated directives, verbatim user text", () => {
    const out = buildIdeaInstruction(
      "proj-123",
      "Chorus 0.13.1",
      "做一个深色模式\n支持跟随系统",
    );
    expect(out).toBe(
      [
        `[Chorus conversational idea entry] The user is describing a NEW IDEA for project "Chorus 0.13.1" (projectUuid: proj-123).`,
        ``,
        `Do the following, in order:`,
        `1. Create the idea in that project via chorus_pm_create_idea — derive a concise title from the description; use the full description as the idea content.`,
        `2. Claim the idea (chorus_claim_idea) and start elaboration following the idea skill.`,
        `3. Report the created ideaUuid and title back in this session so the user can open it.`,
        ``,
        `--- User's idea description ---`,
        `做一个深色模式\n支持跟随系统`,
      ].join("\n"),
    );
  });

  it("degrades gracefully without a project name (uuid-only label, no empty quotes)", () => {
    const out = buildIdeaInstruction("proj-123", undefined, "hello");
    expect(out).toContain(
      "for project projectUuid: proj-123.",
    );
    expect(out).not.toContain('""');
    // A blank name behaves the same as a missing one.
    expect(buildIdeaInstruction("proj-123", "   ", "hello")).toContain(
      "for project projectUuid: proj-123.",
    );
  });

  it("keeps a max-budget user text within the server instruction cap", () => {
    const out = buildIdeaInstruction(
      // Realistic worst case: full uuid + a long project name.
      "01234567-89ab-cdef-0123-456789abcdef",
      "A quite long project display name for good measure",
      "x".repeat(USER_TEXT_MAX_CHARS),
    );
    expect(out.length).toBeLessThanOrEqual(MAX_INSTRUCTION_CHARS);
  });
});
