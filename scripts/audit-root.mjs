#!/usr/bin/env node
// Fails when the ROOT project's dependency tree has unexempted high/critical advisories.
// `pnpm audit` scans the whole workspace; packages/* are out of scope, so we keep only
// findings whose path starts at the root importer ("." > ...).
import { spawnSync } from "node:child_process";

// Advisories with no patched release. Each entry needs a reason.
const EXEMPT = {
  // braces <=3.0.3: no patched version exists. Reached only via
  // eslint-config-next > @next/eslint-plugin-next > fast-glob > micromatch (lint-time dev tooling, trusted input).
  "GHSA-vfj7-8cjw-p6xm": "braces: no patched release; dev-only lint chain",
};

const registry = process.env.AUDIT_REGISTRY || "https://registry.npmjs.org";
const r = spawnSync("pnpm", ["audit", "--json", "--registry", registry], {
  encoding: "utf8",
  maxBuffer: 256 * 1024 * 1024,
  shell: process.platform === "win32",
});
let data;
try {
  data = JSON.parse(r.stdout);
} catch {
  console.error("Could not parse `pnpm audit --json` output:\n" + (r.stdout || "") + (r.stderr || ""));
  process.exit(2);
}
if (data.error) {
  console.error("pnpm audit failed:", data.error.message);
  process.exit(2);
}
const bad = [];
for (const a of Object.values(data.advisories || {})) {
  if (a.severity !== "high" && a.severity !== "critical") continue;
  if (EXEMPT[a.github_advisory_id]) continue;
  const rootPaths = (a.findings || []).flatMap((f) => f.paths).filter((p) => p.startsWith(". >"));
  if (rootPaths.length) bad.push({ a, path: rootPaths[0] });
}
if (bad.length) {
  for (const { a, path } of bad)
    console.error(`[${a.severity}] ${a.module_name} ${a.vulnerable_versions} (${a.github_advisory_id}) — fix: ${a.patched_versions}\n    ${path}`);
  console.error(`\n${bad.length} unexempted high/critical advisories in the root project.`);
  process.exit(1);
}
console.log("Root project audit clean (high/critical), exemptions: " + Object.keys(EXEMPT).join(", "));
