#!/usr/bin/env node

import { readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const expectedSkills = [
  "brainstorm-chorus",
  "chorus",
  "chorus-cli",
  "code-reviewer-chorus",
  "develop-chorus",
  "docs-chorus",
  "idea-chorus",
  "openspec-aware-chorus",
  "orchestrate-chorus",
  "proposal-chorus",
  "proposal-reviewer-chorus",
  "quick-dev-chorus",
  "review-chorus",
  "task-reviewer-chorus",
  "yolo-chorus",
];
const expectedPeers = [
  "@deepseek-ai/dsh-mcp-client",
  "@deepseek-ai/dsh-persona",
  "@deepseek-ai/dsh-skill-filesystem",
  "@deepseek-ai/dsh-tool-skill",
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
// Version is intentionally NOT asserted — it is bumped freely (test/pre-release
// publishes decouple from the Chorus app version).
assert(manifest.private !== true, "package remains private");
assert(manifest.publishConfig?.access === "public", "package is not public");
assert(manifest.dsh?.bundle?.patch === "./cordis.patch.yml", "invalid dsh bundle patch");
assert(
  manifest.bin?.["chorus-dsh-mcp-call"] === "bin/chorus-mcp-call.mjs",
  "package-local MCP wrapper bin is missing",
);
assert(
  JSON.stringify(Object.keys(manifest.dependencies ?? {})) ===
    JSON.stringify(["@deepseek-ai/schemastery"]),
  "unexpected runtime dependencies",
);
assert(
  JSON.stringify(Object.keys(manifest.peerDependencies ?? {}).sort()) ===
    JSON.stringify(expectedPeers),
  "unexpected peer dependencies",
);

const actualSkills = (await readdir(join(root, "skills"), { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
assert(
  JSON.stringify(actualSkills) === JSON.stringify(expectedSkills),
  `unexpected skill set: ${actualSkills.join(", ")}`,
);
for (const name of expectedSkills) {
  const text = await readFile(join(root, "skills", name, "SKILL.md"), "utf8");
  const frontmatter = text.match(/^---\n([\s\S]*?)\n---\n/);
  assert(frontmatter, `${name}: missing frontmatter`);
  assert(
    frontmatter[1].match(/^name:\s*(\S+)\s*$/m)?.[1] === name,
    `${name}: frontmatter name mismatch`,
  );
  assert(
    (frontmatter[1].match(/^description:\s*(.+)$/m)?.[1] ?? "").trim().length > 20,
    `${name}: missing description`,
  );
}
const openSpecSkill = await readFile(
  join(root, "skills", "openspec-aware-chorus", "SKILL.md"),
  "utf8",
);
assert(openSpecSkill.includes("CHORUS_MCP_CALL"), "OpenSpec skill does not use package wrapper");
assert(!openSpecSkill.includes("$DSH_HOME"), "OpenSpec skill retains DSH_HOME wrapper contract");

const patch = await readFile(join(root, "cordis.patch.yml"), "utf8");
for (const row of [
  "@chorus-aidlc/chorus-dsh",
  "@deepseek-ai/dsh-mcp-client",
  "@deepseek-ai/dsh-skill-filesystem",
  "@deepseek-ai/dsh-tool-skill",
  "@chorus-aidlc/chorus-dsh/persona",
  "plugin: '@deepseek-ai/dsh-persona'",
  "customSkillDirs",
  "createRequire(baseUrl)",
  "text: |-",
  "chorusDshConfig.url",
  "chorusDshConfig.apiKey",
]) {
  assert(patch.includes(row), `bundle patch missing ${row}`);
}
for (const forbidden of ["$DSH_HOME", "agent-presets", "dshHome:", "cho_"]) {
  assert(!patch.includes(forbidden), `bundle patch contains forbidden value ${forbidden}`);
}

console.log(`chorus-dsh package validation passed (${expectedSkills.length} skills)`);
