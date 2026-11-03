import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");
const heading = "## Session scope for CLI daemon wakes";
const surfaces = [
  { name: "Standalone", dir: "public/skill", prefix: "", suffix: "-chorus" },
  { name: "Claude Code", dir: "public/chorus-plugin/skills", prefix: "", suffix: "" },
  { name: "Codex/TRAE", dir: "plugins/chorus/skills", prefix: "", suffix: "" },
  { name: "OpenClaw", dir: "packages/openclaw-plugin/skills", prefix: "", suffix: "" },
  { name: "Kiro", dir: "public/kiro-plugin/.kiro/skills", prefix: "chorus-", suffix: "",
    overview: "public/kiro-plugin/.kiro/steering/chorus.md" },
  { name: "Pi", dir: "packages/chorus-pi/skills", prefix: "", suffix: "" },
  { name: "dsh", dir: "packages/chorus-dsh/skills", prefix: "", suffix: "-chorus" },
  { name: "Hermes", dir: "packages/chorus-hermes/chorus/skills", prefix: "", suffix: "" },
];

function sessionScope(text: string): string {
  return text.split(`${heading}\n`)[1]?.split(/^## /m)[0] ?? "";
}

const rules = [
  "only to wakes handled by an updated Chorus CLI daemon",
  "server-delivered SSE `sessionId`",
  "do not upgrade OpenClaw, Hermes, or dsh-native session routing",
  "native runtimes retain their existing behavior",
  "Older daemons may fall back to legacy entity/Idea routing",
  "do not assume task/review isolation there",
  "`task:<uuid>` is a task-scoped session with no Idea-session memory",
  "Fetch the current task, its proposal and documents, and its direct Idea from Chorus before starting work",
  "do not rely on the orchestrator's conversation",
  "Sibling tasks of the same Idea can run concurrently for one agent",
  "may share the working directory",
  "Before editing when siblings share the cwd, work in your own git worktree",
  "the daemon does not create one for you",
  "a Team review request uses `review:<type>:<uuid>`",
  "type is `proposal`, `task`, or `idea` (a code review targets the Idea)",
  "read-only review-scoped session with no development-session memory",
  "Fetch the target and current reviewer protocol/context before reviewing",
  "do not implement fixes or perform lifecycle writes",
  "A re-review by the same reviewer of the same target resumes the same review session",
  "preserving review history rather than development memory",
  "elaboration, proposal work, Start Development, Yolo, and orchestration stay in the bare direct-Idea UUID session",
  "`<directIdeaUuid>`, not `idea:<uuid>`",
  "An orchestrator also assigned a task uses `task:<uuid>` for task-start/reopen work",
  "orchestration replies and handoffs stay in the Idea session",
  "backend conversation and wake-queue anchors",
  "not the Chorus Agent Session `sessionUuid` used by session check-in tools",
  "Session separation does not isolate files or change the host's existing session check-in lifecycle",
];

const canonical = sessionScope(read("public/skill/develop-chorus/SKILL.md"));
const missingRules = (text: string) => rules.filter((rule) => !text.includes(rule));

describe("CLI session-anchor skill documentation across all eight surfaces", () => {
  for (const surface of surfaces) {
    for (const name of ["develop", "orchestrate", "review", "chorus"]) {
      const file = name === "chorus" && surface.overview
        ? surface.overview
        : `${surface.dir}/${name === "chorus" ? name : surface.prefix + name + surface.suffix}/SKILL.md`;

      it(`${surface.name}/${name} keeps the identical English session-scope block`, () => {
        const text = read(file);
        expect(text.split(heading)).toHaveLength(2);
        const block = sessionScope(text);
        expect(missingRules(block)).toEqual([]);
        expect(block).toBe(canonical);
      });
    }
  }

  it("rejects a missing session-scope section", () => {
    expect(sessionScope("## Overview\nNo session guidance.\n")).toBe("");
    expect(missingRules("")).toEqual(rules);
  });

  it.each(rules)("detects removal of the rule: %s", (rule) => {
    expect(missingRules(canonical.replaceAll(rule, "REMOVED"))).toContain(rule);
  });
});
