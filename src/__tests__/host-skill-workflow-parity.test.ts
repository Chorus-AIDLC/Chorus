import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../..");
const surfaces = [
  { name: "standalone", dir: "public/skill", prefix: "", suffix: "-chorus", specModes: false, reviewer: "public/skill/proposal-reviewer-chorus/SKILL.md" },
  { name: "claude", dir: "public/chorus-plugin/skills", prefix: "", suffix: "", specModes: true, reviewer: "public/chorus-plugin/agents/proposal-reviewer.md" },
  { name: "codex", dir: "plugins/chorus/skills", prefix: "", suffix: "", specModes: true, reviewer: "plugins/chorus/skills/chorus-proposal-reviewer/SKILL.md" },
  { name: "kiro", dir: "public/kiro-plugin/.kiro/skills", prefix: "chorus-", suffix: "", specModes: true, reviewer: "public/kiro-plugin/.kiro/agents/chorus-proposal-reviewer.json" },
  { name: "openclaw", dir: "packages/openclaw-plugin/skills", prefix: "", suffix: "", specModes: true, reviewer: "packages/openclaw-plugin/skills/proposal-reviewer/SKILL.md" },
  { name: "dsh", dir: "packages/chorus-dsh/skills", prefix: "", suffix: "-chorus", specModes: true, reviewer: "packages/chorus-dsh/skills/proposal-reviewer-chorus/SKILL.md" },
  { name: "hermes", dir: "packages/chorus-hermes/chorus/skills", prefix: "", suffix: "", specModes: true, reviewer: "packages/chorus-hermes/chorus/skills/chorus-proposal-reviewer/SKILL.md" },
  { name: "pi", dir: "packages/chorus-pi/skills", prefix: "", suffix: "", specModes: true, reviewer: "packages/chorus-pi/agents/chorus-proposal-reviewer.md" },
] as const;

function readDocument(file: string): string {
  const text = readFileSync(path.join(root, file), "utf8");
  if (!file.endsWith(".json")) return text;
  const parsed = JSON.parse(text) as { prompt: unknown };
  if (typeof parsed.prompt !== "string") throw new Error(`${file}: missing reviewer prompt`);
  return parsed.prompt;
}

function skillPath(surface: typeof surfaces[number], skill: string): string {
  return `${surface.dir}/${surface.prefix}${skill}${surface.suffix}/SKILL.md`;
}

function toolCalls(text: string, tool: string): string[] {
  const blocks = [...text.matchAll(/^\s*```[^\n]*\n([\s\S]*?)^\s*```/gm)];
  return blocks.flatMap((block) => [...block[1].matchAll(new RegExp(`\\b${tool}\\(\\{[\\s\\S]*?\\}\\)`, "g"))].map((call) => call[0]));
}

