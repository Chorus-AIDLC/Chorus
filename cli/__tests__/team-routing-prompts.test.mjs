import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildPrompt, buildBatchPrompt, TEAM_ROUTING_GUIDANCE, WAKE_ACTIONS } from "../prompts.mjs";
import { TEAM_ROUTING_GUIDANCE as OPENCLAW_GUIDANCE, buildTeamLeadHandoff } from "../../packages/openclaw-plugin/src/team-routing-guidance.ts";

const notification = (action, entityType = "idea") => ({
  action, entityType, entityUuid: "idea-1", projectUuid: "project-1",
  entityTitle: "Managed work", message: "Continue", instructionText: "Continue",
  sessionId: "idea-1", directIdeaUuid: "idea-1",
  operationPayload: action === "idea_creation_requested"
    ? { version: 1, kind: "idea_creation", ideaUuid: "idea-1", projectUuid: "project-1", mode: "elaborate", researchFirst: false, descriptionText: "Managed work" }
    : { version: 1, kind: "research", ideaUuid: "idea-1" },
});

describe("authoritative Team wake guidance", () => {
  it.each(["proposal_submitted", "task_submitted_for_verify", "task_status_changed", "report_created"])(
    "wakes only the dedicated lead handoff, not generic %s", (sourceAction) => {
      expect(WAKE_ACTIONS.has(sourceAction)).toBe(false);
      expect(buildPrompt(notification(sourceAction))).toBeNull();
      const handoff = { ...notification("team_lead_handoff", "proposal"), uuid: "notification-1", message: sourceAction };
      const prompt = buildPrompt(handoff);
      expect(prompt).toContain(buildTeamLeadHandoff(handoff));
      expect(prompt).toContain("Only the current active eligible enrolled lead");
      expect(prompt).toContain("must not wake a reviewer agent");
      expect(prompt).not.toContain("then chorus_claim_task to start work");
      expect(buildBatchPrompt([handoff, notification(sourceAction)])).toBe(prompt);
    },
  );

  it("resumed sessions re-check the coordination phase without takeover", () => {
    expect(buildPrompt(notification("resource_resumed", "task"))).toContain("A resumed Team lead handoff must re-read the original entity");
  });

  it.each([...WAKE_ACTIONS])("guards %s before the legacy action", (action) => {
    const prompt = buildPrompt(notification(action));
    expect(prompt).toContain(TEAM_ROUTING_GUIDANCE);
    expect(prompt.slice(prompt.indexOf(TEAM_ROUTING_GUIDANCE) + TEAM_ROUTING_GUIDANCE.length).trim()).not.toBe("");
  });

  it("guards a mixed batch once and keeps single/empty behavior", () => {
    const events = [notification("task_reopened", "task"), notification("proposal_approved", "proposal")];
    const batch = buildBatchPrompt(events);
    expect(batch.split(TEAM_ROUTING_GUIDANCE)).toHaveLength(2);
    expect(batch.indexOf(TEAM_ROUTING_GUIDANCE)).toBeLessThan(batch.indexOf("### Event 1"));
    expect(batch).toContain("every linked input Idea");
    expect(buildBatchPrompt([events[0]])).toBe(buildPrompt(events[0]));
    expect(buildBatchPrompt([notification("comment_added")])).toBeNull();
    expect(buildPrompt(notification("comment_added"))).toBeNull();
  });

  it("keeps CLI and OpenClaw contracts identical", () => {
    expect(OPENCLAW_GUIDANCE).toBe(TEAM_ROUTING_GUIDANCE);
    for (const clause of [
      "chorus_get_idea_team_context({ideaUuid})", 'role:"product"', 'role:"development",taskUuid',
      "chorus_delegate_team_product({ideaUuid,agentUuid})", "unassigned Idea stays unassigned",
      "current lead remains the Idea owner", "must not claim, release or reassign",
      "Empty/all-ineligible roles mean manual", "eligible online lead", "lead_decision",
      "paused, stop all automated Team actions", "Non-YOLO proposal approval is human-only",
      "Task verification belongs to the current active lead", "unmanaged work preserve legacy flows",
      "Missing or ambiguous ancestry/context for Idea-backed work is a stop", "No independent Reviewer auto-wake",
    ]) expect(TEAM_ROUTING_GUIDANCE).toContain(clause);
    expect(WAKE_ACTIONS.has("task_submitted_for_verify")).toBe(false);
  });
});

const surfaces = [
  ["public/chorus-plugin/skills", "bare"], ["plugins/chorus/skills", "bare"],
  ["packages/openclaw-plugin/skills", "bare"], ["public/kiro-plugin/.kiro/skills", "prefix"],
  ["packages/chorus-pi/skills", "bare"], ["packages/chorus-dsh/skills", "suffix"],
  ["packages/chorus-hermes/chorus/skills", "bare"], ["public/skill", "suffix"],
];
const stages = ["chorus", "idea", "proposal", "develop", "orchestrate", "review", "yolo", "quick-dev"];
const root = new URL("../../", import.meta.url);
const routingSection = (text) => text.split("## Authoritative Idea Team Routing\n")[1]?.split("\n## ")[0].trim();
const canonical = routingSection(readFileSync(new URL("public/chorus-plugin/skills/chorus/SKILL.md", root), "utf8"));

describe("maintained skill Team routing parity", () => {
  for (const [surface, naming] of surfaces) {
    it.each(stages)(`${surface}: %s`, (stage) => {
      const name = stage === "chorus" ? stage : naming === "prefix" ? `chorus-${stage}` : naming === "suffix" ? `${stage}-chorus` : stage;
      const file = naming === "prefix" && stage === "chorus" ? "public/kiro-plugin/.kiro/steering/chorus.md" : `${surface}/${name}/SKILL.md`;
      const text = readFileSync(new URL(file, root), "utf8");
      expect(canonical).toBeTruthy();
      expect(routingSection(text)?.replaceAll("chorus__chorus_", "chorus_")).toBe(canonical);
      if (surface.includes("openclaw")) expect(routingSection(text)).toContain("chorus__chorus_get_idea_team_context");
    });
  }
});
