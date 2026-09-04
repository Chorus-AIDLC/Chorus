import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmod,
  cp,
  mkdtemp,
  mkdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { parseReleaseTag } from "../lib.mjs";

const testDirectory = dirname(fileURLToPath(import.meta.url));
const sourceDirectory = resolve(testDirectory, "..");
const repositoryRoot = resolve(sourceDirectory, "../..");
const releaseTag = "v0.17.0";
const version = "0.17.0";
const releaseManifest = JSON.parse(
  await readFile(resolve(sourceDirectory, "manifest.json"), "utf8"),
);
const packageDefinitions = [
  {
    label: "Chorus CLI",
    directory: ".",
    packageName: "@chorus-aidlc/chorus",
    requiredFiles: [
      "package.json",
      "chorus.mjs",
      "cli/daemon.mjs",
      "prisma/schema.prisma",
      ".next/standalone/server.js",
    ],
  },
  {
    label: "OpenClaw plugin",
    directory: "packages/openclaw-plugin",
    packageName: "@chorus-aidlc/chorus-openclaw-plugin",
    requiredFiles: [
      "package.json",
      "dist/index.js",
      "src/index.ts",
      "openclaw.plugin.json",
      "README.md",
    ],
  },
  {
    label: "dsh plugin",
    directory: "packages/chorus-dsh",
    packageName: "@chorus-aidlc/chorus-dsh",
    requiredFiles: [
      "package.json",
      "bin/chorus-mcp-call.mjs",
      "dist/chorus-dsh.mjs",
      "dist/index.d.ts",
      "dist/persona.mjs",
      "dist/persona.d.ts",
      "cordis.patch.yml",
      "README.md",
    ],
  },
  {
    label: "chorus-pi plugin",
    directory: "packages/chorus-pi",
    packageName: "@chorus-aidlc/chorus-pi",
    requiredFiles: [
      "package.json",
      "extensions/chorus.ts",
      "skills/chorus/SKILL.md",
      "agents/chorus-task-reviewer.md",
      "README.md",
    ],
  },
];
const expectedLifecycleCommands = {
  "@chorus-aidlc/chorus": {
    installCommands: ["pnpm install --frozen-lockfile"],
    checkCommands: [
      "pnpm exec prisma generate",
      "pnpm exec eslint src cli chorus.mjs scripts/prepack-pglite.mjs scripts/coordinated-npm-release",
      "pnpm exec tsc --noEmit",
      "pnpm test",
    ],
    buildCommands: ["pnpm build"],
    packageCommands: ["node scripts/prepack-pglite.mjs"],
    postPackCheck: "chorus-cli-smoke",
  },
  "@chorus-aidlc/chorus-openclaw-plugin": {
    installCommands: [
      "npm ci --ignore-scripts --no-audit --no-fund",
    ],
    checkCommands: ["npm run clean", "npm run typecheck", "npm run test"],
    buildCommands: ["npm run build"],
    packageCommands: [
      "test -f dist/index.js",
      "grep -F 'id: \"chorus-openclaw-plugin\"' dist/index.js",
    ],
    postPackCheck: "openclaw-plugin",
  },
  "@chorus-aidlc/chorus-dsh": {
    installCommands: ["pnpm install --frozen-lockfile"],
    checkCommands: [
      "pnpm lint",
      "pnpm typecheck",
      "pnpm test",
      "pnpm run check:dsh-contract",
    ],
    buildCommands: ["pnpm build"],
    packageCommands: ["pnpm run check:package", "pnpm run check:pack"],
    postPackCheck: "none",
  },
  "@chorus-aidlc/chorus-pi": {
    installCommands: ["pnpm install --frozen-lockfile"],
    checkCommands: ["pnpm run check:package"],
    buildCommands: [],
    packageCommands: ["pnpm run check:pack"],
    postPackCheck: "none",
  },
};

