import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { buildBatchPrompt, buildPrompt, HEADLESS_PREAMBLE } from "../prompts.mjs";

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const normalize = (text) => text.replace(/\s+/g, " ");
const heading = "## Claude Code background child ownership";
const ownershipSection = (text) => text.split(heading)[1]?.split("\n## ")[0]?.trim();
const notification = {
  action: "task_assigned",
  entityType: "task",
  entityUuid: "task-1",
  entityTitle: "Background ownership",
};

function expectOwnership(text) {
  const normalized = normalize(text);
  expect(normalized).toContain("Claude Code only");
  expect(normalized).toContain("run_in_background");
  expect(normalized).toContain("ALL background worker/reviewer results before ending a normal turn");
  expect(normalized).toContain("Do not end immediately after dispatch");
  expect(normalized).toContain("launch acknowledgement is not completion");
  expect(normalized).toContain("Before posting a human decision request");
  expect(normalized).toContain("finish independent children or explicitly cancel outstanding children");
  expect(normalized).toContain("record which children remain incomplete");
  expect(normalized).toContain("Respect explicit user stop/cancel and shutdown");
  expect(normalized).toContain("do not delay them to collect results or restart cancelled work");
  expect(normalized).toContain("not a mandate to wait forever");
}

describe("Claude background ownership prompt", () => {
  it("requires all results and reconciles children before the asynchronous human handoff", () => {
    expectOwnership(HEADLESS_PREAMBLE);
    expect(HEADLESS_PREAMBLE.indexOf("Before posting a human decision request"))
      .toBeLessThan(HEADLESS_PREAMBLE.indexOf("After you post something"));
    expect(normalize(HEADLESS_PREAMBLE)).toContain("END THE TURN and leave the work pending — do not poll or wait for a synchronous reply");
  });

  it.each([
    ["single", () => buildPrompt(notification)],
    ["batch", () => buildBatchPrompt([notification, { ...notification, entityUuid: "task-2" }])],
  ])("carries the Claude-only rule once in a %s wake", (_name, build) => {
    const prompt = build();
    expectOwnership(prompt);
    expect(prompt.split("Claude Code only")).toHaveLength(2);
  });
});

describe("Claude workflow skill counterparts", () => {
  it.each(["develop", "yolo", "orchestrate"])("keeps %s ownership and handoff guidance mirrored", (skill) => {
    const plugin = read(`public/chorus-plugin/skills/${skill}/SKILL.md`);
    const standalone = read(`public/skill/${skill}-chorus/SKILL.md`);
    expectOwnership(plugin);
    expectOwnership(standalone);
    expect(ownershipSection(plugin)).toBe(ownershipSection(standalone));
    expect(ownershipSection(plugin)).toContain("end the turn without polling the human");
    expect(ownershipSection(plugin)).toContain("not independently assigned Chorus agents");
    expect(standalone).not.toContain('version: "0.17.0"');
  });

  it("bumps all Claude package version locations together", () => {
    const plugin = JSON.parse(read("public/chorus-plugin/.claude-plugin/plugin.json"));
    const marketplace = JSON.parse(read(".claude-plugin/marketplace.json"));
    expect(plugin.version).not.toBe("0.21.1");
    expect(marketplace.plugins.find((entry) => entry.name === plugin.name)?.version).toBe(plugin.version);
    const skills = readdirSync(new URL("../../public/chorus-plugin/skills/", import.meta.url));
    for (const skill of skills) {
      expect(read(`public/chorus-plugin/skills/${skill}/SKILL.md`)).toContain(`version: "${plugin.version}"`);
    }
  });
});
