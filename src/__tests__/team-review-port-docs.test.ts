import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");
const version = JSON.parse(read("package.json")).version;
const skillVersion = JSON.parse(read("public/chorus-plugin/.claude-plugin/plugin.json")).version;
const codexVersion = JSON.parse(read("plugins/chorus/.codex-plugin/plugin.json")).version;
const piVersion = JSON.parse(read("packages/chorus-pi/package.json")).version;
const openclawVersion = JSON.parse(read("packages/openclaw-plugin/package.json")).version;
const dshVersion = JSON.parse(read("packages/chorus-dsh/package.json")).version;
const surfaceVersions: Record<string, string> = {
  "Codex/TRAE": codexVersion,
  Kiro: skillVersion,
  Pi: piVersion,
  OpenClaw: openclawVersion,
  Hermes: version,
  dsh: dshVersion,
};
const surfaces = [
  { name: "Codex/TRAE", dir: "plugins/chorus/skills", prefix: "", suffix: "", mechanics: ["spawn_agent", "TRAE CLI uses `Agent`"], fallback: false,
    reviewer: (kind: string) => `plugins/chorus/skills/chorus-${kind}-reviewer/SKILL.md` },
  { name: "Kiro", dir: "public/kiro-plugin/.kiro/skills", prefix: "chorus-", suffix: "", mechanics: ["native JSON reviewer", "Kiro selects"], fallback: false,
    overview: "public/kiro-plugin/.kiro/steering/chorus.md", reviewer: (kind: string) => `public/kiro-plugin/.kiro/agents/chorus-${kind}-reviewer.json` },
  { name: "Pi", dir: "packages/chorus-pi/skills", prefix: "", suffix: "", mechanics: ["`subagent` tool", "no handle to close"], fallback: true,
    reviewer: (kind: string) => `packages/chorus-pi/agents/chorus-${kind}-reviewer.md` },
  { name: "OpenClaw", dir: "packages/openclaw-plugin/skills", prefix: "", suffix: "", mechanics: ["sessions_spawn", "/task-reviewer"], fallback: true,
    reviewer: (kind: string) => `packages/openclaw-plugin/skills/${kind}-reviewer/SKILL.md` },
  { name: "Hermes", dir: "packages/chorus-hermes/chorus/skills", prefix: "", suffix: "", mechanics: ["delegate_task", "[chorus-reviewer:task]", "skill_view"], fallback: false,
    reviewer: (kind: string) => `packages/chorus-hermes/chorus/skills/chorus-${kind}-reviewer/SKILL.md` },
  { name: "dsh", dir: "packages/chorus-dsh/skills", prefix: "", suffix: "-chorus", mechanics: ["`subagent`", "run_in_background: false", "`skill` tool"], fallback: true,
    reviewer: (kind: string) => `packages/chorus-dsh/skills/${kind}-reviewer-chorus/SKILL.md` },
];

function section(text: string, heading: string): string {
  const body = text.split(`## ${heading}\n`)[1];
  expect(body, heading).toBeDefined();
  return body.split(/\n## |\n=== REVIEW PROCEDURE ===/)[0].trim();
}

function withoutSelfDispatch(text: string): string {
  return text
    .replace(/^- \*\*Recommendation is yourself:\*\*.*$/m, "HOST_SELF_DISPATCH")
    .replace(/(\[(?:proposal|task|code) reviewer protocol\])\([^)]+\)(?: — load with `skill_view\("chorus:chorus-(?:proposal|task|code)-reviewer"\)`)?/g, "$1(HOST_PATH)");
}

const canonical = section(read("public/chorus-plugin/skills/orchestrate/SKILL.md"), "Team review routing");
const receiverContract = canonical.split("### Receiver bootstrap\n\n")[1].split("\n\n### VERDICT routing")[0];
const literalContract = canonical.split("\n\n").find((paragraph) => paragraph.startsWith("The actual verdict MUST"))!;