async function writeJson(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function createFixture(t, { failPrepareFor } = {}) {
  const root = await mkdtemp(resolve(tmpdir(), "chorus-coordinated-release-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const scripts = resolve(root, "scripts/coordinated-npm-release");
  await mkdir(scripts, { recursive: true });
  for (const file of ["lib.mjs", "prepare.mjs", "publish.mjs"]) {
    await cp(resolve(sourceDirectory, file), resolve(scripts, file));
  }

  const manifest = {
    packages: releaseManifest.packages.map((entry) => ({
      ...entry,
      requiredFiles: packageDefinitions.find(
        ({ packageName }) => packageName === entry.packageName,
      ).requiredFiles,
      ...Object.fromEntries(
        ["installCommands", "checkCommands", "buildCommands", "packageCommands"].map(
          (phase) => [
            phase,
            entry[phase].map(
              (_, index) => `node fixture-command.mjs ${phase} ${index}`,
            ),
          ],
        ),
      ),
      forbiddenPatterns: ["(^|/)forbidden-secret[.]txt$"],
      postPackCheck:
        entry.packageName === "@chorus-aidlc/chorus-openclaw-plugin"
          ? "openclaw-plugin"
          : "none",
    })),
  };
  await writeJson(resolve(scripts, "manifest.json"), manifest);

  for (const definition of packageDefinitions) {
    const packageRoot = resolve(root, definition.directory);
    const files = definition.requiredFiles.filter((file) => file !== "package.json");
    await writeJson(resolve(packageRoot, "package.json"), {
      name: definition.packageName,
      version,
      files,
    });
    for (const file of files) {
      const path = resolve(packageRoot, file);
      await mkdir(dirname(path), { recursive: true });
      const content =
        file === "dist/index.js"
          ? 'export default { id: "chorus-openclaw-plugin" };\n'
          : `${definition.packageName}: ${file}\n`;
      await writeFile(path, content);
    }
    await writeFile(
      resolve(packageRoot, "fixture-command.mjs"),
      [
        'import { appendFileSync } from "node:fs";',
        "const [phase, index] = process.argv.slice(2);",
        `appendFileSync(${JSON.stringify(resolve(root, "prepare.log"))}, JSON.stringify({ packageName: ${JSON.stringify(definition.packageName)}, phase, index: Number(index) }) + "\\n");`,
        failPrepareFor === definition.packageName
          ? 'if (phase === "checkCommands" && index === "0") throw new Error("intentional prepare failure");'
          : "",
        "",
      ].join("\n"),
    );
  }
  return root;
}

function runScript(root, script, args = [], env = {}) {
  return spawnSync(process.execPath, [
    resolve(root, "scripts/coordinated-npm-release", script),
    ...args,
  ], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

async function readMaybe(path) {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return "";
    throw error;
  }
}

async function prepareFixture(t) {
  const root = await createFixture(t);
  const result = runScript(root, "prepare.mjs", [releaseTag]);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return root;
}

async function installMockNpm(root) {
  const path = resolve(root, "mock-npm.mjs");
  await writeFile(
    path,
    `#!/usr/bin/env node
import { appendFileSync } from "node:fs";

const args = process.argv.slice(2);
appendFileSync(process.env.MOCK_NPM_LOG, JSON.stringify({ args, cwd: process.cwd() }) + "\\n");
const scenario = process.env.MOCK_NPM_SCENARIO;
const spec = args[1] ?? "";
const packageName = spec.slice(0, spec.lastIndexOf("@"));
const index = [
  "@chorus-aidlc/chorus",
  "@chorus-aidlc/chorus-openclaw-plugin",
  "@chorus-aidlc/chorus-dsh",
  "@chorus-aidlc/chorus-pi",
].indexOf(packageName);

if (args.join(" ") === "config get registry") {
  console.log("https://registry.npmjs.org/");
} else if (args[0] === "config" && args[1] === "get" && args[2].endsWith(":registry")) {
  console.log(scenario === "scope-registry-hijack" ? "https://malicious.example.com/" : "undefined");
} else if (args[0] === "view" && args[2] === "version") {
  if (scenario.startsWith("first-published") && index === 0) {
    console.log(JSON.stringify("0.17.0"));
  } else if (scenario === "lookup-error-second" && index === 1) {
    console.error("E401 registry authorization failure");
    process.exitCode = 1;
  } else {
    console.error("npm error code E404");
    console.error("npm error 404 Not Found - GET " + spec);
    process.exitCode = 1;
  }
} else if (args[0] === "publish") {
  if (scenario === "publish-fail-second" && args[1].includes("chorus-openclaw-plugin")) {
    console.error("mock publish rejected");
    process.exitCode = 1;
  }
} else if (args[0] === "view" && args[2] === "dist.attestations") {
  if (scenario === "first-published-provenance-missing" && index === 0) {
    // npm prints an empty successful response when this property is not yet present.
  } else if (scenario === "first-published-provenance-not-visible" && index === 0) {
    console.error("npm error code E404");
    console.error("npm error 404 No match found for version - " + spec);
    process.exitCode = 1;
  } else if (scenario === "first-published-provenance-error" && index === 0) {
    console.error("E503 attestation metadata unavailable");
    process.exitCode = 1;
  } else {
    console.log(JSON.stringify({
      url: "https://registry.npmjs.org/-/npm/v1/attestations/example",
      provenance: { predicateType: "https://slsa.dev/provenance/v1" },
    }));
  }
} else {
  console.error("unexpected mock npm invocation: " + args.join(" "));
  process.exitCode = 2;
}
`,
  );
  await chmod(path, 0o755);
  return path;
}

async function runPublish(root, scenario) {
  const npmLog = resolve(root, `npm-${scenario}.jsonl`);
  const summary = resolve(root, `summary-${scenario}.md`);
  const npmCommand = await installMockNpm(root);
  const result = runScript(root, "publish.mjs", [releaseTag], {
    CHORUS_RELEASE_NPM_CLI: npmCommand,
    CHORUS_RELEASE_PROVENANCE_RETRY_DELAY_MS: "0",
    CHORUS_RELEASE_PROVENANCE_RETRY_ATTEMPTS: "5",
    GITHUB_STEP_SUMMARY: summary,
    MOCK_NPM_LOG: npmLog,
    MOCK_NPM_SCENARIO: scenario,
  });
  const calls = (await readMaybe(npmLog))
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
  return { result, calls, summary: await readMaybe(summary) };
}

test("release tags must be exact stable vX.Y.Z versions", () => {
  assert.equal(parseReleaseTag("v12.34.56"), "12.34.56");
  for (const invalid of [
    "1.2.3",
    "v1.2",
    "v01.2.3",
    "v1.2.3-beta.1",
    "refs/tags/v1.2.3",
    "",
  ]) {
    assert.throws(() => parseReleaseTag(invalid), /exact vX[.]Y[.]Z/);
  }
});

test("real release manifest preserves every package lifecycle and pack gate", () => {
  assert.deepEqual(
    releaseManifest.packages.map(({ directory, packageName }) => ({
      directory,
      packageName,
    })),
    packageDefinitions.map(({ directory, packageName }) => ({
      directory,
      packageName,
    })),
  );
  for (const entry of releaseManifest.packages) {
    const expected = expectedLifecycleCommands[entry.packageName];
    assert.ok(expected, `unexpected release package ${entry.packageName}`);
    for (const phase of [
      "installCommands",
      "checkCommands",
      "buildCommands",
      "packageCommands",
    ]) {
      assert.deepEqual(
        entry[phase],
        expected[phase],
        `${entry.packageName} ${phase} must retain all required gates`,
      );
    }
    assert.equal(entry.postPackCheck, expected.postPackCheck);
  }
});

test("dsh contract check bootstraps its pinned upstream on clean runners", async () => {
  const script = await readFile(
    resolve(repositoryRoot, "packages/chorus-dsh/scripts/check-dsh-contract.sh"),
    "utf8",
  );

  assert.match(script, /checkout="\$\{DSH_CHECKOUT:-\}"/);
  assert.match(script, /git clone .*--branch "\$tag"/s);
  assert.match(script, /99f6f02fecdb7dff40c3fbc9470f5907c29f74ca/);
  assert.doesNotMatch(script, /\/home\/ubuntu\/dev\/deepseek-harness/);
});

test("standard CI runs the coordinated package-contract suite", async () => {
  const workflow = await readFile(
    resolve(repositoryRoot, ".github/workflows/test.yml"),
    "utf8",
  );
  assert.match(workflow, /pnpm test:release-contract/);
});

test("name and version drift fail before any package command or artifact", async (t) => {
  for (const drift of [
    { directory: "packages/openclaw-plugin", field: "name", value: "@example/wrong" },
    { directory: "packages/chorus-dsh", field: "version", value: "0.17.1" },
  ]) {
    await t.test(`${drift.field} drift`, async (t) => {
      const root = await createFixture(t);
      const path = resolve(root, drift.directory, "package.json");
      const packageJson = JSON.parse(await readFile(path, "utf8"));
      packageJson[drift.field] = drift.value;
      await writeJson(path, packageJson);

      const result = runScript(root, "prepare.mjs", [releaseTag]);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /name must be|version must match/);
      assert.equal(await readMaybe(resolve(root, "prepare.log")), "");
      assert.equal(
        await readMaybe(resolve(root, ".release-artifacts/npm/prepare-result.json")),
        "",
      );
    });
  }
});

test("a late prepare failure leaves no publish handoff and audits unattempted state", async (t) => {
  const root = await createFixture(t, {
    failPrepareFor: "@chorus-aidlc/chorus-pi",
  });
  const summary = resolve(root, "summary.md");
  const result = runScript(root, "prepare.mjs", [releaseTag], {
    GITHUB_STEP_SUMMARY: summary,
  });
  assert.equal(result.status, 1);
  assert.equal(
    await readMaybe(resolve(root, ".release-artifacts/npm/prepare-result.json")),
    "",
  );
  const attemptedPackages = [
    ...new Set(
      (await readFile(resolve(root, "prepare.log"), "utf8"))
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line).packageName),
    ),
  ];
  assert.deepEqual(attemptedPackages, packageDefinitions.map(({ packageName }) => packageName));
  assert.match(await readFile(summary, "utf8"), /chorus-pi` \| prepare-failed/);

  const publish = runScript(root, "publish.mjs", [releaseTag]);
  assert.equal(publish.status, 1);
  assert.doesNotMatch(`${publish.stdout}\n${publish.stderr}`, /\$ npm publish/);
});

test("real npm pack prepares all four contract-shaped tarballs in fixed order", async (t) => {
  const root = await prepareFixture(t);
  const lifecycleLog = (await readFile(resolve(root, "prepare.log"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
  assert.deepEqual(
    lifecycleLog,
    releaseManifest.packages.flatMap((entry) =>
      ["installCommands", "checkCommands", "buildCommands", "packageCommands"].flatMap(
        (phase) =>
          entry[phase].map((_, index) => ({
            packageName: entry.packageName,
            phase,
            index,
          })),
      ),
    ),
  );
  const prepared = JSON.parse(
    await readFile(resolve(root, ".release-artifacts/npm/prepare-result.json"), "utf8"),
  );
  assert.deepEqual(
    prepared.packages.map(({ packageName }) => packageName),
    packageDefinitions.map(({ packageName }) => packageName),
  );
  for (const [index, entry] of prepared.packages.entries()) {
    assert.equal(entry.version, version);
    assert.match(entry.sha256, /^[a-f0-9]{64}$/);
    const files = execFileSync("tar", ["-tzf", entry.tarball], {
      encoding: "utf8",
    });
    for (const required of packageDefinitions[index].requiredFiles) {
      assert.match(files, new RegExp(`^package/${required.replaceAll(".", "[.]")}$`, "m"));
    }
  }
});

test("fresh publication uses fixed order and verifies automatic provenance", async (t) => {
  const root = await prepareFixture(t);
  const { result, calls, summary } = await runPublish(root, "all-missing");
  assert.equal(result.status, 0, result.stderr);

  const publishes = calls.filter(({ args }) => args[0] === "publish");
  assert.deepEqual(
    publishes.map(({ cwd }) => cwd),
    packageDefinitions.map(({ directory }) => resolve(root, directory)),
  );
  assert.ok(publishes.every(({ args }) => args.at(-2) === "--access" && args.at(-1) === "public"));
  assert.ok(publishes.every(({ args }) => !args.some((arg) => /provenance/i.test(arg))));
  assert.equal(
    calls.filter(({ args }) => args[2] === "dist.attestations").length,
    4,
  );
  for (const { packageName } of packageDefinitions) {
    assert.match(summary, new RegExp(`${packageName.replaceAll("/", "\\/")}\\\` \\| published`));
  }
});

