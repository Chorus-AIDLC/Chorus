#!/usr/bin/env node
// Fails when the ROOT project's dependency tree has unexempted high/critical advisories.
// `pnpm audit` scans the whole workspace; packages/* are out of scope, so we keep only
// findings whose path starts at the root importer ("." > ...).
//
// Exit codes: 0 clean, 1 unexempted root high/critical, 2 audit could not be trusted
// (spawn failure, signal, unexpected exit status, malformed or inconsistent JSON).
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

// Advisories with no patched release. Each entry needs a reason and `via`: the root
// devDependencies the vulnerable package may be reached through. A root path entering
// through any other direct dependency (or a runtime dependency) is NOT exempt.
export const EXEMPT = {
  // braces <=3.0.3: no patched version exists. Reached via eslint-config-next >
  // @next/eslint-plugin-next > fast-glob > micromatch, and shadcn > (ts-morph >) fast-glob >
  // micromatch. Both are dev tooling over trusted, repo-local globs.
  "GHSA-vfj7-8cjw-p6xm": {
    reason: "braces: no patched release; dev-only lint/shadcn CLI chains",
    via: ["eslint-config-next", "shadcn"],
  },
};

const SEVERE = new Set(["high", "critical"]);
// "<importer> > pkg@ver > pkg@ver ...", importer is "." for the root.
const PATH_RE = /^[^\s>]+( > [^\s>]+)+$/;

function pkgName(hop) {
  const at = hop.lastIndexOf("@");
  return at > 0 ? hop.slice(0, at) : hop;
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * Pure evaluation of a `pnpm audit --json` spawn result.
 * @param {{ status: number|null, signal?: string|null, error?: Error, stdout?: string, stderr?: string }} r
 * @param {{ devDependencies?: Record<string, string> }} pkg root package.json
 * @param {typeof EXEMPT} exempt
 * @returns {{ code: 0|1|2, lines: string[] }}
 */
export function evaluateAudit(r, pkg, exempt = EXEMPT) {
  const untrusted = (msg) => ({ code: 2, lines: [msg] });
  if (r.error) return untrusted(`Could not run pnpm audit: ${r.error.message}`);
  if (r.signal) return untrusted(`pnpm audit was killed by ${r.signal}`);
  // pnpm audit exits 0 when clean and 1 when vulnerabilities were found.
  if (r.status !== 0 && r.status !== 1) return untrusted(`pnpm audit exited with unexpected status ${r.status}`);

  let data;
  try {
    data = JSON.parse(r.stdout);
  } catch {
    return untrusted("Could not parse `pnpm audit --json` output:\n" + (r.stdout || "") + (r.stderr || ""));
  }
  if (!isPlainObject(data)) return untrusted("pnpm audit output is not a JSON object");
  if (data.error) return untrusted(`pnpm audit failed: ${data.error.message ?? JSON.stringify(data.error)}`);
  const counts = data.metadata?.vulnerabilities;
  if (!isPlainObject(data.advisories) || !isPlainObject(counts)) {
    return untrusted("pnpm audit output is missing `advisories` or `metadata.vulnerabilities`");
  }

  const advisories = Object.values(data.advisories);
  const total = Object.values(counts).reduce((s, n) => s + (Number(n) || 0), 0);
  if (r.status === 1 && total === 0) return untrusted("pnpm audit exited 1 but reported no vulnerabilities");
  for (const sev of SEVERE) {
    if ((Number(counts[sev]) || 0) > 0 && !advisories.some((a) => a.severity === sev)) {
      return untrusted(`pnpm audit reports ${counts[sev]} ${sev} vulnerabilities but lists no ${sev} advisory`);
    }
  }

  const devDeps = new Set(Object.keys(pkg.devDependencies || {}));
  const bad = [];
  for (const a of advisories) {
    if (!SEVERE.has(a.severity)) continue;
    const paths = (Array.isArray(a.findings) ? a.findings : []).flatMap((f) => (Array.isArray(f.paths) ? f.paths : []));
    // A severe advisory without parseable paths means pnpm's format changed; refuse to
    // guess whether it belongs to the root rather than silently reporting clean.
    const malformed = paths.length === 0 ? "(no paths)" : paths.find((p) => typeof p !== "string" || !PATH_RE.test(p));
    if (malformed !== undefined) {
      return untrusted(`Unrecognized path format for ${a.module_name} (${a.github_advisory_id}): ${malformed}`);
    }
    const rootPaths = paths.filter((p) => p.startsWith(". > "));
    if (!rootPaths.length) continue;
    const ex = exempt[a.github_advisory_id];
    const allowed = new Set((ex?.via || []).filter((name) => devDeps.has(name)));
    const unexempted = rootPaths.filter((p) => !allowed.has(pkgName(p.split(" > ")[1])));
    if (unexempted.length) bad.push({ a, path: unexempted[0], exemptButEscaped: Boolean(ex) });
  }

  if (bad.length) {
    const lines = bad.map(
      ({ a, path, exemptButEscaped }) =>
        `[${a.severity}] ${a.module_name} ${a.vulnerable_versions} (${a.github_advisory_id}) — fix: ${a.patched_versions}` +
        (exemptButEscaped ? " — exempted, but reached outside its allowed dev chains" : "") +
        `\n    ${path}`,
    );
    lines.push(`\n${bad.length} unexempted high/critical advisories in the root project.`);
    return { code: 1, lines };
  }
  return { code: 0, lines: ["Root project audit clean (high/critical), exemptions: " + Object.keys(exempt).join(", ")] };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const registry = process.env.AUDIT_REGISTRY || "https://registry.npmjs.org";
  const r = spawnSync("pnpm", ["audit", "--json", "--registry", registry], {
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    shell: process.platform === "win32",
  });
  const pkg = JSON.parse(readFileSync(resolve(process.cwd(), "package.json"), "utf8"));
  const { code, lines } = evaluateAudit(r, pkg);
  (code === 0 ? console.log : console.error)(lines.join("\n"));
  process.exit(code);
}
