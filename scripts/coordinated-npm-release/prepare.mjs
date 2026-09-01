#!/usr/bin/env node

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, resolve } from "node:path";
import {
  appendJobSummary,
  artifactDirectory,
  assertSuccessful,
  loadManifest,
  packageIdentity,
  parseReleaseTag,
  prepareResultPath,
  repositoryRoot,
  run,
  runFile,
  sha256,
  summaryTable,
} from "./lib.mjs";

const releaseTag = process.argv[2];
const manifest = await loadManifest();
let version = "invalid";
let currentPackage = null;
let validationDirectory = null;
const statuses = manifest.packages.map(({ packageName }) => ({
  packageName,
  status: "not-attempted",
}));

function setStatus(packageName, status) {
  statuses.find((row) => row.packageName === packageName).status = status;
}

async function validateTarball(entry, packed, tarballPath, expectedVersion) {
  if (packed.name !== entry.packageName || packed.version !== expectedVersion) {
    throw new Error(
      `${entry.packageName} tarball identity mismatch: ${packed.name}@${packed.version}`,
    );
  }

  const files = new Set((packed.files ?? []).map(({ path }) => path));
  for (const required of entry.requiredFiles) {
    if (!files.has(required)) {
      throw new Error(`${entry.packageName} tarball is missing required file ${required}`);
    }
  }
  for (const pattern of entry.forbiddenPatterns) {
    const matcher = new RegExp(pattern);
    const forbidden = [...files].find((file) => matcher.test(file));
    if (forbidden) {
      throw new Error(`${entry.packageName} tarball contains forbidden file ${forbidden}`);
    }
  }

  const packedManifest = runFile(
    "tar",
    ["-xOzf", tarballPath, "package/package.json"],
    { capture: true },
  );
  assertSuccessful(packedManifest, `${entry.packageName} packed manifest extraction`);
  const identity = JSON.parse(packedManifest.stdout);
  if (identity.name !== entry.packageName || identity.version !== expectedVersion) {
    throw new Error(`${entry.packageName} packed package.json does not match the release`);
  }

  if (entry.postPackCheck === "openclaw-plugin") {
    const packedEntry = runFile(
      "tar",
      ["-xOzf", tarballPath, "package/dist/index.js"],
      { capture: true },
    );
    assertSuccessful(packedEntry, "OpenClaw packed entry extraction");
    if (!packedEntry.stdout.includes('id: "chorus-openclaw-plugin"')) {
      throw new Error("OpenClaw packed entry does not contain the expected plugin id");
    }
  }

  if (entry.postPackCheck === "chorus-cli-smoke") {
    const installDirectory = await mkdtemp(resolve(tmpdir(), "chorus-release-smoke-"));
    try {
      runFile(
        "npm",
        [
          "install",
          "--ignore-scripts",
          "--no-audit",
          "--no-fund",
          "--no-save",
          "--prefix",
          installDirectory,
          tarballPath,
        ],
      );
      const chorus = resolve(installDirectory, "node_modules/.bin/chorus");
      const smoke = runFile(chorus, ["--version"], { capture: true });
      assertSuccessful(smoke, "Installed Chorus CLI smoke test");
      if (smoke.stdout.trim() !== expectedVersion) {
        throw new Error(
          `Installed Chorus CLI version mismatch: expected ${expectedVersion}, got ${smoke.stdout.trim()}`,
        );
      }
    } finally {
      await rm(installDirectory, { recursive: true, force: true });
    }
  }
}

try {
  version = parseReleaseTag(releaseTag);

  // Identity checks are intentionally completed for all packages before any
  // install, build, registry lookup, or publish operation.
  for (const entry of manifest.packages) {
    const identity = await packageIdentity(entry.directory);
    if (identity.name !== entry.packageName) {
      throw new Error(
        `${entry.directory}/package.json name must be ${entry.packageName}; received ${identity.name}`,
      );
    }
    if (identity.version !== version) {
      throw new Error(
        `${entry.packageName} version must match ${releaseTag}; received ${identity.version}`,
      );
    }
    if (identity.publishConfig?.registry !== undefined) {
      throw new Error(
        `${entry.packageName} must use npm's verified default registry, not publishConfig.registry`,
      );
    }
  }

  await rm(artifactDirectory, { recursive: true, force: true });
  await mkdir(artifactDirectory, { recursive: true });
  validationDirectory = await mkdtemp(resolve(tmpdir(), "chorus-release-validation-"));
  const checkEnvironment = {
    ...process.env,
    CHORUS_DAEMON_CONFIG_PATH: resolve(
      validationDirectory,
      ".chorus",
      "daemon.json",
    ),
    CHORUS_CLAUDE_SETTINGS_PATH: resolve(
      validationDirectory,
      ".claude",
      "settings.json",
    ),
  };
  delete checkEnvironment.CHORUS_AGENT_PROFILE;
  delete checkEnvironment.CHORUS_URL;
  delete checkEnvironment.CHORUS_API_KEY;
  const prepared = [];

  for (const entry of manifest.packages) {
    currentPackage = entry.packageName;
    setStatus(entry.packageName, "preparing");
    const cwd = resolve(repositoryRoot, entry.directory);
    console.log(`\n=== Prepare ${entry.label}: ${entry.packageName}@${version} ===`);

    for (const command of entry.installCommands) run(command, { cwd });
    for (const command of entry.checkCommands) {
      run(command, { cwd, env: checkEnvironment });
    }
    for (const command of entry.buildCommands) run(command, { cwd });
    for (const command of entry.packageCommands) run(command, { cwd });

    const pack = runFile(
      "npm",
      ["pack", "--ignore-scripts", "--json", "--pack-destination", artifactDirectory],
      { cwd, capture: true },
    );
    assertSuccessful(pack, `${entry.packageName} npm pack`);
    const packOutput = JSON.parse(pack.stdout);
    if (!Array.isArray(packOutput) || packOutput.length !== 1) {
      throw new Error(`${entry.packageName} npm pack returned an unexpected result`);
    }
    const packed = packOutput[0];
    const tarballPath = resolve(artifactDirectory, packed.filename);
    await validateTarball(entry, packed, tarballPath, version);

    prepared.push({
      label: entry.label,
      directory: entry.directory,
      packageName: entry.packageName,
      version,
      tarball: tarballPath,
      filename: basename(tarballPath),
      sha256: await sha256(tarballPath),
    });
    setStatus(entry.packageName, "prepared");
  }

  await writeFile(
    prepareResultPath,
    `${JSON.stringify({ releaseTag, version, packages: prepared }, null, 2)}\n`,
  );
  console.log(`\nPrepared all three packages: ${prepareResultPath}`);
} catch (error) {
  if (currentPackage) setStatus(currentPackage, "prepare-failed");
  await appendJobSummary(summaryTable(version, statuses, "Coordinated npm release preparation failed"));
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  if (validationDirectory) {
    await rm(validationDirectory, { recursive: true, force: true });
  }
}
