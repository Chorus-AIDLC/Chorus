#!/usr/bin/env node

// Package-shape validation for @chorus-aidlc/chorus-pi (the `check:package`
// script, run by `prepublishOnly`). Modeled on the dsh package's
// validate-package.mjs, but chorus-pi publishes TypeScript source as-is (pi
// loads `.ts` via jiti), so there is NO build/dist step to assert.
//
// It asserts: package identity (name), version lockstep with the root app
// package.json, the publish shape (publishConfig / files allowlist / repository
// directory / bin / `pi` manifest), the skill set, the 3 reviewer agents, and
// the bundled official-subagent extension (extensions/subagent/{index.ts,agents.ts}).
// A missing skill, reviewer agent, or subagent file exits non-zero and NAMES the
// offending item.
//
// Skill-set decoupling (A1 <-> B): task A1 landed this list with the 11 skills
// present then (no `brainstorm`). Task B adds the `brainstorm` skill AND extends
// this expected list to 12, keeping A1 and B independent DAG roots (A1 passed on
// 11, B passes on 12).

import { access, readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(root, "..", "..");

const expectedName = "@chorus-aidlc/chorus-pi";
const expectedFiles = ["extensions", "lib", "skills", "agents", "bin", "README.md"];
const expectedSkills = [
  "brainstorm",
  "chorus",
  "chorus-cli",
  "develop",
  "docs",
  "idea",
  "openspec-aware",
  "orchestrate",
  "proposal",
  "quick-dev",
  "review",
  "yolo",
];
const expectedAgents = [
  "chorus-code-reviewer",
  "chorus-proposal-reviewer",
  "chorus-task-reviewer",
];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const appManifest = JSON.parse(await readFile(join(repoRoot, "package.json"), "utf8"));

// ─── Identity + version lockstep ────────────────────────────────────────────
assert(manifest.name === expectedName, `unexpected package name: ${manifest.name}`);
assert(manifest.private !== true, "package is marked private");
assert(
  typeof manifest.version === "string" && /^\d+\.\d+\.\d+/.test(manifest.version),
  `invalid package version: ${manifest.version}`,
);
assert(
  manifest.version === appManifest.version,
  `version drift: chorus-pi ${manifest.version} !== root app ${appManifest.version} (must be lockstep)`,
);

// ─── Publish shape ──────────────────────────────────────────────────────────
assert(manifest.publishConfig?.access === "public", "publishConfig.access is not 'public'");
assert(
  manifest.repository?.directory === "packages/chorus-pi",
  "repository.directory is not 'packages/chorus-pi'",
);
// TS-as-is: main must remain the extension source (NO dist build step).
assert(
  manifest.main === "extensions/chorus.ts",
  `main must stay 'extensions/chorus.ts' (TS published as-is), got: ${manifest.main}`,
);
assert(
  JSON.stringify(manifest.files ?? []) === JSON.stringify(expectedFiles),
  `unexpected files allowlist: ${JSON.stringify(manifest.files)}`,
);
assert(
  manifest.bin?.["chorus-mcp-call"] === "bin/chorus-mcp-call.sh",
  "package-local MCP wrapper bin is missing",
);
assert(manifest.scripts?.prepublishOnly === "pnpm run check:package", "prepublishOnly is not wired to check:package");

// ─── pi manifest shape ──────────────────────────────────────────────────────
assert(
  JSON.stringify(manifest.pi?.extensions) === JSON.stringify(["./extensions"]),
  `unexpected pi.extensions: ${JSON.stringify(manifest.pi?.extensions)}`,
);
assert(
  JSON.stringify(manifest.pi?.skills) === JSON.stringify(["./skills"]),
  `unexpected pi.skills: ${JSON.stringify(manifest.pi?.skills)}`,
);

// ─── Skill set (current — no brainstorm; task B extends this) ───────────────
const actualSkills = (await readdir(join(root, "skills"), { withFileTypes: true }))
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .sort();
const expectedSkillsSorted = [...expectedSkills].sort();
for (const name of expectedSkillsSorted) {
  assert(actualSkills.includes(name), `expected skill missing: ${name}`);
}
for (const name of actualSkills) {
  assert(expectedSkillsSorted.includes(name), `unexpected skill present (extend the expected set?): ${name}`);
}
for (const name of expectedSkillsSorted) {
  const text = await readFile(join(root, "skills", name, "SKILL.md"), "utf8");
  const frontmatter = text.match(/^---\n([\s\S]*?)\n---\n/);
  assert(frontmatter, `skill ${name}: missing frontmatter`);
  assert(
    frontmatter[1].match(/^name:\s*(\S+)\s*$/m)?.[1] === name,
    `skill ${name}: frontmatter name mismatch`,
  );
  assert(
    (frontmatter[1].match(/^description:\s*(.+)$/m)?.[1] ?? "").trim().length > 20,
    `skill ${name}: missing description`,
  );
}

// ─── Reviewer agents ────────────────────────────────────────────────────────
const actualAgents = (await readdir(join(root, "agents"), { withFileTypes: true }))
  .filter((entry) => entry.isFile() && entry.name.endsWith(".md"))
  .map((entry) => entry.name.replace(/\.md$/, ""))
  .sort();
const expectedAgentsSorted = [...expectedAgents].sort();
for (const name of expectedAgentsSorted) {
  assert(actualAgents.includes(name), `expected reviewer agent missing: ${name}`);
}
for (const name of expectedAgentsSorted) {
  const text = await readFile(join(root, "agents", `${name}.md`), "utf8");
  const frontmatter = text.match(/^---\n([\s\S]*?)\n---\n/);
  assert(frontmatter, `agent ${name}: missing frontmatter`);
  assert(
    frontmatter[1].match(/^name:\s*(\S+)\s*$/m)?.[1] === name,
    `agent ${name}: frontmatter name mismatch`,
  );
  assert(
    (frontmatter[1].match(/^description:\s*(.+)$/m)?.[1] ?? "").trim().length > 20,
    `agent ${name}: missing description`,
  );
}

// ─── Bundled official-subagent extension ─────────────────────────────────────
// The reviewer subagents use pi's official subagent pattern, copied into
// extensions/subagent/. Both files must be present (index.ts registers the
// `subagent` tool; agents.ts adds package-relative agent discovery). The
// @narumitw/pi-subagents dependency must be gone from every dependency block.
for (const rel of ["extensions/subagent/index.ts", "extensions/subagent/agents.ts"]) {
  try {
    await access(join(root, rel));
  } catch {
    throw new Error(`missing bundled subagent file: ${rel}`);
  }
}
for (const block of ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"]) {
  assert(
    !manifest[block]?.["@narumitw/pi-subagents"],
    `@narumitw/pi-subagents must be removed from ${block}`,
  );
}

console.log(
  `chorus-pi package validation passed (v${manifest.version}, ${expectedSkillsSorted.length} skills, ${expectedAgentsSorted.length} reviewer agents, bundled subagent extension)`,
);