describe("Team review protocol host parity", () => {
  for (const surface of surfaces) {
    const skill = (name: string) => `${surface.dir}/${name === "chorus" ? name : surface.prefix + name + surface.suffix}/SKILL.md`;

    it(`${surface.name} preserves every canonical routing rule`, () => {
      const text = section(read(skill("orchestrate")), "Team review routing");
      expect(withoutSelfDispatch(text)).toBe(withoutSelfDispatch(canonical));
      expect(text).toContain("review_orchestrator_subagent_fallback");
      const self = text.match(/^- \*\*Recommendation is yourself:\*\*.*$/m)![0];
      for (const mechanism of surface.mechanics) expect(self).toContain(mechanism);
      expect(self).toContain("same turn");
      if (surface.fallback) {
        expect(self).toContain("focused read-only pass inline");
        expect(self).toContain("same routed VERDICT");
      }
      const links = [...text.matchAll(/\[(proposal|task|code) reviewer protocol\]\(([^)]+)\)/g)];
      expect(links.map((link) => link[1])).toEqual(["proposal", "task", "code"]);
      for (const link of links) {
        const resolved = path.resolve(root, path.dirname(skill("orchestrate")), link[2]);
        expect(resolved).toBe(path.resolve(root, surface.reviewer(link[1])));
        expect(existsSync(resolved)).toBe(true);
        if (surface.name === "Hermes") expect(text).toContain(`skill_view("chorus:chorus-${link[1]}-reviewer")`);
      }
    });

    it(`${surface.name} links review, yolo and overview to its own protocol`, () => {
      for (const file of [skill("review"), skill("yolo"), surface.overview ?? skill("chorus")]) {
        const text = read(file);
        const links = [...text.matchAll(/\[Team review routing\]\(([^)]+)#team-review-routing\)/g)];
        expect(links.length, file).toBeGreaterThan(0);
        for (const link of links) expect(existsSync(path.resolve(root, path.dirname(file), link[1])), file).toBe(true);
        expect(text).toContain('role: "review"');
        expect(text).toContain("PASS / PASS WITH NOTES");
        expect(text).toContain(receiverContract);
        expect(text).toContain(literalContract);
        expect(text).toContain("expected PASS/FAIL recipient names/UUIDs (not mentions)");
        expect(text).toContain("A request must never start a line with `VERDICT:`");
      }
      expect(read(skill("yolo"))).toContain("3-round cap");
      expect(read(skill("yolo"))).toContain("A worker or product delegate must not take over orchestration or verification");
      if (surface.fallback) expect(read(skill("yolo"))).toContain("Generic reviewer instructions below");
    });

    for (const kind of ["proposal", "task", "code"]) {
      it(`${surface.name} ${kind} reviewer preserves the canonical recipient and read-only rules`, () => {
        const file = surface.reviewer(kind);
        const text = file.endsWith(".json") ? JSON.parse(read(file)).prompt : read(file);
        const actual = section(text, "Team reviewer");
        const expected = section(read(`public/chorus-plugin/agents/${kind}-reviewer.md`), "Team reviewer");
        const normalize = (content: string) => content.replace(/\[Team review routing\]\([^)]+\)/g, "[Team review routing](HOST_LINK)");
        expect(normalize(actual)).toBe(normalize(expected));
        expect(actual).toContain(receiverContract);
        expect(actual).toContain(literalContract);
        const link = actual.match(/\[Team review routing\]\(([^)]+)#team-review-routing\)/)![1];
        expect(existsSync(path.resolve(root, path.dirname(file), link))).toBe(true);
      });
    }

    it(`${surface.name} aligns every skill with its package version source`, () => {
      const expectedVersion = surfaceVersions[surface.name];
      for (const name of readdirSync(path.join(root, surface.dir))) {
        expect(read(`${surface.dir}/${name}/SKILL.md`).match(/^  version: "([^"]+)"/m)?.[1], name).toBe(expectedVersion);
      }
    });
  }

  it("detects missing human gates and role fallback", () => {
    for (const rule of ["review_orchestrator_subagent_fallback", "does **not** approve", "3 rounds per entity"]) {
      expect(withoutSelfDispatch(canonical.replaceAll(rule, "REMOVED"))).not.toBe(withoutSelfDispatch(canonical));
    }
  });

  it("aligns manifests, lockfile and hardcoded MCP client versions", () => {
    expect(codexVersion).toBe(skillVersion);
    expect(JSON.parse(read("packages/chorus-hermes/chorus-mcp/plugin.json")).version).toBe(version);
    const lock = JSON.parse(read("packages/openclaw-plugin/package-lock.json"));
    expect(lock.version).toBe(openclawVersion);
    expect(lock.packages[""].version).toBe(openclawVersion);
    expect(read("packages/chorus-hermes/chorus/plugin.yaml")).toContain(`version: ${version}\n`);
    for (const file of ["plugins/chorus/hooks/chorus-mcp-call.sh", "public/kiro-plugin/bin/chorus-api.sh"]) {
      expect(read(file)).toContain(`"version":"${skillVersion}"`);
    }
    expect(read("packages/chorus-pi/bin/chorus-mcp-call.sh")).toContain(`"version":"${piVersion}"`);
  });

  it("removes hook-only wording from the standalone yolo skill", () => {
    expect(read("public/skill/yolo-chorus/SKILL.md")).toContain("Generic reviewer instructions below");
    expect(read("public/skill/yolo-chorus/SKILL.md")).not.toContain("Generic hook reminders below");
  });
});
