import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");
const surfaces = [
  { dir: "public/chorus-plugin/skills", suffix: "", reviewer: (kind: string) => `public/chorus-plugin/agents/${kind}-reviewer.md` },
  { dir: "public/skill", suffix: "-chorus", reviewer: (kind: string) => `public/skill/${kind}-reviewer-chorus/SKILL.md` },
];

function protocol(text: string): string {
  return text.split("## Team review routing\n")[1]?.split("## Independent review")[0] ?? "";
}

const routingRules = [
  'role: "review", proposalUuid',
  'role: "review", taskUuid',
  'role: "review"}',
  "review_orchestrator_subagent_fallback",
  "rereview_affinity",
  "lead_decision",
  "same turn",
  "end the turn",
  "never start a line with `VERDICT:`",
  "all tasks across every proposal",
  "in parallel with task reviews",
  "avoid a duplicate whole-Idea review",
  "current-round PASS / PASS WITH NOTES",
  "one comment @mentioning the human owner to request approval",
  "does **not** approve",
  "chorus_create_tasks",
  "current approved proposal",
  "stable finding IDs",
  "3 rounds per entity",
  "stop automation",
  "No acknowledgement mentions",
  "call `chorus_request_review({ targetType, targetUuid, reviewerUuid, round })` once",
  "`targetType` is `proposal`, `task` or `idea` (the whole-Idea code review)",
  "posts the `Team review request — <kind>, round N` comment",
  "exactly one reviewer @mention",
  "wakes only that reviewer in its review session",
  "a plain comment never opens a review session",
];

const receiverRules = [
  "MUST load the current matching proposal/task/code reviewer instructions",
  "even when reviewing directly in your own session",
  "not only when delegated to a separate reviewer",
  "If kind, round, target UUID, protocol location or expected PASS/FAIL recipients are absent",
  "fetch the full request and current entity/Team context",
  "recover only unambiguous values",
  "ask the current orchestrator for a corrected request",
  "Do not guess or emit a verdict until",
  "exactly one plain unformatted line starting at column 1",
  "`VERDICT: PASS`, `VERDICT: PASS WITH NOTES`, or `VERDICT: FAIL`",
  "No bold, backticks, bullets, quotes, fences or extra verdict line",
  "exactly one actionable routed @mention",
  "re-read current entity/Team context before posting",
  "Remain read-only; no lifecycle writes",
];

function missing(text: string): string[] {
  return [...routingRules, ...receiverRules].filter((rule) => !text.includes(rule));
}

describe("Claude Code and standalone Team review documentation", () => {
  for (const surface of surfaces) {
    const skill = (name: string) => `${surface.dir}/${name === "chorus" ? name : name + surface.suffix}/SKILL.md`;

    it(`${surface.dir} documents the complete routing protocol`, () => {
      const text = protocol(read(skill("orchestrate")));
      expect(missing(text)).toEqual([]);
      expect(text).toContain("| Proposal | Current Idea orchestrator | Product delegate (`productAgentUuid`), else orchestrator |");
      expect(text).toContain("| Task | Current Idea orchestrator (to verify) | Task developer (logical assignee, not instance UUID) |");
      expect(text).toContain("| Whole Idea | Current Idea orchestrator | Current Idea orchestrator |");
      expect(text).toContain("not individual task verification");
      expect(text).toContain("paused");
      const links = [...text.matchAll(/\[(proposal|task|code) reviewer protocol\]\(([^)]+)\)/g)];
      expect(links.map((link) => link[1])).toEqual(["proposal", "task", "code"]);
      for (const link of links) {
        const resolved = path.resolve(root, path.dirname(skill("orchestrate")), link[2]);
        expect(resolved).toBe(path.resolve(root, surface.reviewer(link[1])));
        expect(existsSync(resolved)).toBe(true);
      }
    });

    for (const name of ["review", "yolo", "chorus"]) {
      it(`${surface.dir}/${name} references the managed protocol`, () => {
        expect(read(skill(name))).toContain(`../orchestrate${surface.suffix}/SKILL.md#team-review-routing`);
        expect(read(skill(name))).toContain('role: "review"');
        for (const rule of receiverRules) expect(read(skill(name)), rule).toContain(rule);
        expect(read(skill(name))).toContain("send them with `chorus_request_review` (target, reviewer, round)");
        expect(read(skill(name))).toContain("A request must never start a line with `VERDICT:`");
      });
    }

    for (const kind of ["proposal", "task", "code"]) {
      it(`${surface.dir}/${kind} reviewer stays read-only and routes one verdict`, () => {
        const text = read(surface.reviewer(kind)).split("## Team reviewer\n")[1]?.split("REVIEW PROCEDURE")[0].split("## Review Procedure")[0] ?? "";
        expect(text).toContain("exactly one VERDICT comment per round");
        expect(text).toContain("exactly one @mention of only the routed target");
        expect(text).toContain("never reject, reopen, approve, verify or create tasks");
        expect(text).toContain("3 rounds per entity");
        expect(text).toContain("chorus_get_idea_team_context");
        for (const rule of receiverRules) expect(text, rule).toContain(rule);
      });
    }
  }

  it("preserves protocol parity apart from host-specific self-review mechanics", () => {
    const normalize = (text: string) => text
      .replace(/run the matching .*? as a fresh read-only sub-agent/, "run the matching reviewer as a fresh read-only sub-agent")
      .replace(/(\[(?:proposal|task|code) reviewer protocol\])\([^)]+\)/g, "$1(HOST_PATH)")
      .replace(/ If the harness has no sub-agent primitive,.*?routed VERDICT\./, "");
    expect(normalize(protocol(read("public/skill/orchestrate-chorus/SKILL.md"))))
      .toBe(normalize(protocol(read("public/chorus-plugin/skills/orchestrate/SKILL.md"))));
  });

  it("detects missing routing and approval rules", () => {
    const text = protocol(read("public/chorus-plugin/skills/orchestrate/SKILL.md"));
    for (const rule of [...routingRules, ...receiverRules]) expect(missing(text.replaceAll(rule, "removed"))).toContain(rule);
  });

  it("aligns every Claude skill version with both manifests", () => {
    const manifest = JSON.parse(read("public/chorus-plugin/.claude-plugin/plugin.json"));
    const marketplace = JSON.parse(read(".claude-plugin/marketplace.json"));
    expect(marketplace.plugins.find((plugin: { name: string }) => plugin.name === "chorus").version).toBe(manifest.version);
    const dir = "public/chorus-plugin/skills";
    for (const name of readdirSync(path.join(root, dir))) {
      expect(read(`${dir}/${name}/SKILL.md`)).toContain(`  version: "${manifest.version}"`);
    }
  });

  it("documents review target validation and exact server reasons", () => {
    const text = read("docs/MCP_TOOLS.md").split("#### chorus_recommend_team_agent\n")[1]?.split("#### chorus_delegate_team_product")[0] ?? "";
    for (const rule of ["proposalUuid", "taskUuid", "neither", "400", "403", "review_orchestrator_subagent_fallback", "rereview_affinity", "minimum_load", "equal_candidates", "agent-authored", "mid-line"]) {
      expect(text).toContain(rule);
    }
  });
});