function normalized(text: string): string {
  return text.replace(/[`*>]/g, "").replace(/\s+/g, " ");
}

const dependencyRules = [
  /E-DEP-UNKNOWN/,
  /E-DEP-SELF/,
  /E-DEP-CYCLE/,
  /chorus_pm_update_task_draft/,
  /chorus_pm_validate_proposal/,
] as const;

const recoveryRules = [
  /premature/i,
  /legitimately (?:submitted|awaiting verification)/i,
  /assignee/i,
  /dependency checks/i,
  /clears.{0,30}developer.{0,20}admin acceptance marks and.{0,20}evidence/i,
  /repeat (?:Step [67]|the developer self-check)/i,
  /chorus_update_task/,
] as const;

const authoringRules = [
  ...dependencyRules,
  /implementation, verification, docs, or other/,
  /omitting kind on update preserves the existing value/i,
  /not copied to materialized Tasks/i,
  /returned by chorus_pm_add_task_draft in this same proposal/,
  /E-DEP-SELF.{0,80}remove.{0,70}dependsOnDraftUuids/i,
  /E-DEP-CYCLE.{0,110}remove or redirect edges/i,
  /Revalidate after repairs and resolve all errors before chorus_pm_submit_proposal/,
  /I-KIND.{0,25}no draft declares a kind/,
  /W-IMPL.{0,100}none is implementation/,
  /Neither advisory blocks submission/,
  /justified docs-only or verification-only proposal is valid/i,
  /never fabricate implementation tasks/i,
] as const;

const reviewerRules = [
  ...dependencyRules,
  /actual dependsOnDraftUuids graph/,
  /every UUID must belong to this proposal, no self edges, no cycles/,
  /are blocking errors/,
  /I-KIND/,
  /W-IMPL/,
  /advisory, not automatic BLOCKERs/,
  /scope requires new implementation and no task covers it, raise a BLOCKER/,
  /Allow justified docs-only or verification-only proposals/,
  /Never fabricate an implementation task/,
  /do not edit drafts as the reviewer/,
] as const;

function missingRules(text: string, rules: readonly RegExp[]): string[] {
  return rules.filter((rule) => !rule.test(normalized(text))).map(String);
}

function reportErrors(text: string): string[] {
  return toolCalls(text, "chorus_report_work").filter((call) => /["']?status["']?\s*:/.test(call));
}

function kindErrors(text: string): string[] {
  return toolCalls(text, "chorus_pm_add_task_draft").filter((call) => !/["']?kind["']?\s*:\s*["'](?:implementation|verification|docs|other)["']/.test(call));
}

describe("host skill workflow parity", () => {
  it("pins all eight hosts and their existing authoring paths", () => {
    expect(new Set(surfaces.map((surface) => surface.name)).size).toBe(8);
    expect(surfaces.flatMap((surface) => surface.specModes ? ["proposal", "yolo", "openspec-aware", "spec-lite"] : ["proposal", "yolo"])).toHaveLength(30);
  });

  for (const surface of surfaces) {
    describe(surface.name, () => {
      for (const skill of ["develop", "quick-dev", "yolo"]) {
        it(`${skill} reports without status and documents safe recovery`, () => {
          const text = readDocument(skillPath(surface, skill));
          expect(toolCalls(text, "chorus_report_work").length).toBeGreaterThan(0);
          expect(reportErrors(text)).toEqual([]);
          expect(missingRules(text, recoveryRules)).toEqual([]);
          expect(text).toContain("in_progress -> to_verify");
          expect(toolCalls(text, "chorus_report_criteria_self_check").length).toBeGreaterThan(0);
          expect(toolCalls(text, "chorus_submit_for_verify").length).toBeGreaterThan(0);
        });
      }

      const authoringSkills = surface.specModes ? ["proposal", "yolo", "openspec-aware", "spec-lite"] : ["proposal", "yolo"];
      for (const skill of authoringSkills) {
        it(`${skill} has classified drafts and actionable validation`, () => {
          const text = readDocument(skillPath(surface, skill));
          const calls = toolCalls(text, "chorus_pm_add_task_draft");
          expect(calls.length).toBeGreaterThan(0);
          expect(kindErrors(text)).toEqual([]);
          expect(calls.some((call) => /acceptanceCriteriaItems:\s*\[\s*\{\s*description:/.test(call))).toBe(true);
          expect(missingRules(text, authoringRules)).toEqual([]);
          expect(toolCalls(text, "chorus_pm_update_task_draft").some((call) => call.includes("dependsOnDraftUuids") && !/\bkind\s*:/.test(call))).toBe(true);
        });
      }

      it("proposal reviewer checks actual coverage and allows justified exceptions", () => {
        expect(missingRules(readDocument(surface.reviewer), reviewerRules)).toEqual([]);
      });

      it("detects reintroduced report status in this host", () => {
        const text = readDocument(skillPath(surface, "develop"));
        const regressed = text.replace("chorus_report_work({", 'chorus_report_work({ status: "to_verify",');
        expect(reportErrors(regressed)).toHaveLength(1);
      });

      it("detects missing task kinds even with unrelated reviewer-kind text", () => {
        const text = readDocument(skillPath(surface, "yolo"));
        const regressed = text.replace(/\bkind:\s*"(?:implementation|verification|docs|other)",?/g, "") + '\nReviewer kind = proposal | task | code';
        expect(kindErrors(regressed).length).toBeGreaterThan(0);
      });

      it("detects removed recovery evidence and reviewer exception guidance", () => {
        const develop = readDocument(skillPath(surface, "develop"));
        expect(missingRules(develop.replaceAll("evidence", "details"), recoveryRules).length).toBeGreaterThan(0);
        const reviewer = readDocument(surface.reviewer);
        expect(missingRules(reviewer.replaceAll("Allow justified docs-only or verification-only proposals", "Reject non-implementation proposals"), reviewerRules).length).toBeGreaterThan(0);
        expect(missingRules(reviewer.replaceAll("E-DEP-CYCLE", "dependency warning"), reviewerRules).length).toBeGreaterThan(0);
      });
    });
  }

  it("ignores explanatory warnings and legitimate review-list status filters", () => {
    const text = 'Do not call `chorus_report_work({ status: "to_verify" })` before submitting.\n\n```js\nchorus_list_tasks({ status: "to_verify" })\nchorus_report_work({ report: "Done", taskUuid: "task" })\n```';
    expect(toolCalls(text, "chorus_report_work")).toHaveLength(1);
    expect(reportErrors(text)).toEqual([]);
  });

  it.each([
    'chorus_report_work({ taskUuid: "task", status: "to_verify" })',
    "chorus_report_work({\n  taskUuid: 'task',\n  status: 'to_verify'\n})",
    'chorus_report_work({ "status": "to_verify", "taskUuid": "task" })',
  ])("detects single-line, multiline and quoted status keys: %s", (call) => {
    expect(reportErrors(`\`\`\`\n${call}\n\`\`\``)).toHaveLength(1);
  });

  it("rejects an invalid kind and a kind mention outside the add payload", () => {
    expect(kindErrors('```\nchorus_pm_add_task_draft({ kind: "build" })\n```')).toHaveLength(1);
    expect(kindErrors('kind: "implementation"\n```\nchorus_pm_add_task_draft({ title: "Missing classification" })\n```')).toHaveLength(1);
  });
});
