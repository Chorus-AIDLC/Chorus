import assert from "node:assert/strict";
import test from "node:test";
import { evaluateAudit } from "../audit-root.mjs";

const pkg = { devDependencies: { "eslint-config-next": "15", shadcn: "3" } };
const EX = { "GHSA-exempt": { reason: "fixture", via: ["eslint-config-next"] } };

function advisory(id, severity, paths, extra = {}) {
  return {
    github_advisory_id: id,
    module_name: "pkg",
    severity,
    vulnerable_versions: "<2",
    patched_versions: ">=2",
    findings: [{ version: "1.0.0", paths }],
    ...extra,
  };
}

function run(advisories, { status, counts, raw, ...rest } = {}) {
  const list = Object.fromEntries(advisories.map((a, i) => [String(i), a]));
  const vulnerabilities = counts ?? advisories.reduce((c, a) => ({ ...c, [a.severity]: (c[a.severity] || 0) + 1 }), {});
  const stdout = raw ?? JSON.stringify({ advisories: list, metadata: { vulnerabilities } });
  return evaluateAudit({ status: status ?? (advisories.length ? 1 : 0), stdout, stderr: "", ...rest }, pkg, EX);
}

test("clean audit passes", () => {
  assert.equal(run([]).code, 0);
});

test("root high/critical fails", () => {
  for (const severity of ["high", "critical"]) {
    const r = run([advisory("GHSA-x", severity, [". > next@15.0.0 > pkg@1.0.0"])]);
    assert.equal(r.code, 1);
    assert.match(r.lines.join("\n"), /GHSA-x/);
  }
});

test("moderate/low and packages/* findings do not fail", () => {
  const r = run([
    advisory("GHSA-m", "moderate", [". > next@15.0.0 > pkg@1.0.0"]),
    advisory("GHSA-l", "high", ["packages/landing > astro@5.0.0 > pkg@1.0.0"]),
  ]);
  assert.equal(r.code, 0);
});

test("exemption applies only through its allowed dev chains", () => {
  const ok = run([advisory("GHSA-exempt", "high", [". > eslint-config-next@15.0.0 > pkg@1.0.0"])]);
  assert.equal(ok.code, 0);
  const escaped = run([
    advisory("GHSA-exempt", "high", [". > eslint-config-next@15.0.0 > pkg@1.0.0", ". > next@15.0.0 > pkg@1.0.0"]),
  ]);
  assert.equal(escaped.code, 1);
  assert.match(escaped.lines.join("\n"), /outside its allowed dev chains/);
});

test("exemption via a package that is not a root devDependency is ignored", () => {
  const r = evaluateAudit(
    { status: 1, stdout: JSON.stringify({ advisories: { 0: advisory("GHSA-exempt", "high", [". > eslint-config-next@15.0.0 > pkg@1.0.0"]) }, metadata: { vulnerabilities: { high: 1 } } }) },
    { dependencies: { "eslint-config-next": "15" } },
    EX,
  );
  assert.equal(r.code, 1);
});

test("untrusted spawn results exit 2", () => {
  assert.equal(run([], { error: new Error("ENOENT") }).code, 2);
  assert.equal(run([], { signal: "SIGKILL", status: null }).code, 2);
  assert.equal(run([], { status: 254 }).code, 2);
});

test("malformed or inconsistent JSON exits 2", () => {
  assert.equal(run([], { raw: "not json" }).code, 2);
  assert.equal(run([], { raw: "{}" }).code, 2);
  assert.equal(run([], { raw: "{}", status: 1 }).code, 2);
  assert.equal(run([], { raw: JSON.stringify({ error: { message: "404" } }) }).code, 2);
  assert.equal(run([], { counts: { high: 1 } }).code, 2);
  assert.equal(run([], { status: 1, counts: {} }).code, 2);
});

test("severe advisory with missing or unrecognized paths exits 2 instead of passing", () => {
  assert.equal(run([advisory("GHSA-p", "high", [])]).code, 2);
  assert.equal(run([advisory("GHSA-p", "high", ["next/pkg"])]).code, 2);
  assert.equal(run([advisory("GHSA-p", "high", [], { findings: undefined })]).code, 2);
});
