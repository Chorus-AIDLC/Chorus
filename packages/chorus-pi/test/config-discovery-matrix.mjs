import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const { values } = parseArgs({ options: {
  artifact: { type: "string" }, roots: { type: "string" }, help: { type: "boolean" },
} });
if (values.help) {
  console.log("node test/config-discovery-matrix.mjs --artifact /tmp/chorus.tgz --roots /tmp/chorus-pi-compat-\n" +
    "Runs 16 additional writer-to-packed-extension scenarios without CHORUS_URL; " +
    "the existing 36-scenario compat-matrix remains separate and unchanged. No installation or live credentials.");
  process.exit(0);
}
const artifact = realpathSync(values.artifact ?? process.env.CHORUS_PI_PACKED_ARTIFACT ?? "");
const sha256 = createHash("sha256").update(readFileSync(artifact)).digest("hex");
const versions = ["0.84.4", "0.87.1", "0.99.0", "1.0.2"];
const roots = process.env.CHORUS_PI_SDK_ROOTS ? JSON.parse(process.env.CHORUS_PI_SDK_ROOTS)
  : Object.fromEntries(versions.map((version) => [version, `${values.roots ?? "/tmp/chorus-pi-compat-"}${version}`]));
assert.equal(new Set(versions.map((version) => realpathSync(roots[version]))).size, 4);
const results = [];
for (const version of versions) {
  for (const connection of ["generated-fresh", "generated-retained"]) {
    for (const agentDir of ["default", "custom"]) {
      const args = [fileURLToPath(new URL("compat-host.mjs", import.meta.url)), "--sdk-root",
        resolve(roots[version]), "--artifact", artifact, "--version", version, "--exposure", "direct",
        "--gate", "all", "--connection", connection, "--agent-dir", agentDir];
      process.stderr.write(`Running Pi ${version} (${connection}, ${agentDir}, no CHORUS_URL)\n`);
      const result = spawnSync(process.execPath, args, { encoding: "utf8", timeout: 240000,
        maxBuffer: 16 * 1024 * 1024 });
      const evidence = result.stdout.split("\n").findLast((line) => line.startsWith("COMPAT_RESULT="));
      results.push({ version, connection, agentDir, command: [process.execPath, ...args],
        passed: result.status === 0 && !!evidence, result: evidence ? JSON.parse(evidence.slice(14)) : null,
        ...(result.status !== 0 ? { stdout: result.stdout, stderr: result.stderr,
          error: result.error?.message, status: result.status } : {}) });
    }
  }
}
const sameArtifact = results.every((result) => !result.passed || result.result.sha256 === sha256);
console.log(JSON.stringify({ mandatory: versions, artifact, sha256, sameArtifact, nodeVersion: process.version, results }, null, 2));
process.exitCode = sameArtifact && results.every((result) => result.passed) ? 0 : 1;