test("an already-published version is skipped and remaining packages continue", async (t) => {
  const root = await prepareFixture(t);
  const { result, calls, summary } = await runPublish(root, "first-published");
  assert.equal(result.status, 0, result.stderr);
  const publishes = calls.filter(({ args }) => args[0] === "publish");
  assert.equal(publishes.length, 3);
  assert.ok(publishes[0].args[1].includes("chorus-openclaw-plugin"));
  assert.equal(
    calls.filter(
      ({ args }) =>
        args[1] === "@chorus-aidlc/chorus@0.17.0" &&
        args[2] === "dist.attestations",
    ).length,
    1,
  );
  assert.match(summary, /@chorus-aidlc\/chorus` \| skipped-already-published/);
});

test("missing provenance on an already-published version fails the rerun", async (t) => {
  const root = await prepareFixture(t);
  const { result, calls, summary } = await runPublish(
    root,
    "first-published-provenance-missing",
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /does not contain an SLSA provenance attestation/);
  assert.equal(calls.filter(({ args }) => args[0] === "publish").length, 0);
  assert.equal(
    calls.filter(({ args }) => args[2] === "dist.attestations").length,
    5,
  );
  assert.match(summary, /@chorus-aidlc\/chorus` \| failed/);
  assert.match(summary, /chorus-openclaw-plugin` \| not-attempted/);
});

test("a not-yet-visible npm version retries provenance until the budget is exhausted", async (t) => {
  const root = await prepareFixture(t);
  const { result, calls, summary } = await runPublish(
    root,
    "first-published-provenance-not-visible",
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /E404/);
  assert.equal(calls.filter(({ args }) => args[0] === "publish").length, 0);
  assert.equal(
    calls.filter(({ args }) => args[2] === "dist.attestations").length,
    5,
  );
  assert.match(summary, /@chorus-aidlc\/chorus` \| failed/);
  assert.match(summary, /chorus-openclaw-plugin` \| not-attempted/);
});

test("provenance query failure on an already-published version fails the rerun", async (t) => {
  const root = await prepareFixture(t);
  const { result, calls, summary } = await runPublish(
    root,
    "first-published-provenance-error",
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /E503 attestation metadata unavailable/);
  assert.equal(calls.filter(({ args }) => args[0] === "publish").length, 0);
  assert.equal(
    calls.filter(({ args }) => args[2] === "dist.attestations").length,
    1,
  );
  assert.match(summary, /@chorus-aidlc\/chorus` \| failed/);
  assert.match(summary, /chorus-openclaw-plugin` \| not-attempted/);
});

test("default provenance retry window tolerates slow npm registry propagation", async () => {
  const source = await readFile(resolve(sourceDirectory, "publish.mjs"), "utf8");
  assert.match(
    source,
    /CHORUS_RELEASE_PROVENANCE_RETRY_DELAY_MS\s*\?\?\s*"3000"/,
  );
  assert.match(
    source,
    /CHORUS_RELEASE_PROVENANCE_RETRY_ATTEMPTS\s*\?\?\s*"60"/,
  );
});

test("registry lookup errors stop later uploads and mark failed/not-attempted", async (t) => {
  const root = await prepareFixture(t);
  const { result, calls, summary } = await runPublish(root, "lookup-error-second");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /Unable to determine/);
  assert.equal(calls.filter(({ args }) => args[0] === "publish").length, 1);
  assert.match(summary, /chorus-openclaw-plugin` \| failed/);
  assert.match(summary, /chorus-dsh` \| not-attempted/);
});

test("publish failures stop later uploads and mark failed/not-attempted", async (t) => {
  const root = await prepareFixture(t);
  const { result, calls, summary } = await runPublish(root, "publish-fail-second");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /publish failed/);
  assert.equal(calls.filter(({ args }) => args[0] === "publish").length, 2);
  assert.match(summary, /chorus-openclaw-plugin` \| failed/);
  assert.match(summary, /chorus-dsh` \| not-attempted/);
});

test("a scope registry redirected off npmjs fails before any upload", async (t) => {
  const root = await prepareFixture(t);
  const { result, calls, summary } = await runPublish(root, "scope-registry-hijack");
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /npm publish registry \(@chorus-aidlc:registry\) must be https:\/\/registry\.npmjs\.org\//,
  );
  assert.equal(calls.filter(({ args }) => args[0] === "publish").length, 0);
  assert.equal(calls.filter(({ args }) => args[2] === "version").length, 0);
  assert.match(summary, /@chorus-aidlc\/chorus` \| failed/);
  assert.match(summary, /chorus-openclaw-plugin` \| not-attempted/);
  assert.match(summary, /chorus-dsh` \| not-attempted/);
});

test("workflow is release-only, tokenless, minimally privileged, and provenance-aware", async () => {
  const workflow = await readFile(
    resolve(repositoryRoot, ".github/workflows/publish-npm.yml"),
    "utf8",
  );
  assert.match(workflow, /release:\s*\n\s+types: \[published\]/);
  assert.doesNotMatch(workflow, /^\s+(push|pull_request):/m);
  assert.match(workflow, /permissions:\s*\n\s+contents: read\s*\n\s+id-token: write/);
  assert.doesNotMatch(workflow, /registry-url|NPM_TOKEN|NODE_AUTH_TOKEN|_authToken/);
  assert.match(workflow, /runs-on: ubuntu-latest/);
  assert.match(workflow, /node-version: ['"]24['"]/);
  assert.match(workflow, /npm install --global ['"]npm@11[.]19[.]1['"]/);
  assert.match(workflow, /CHORUS_RELEASE_EXPECT_PROVENANCE:.*repository[.]private/);
  assert.match(workflow, /prepare[.]mjs[\s\S]*publish[.]mjs/);
});
