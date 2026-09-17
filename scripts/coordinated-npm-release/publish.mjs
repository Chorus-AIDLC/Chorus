#!/usr/bin/env node

import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  appendJobSummary,
  assertSuccessful,
  loadManifest,
  parseReleaseTag,
  prepareResultPath,
  repositoryRoot,
  runFile,
  sha256,
  summaryTable,
} from "./lib.mjs";

const releaseTag = process.argv[2];
const npmCommand = process.env.CHORUS_RELEASE_NPM_CLI || "npm";
const npmPublicRegistry = "https://registry.npmjs.org/";
const manifest = await loadManifest();
const version = parseReleaseTag(releaseTag);
const statuses = manifest.packages.map(({ packageName }) => ({
  packageName,
  status: "not-attempted",
}));
let currentPackage = null;

function setStatus(packageName, status) {
  statuses.find((row) => row.packageName === packageName).status = status;
}

async function validatePreparedResult() {
  const result = JSON.parse(await readFile(prepareResultPath, "utf8"));
  if (result.releaseTag !== releaseTag || result.version !== version) {
    throw new Error("Prepared release identity does not match the requested release tag");
  }
  const identities = result.packages?.map(({ directory, packageName, version: packageVersion }) => [
    directory,
    packageName,
    packageVersion,
  ]);
  const expected = manifest.packages.map(({ directory, packageName }) => [
    directory,
    packageName,
    version,
  ]);
  if (JSON.stringify(identities) !== JSON.stringify(expected)) {
    throw new Error("Prepared package set or order does not match the release manifest");
  }
  for (const entry of result.packages) {
    await access(entry.tarball);
    if (await sha256(entry.tarball) !== entry.sha256) {
      throw new Error(`${entry.packageName} tarball changed after preparation`);
    }
  }
  return result;
}

function npmConfigGet(key, packageName, cwd) {
  const lookup = runFile(npmCommand, ["config", "get", key], { cwd, capture: true });
  assertSuccessful(lookup, `${packageName} npm config get ${key}`);
  return lookup.stdout.trim();
}

function isRegistryUnset(value) {
  return value === "" || value === "undefined" || value === "null";
}

// npm resolves the publish target for a scoped package from `<scope>:registry`
// first, falling back to the default `registry`. Verify the *effective* target,
// not just the default — otherwise a scope-specific .npmrc could redirect the
// upload while this guard still reports npmjs.org.
function verifyPublishRegistry(packageName, cwd) {
  let source = "registry";
  let effective = npmConfigGet("registry", packageName, cwd);
  if (packageName.startsWith("@") && packageName.includes("/")) {
    const scope = packageName.slice(0, packageName.indexOf("/"));
    const scoped = npmConfigGet(`${scope}:registry`, packageName, cwd);
    if (!isRegistryUnset(scoped)) {
      source = `${scope}:registry`;
      effective = scoped;
    }
  }
  if (effective !== npmPublicRegistry) {
    throw new Error(
      `${packageName} npm publish registry (${source}) must be ${npmPublicRegistry}; received ${effective || "(empty)"}`,
    );
  }
  console.log(`${packageName} npm publish registry verified via ${source}: ${npmPublicRegistry}`);
}

function registryState(packageName, cwd) {
  const spec = `${packageName}@${version}`;
  const lookup = runFile(
    npmCommand,
    ["view", spec, "version", "--json"],
    { cwd, capture: true },
  );
  if (lookup.status === 0) {
    let publishedVersion;
    try {
      publishedVersion = JSON.parse(lookup.stdout);
    } catch {
      throw new Error(`npm registry returned invalid JSON while checking ${spec}`);
    }
    if (publishedVersion !== version) {
      throw new Error(`npm registry returned an unexpected version while checking ${spec}`);
    }
    return "published";
  }

  const output = `${lookup.stdout}\n${lookup.stderr}`;
  if (/\bE404\b/.test(output) && output.includes(spec)) return "missing";
  throw new Error(
    `Unable to determine whether ${spec} exists (exit ${lookup.status})\n${output.trim()}`,
  );
}

try {
  const prepared = await validatePreparedResult();

  for (const entry of prepared.packages) {
    currentPackage = entry.packageName;
    const packageDirectory = resolve(repositoryRoot, entry.directory);
    console.log(`\n=== Publish ${entry.packageName}@${version} ===`);
    verifyPublishRegistry(entry.packageName, packageDirectory);
    const alreadyPublished =
      registryState(entry.packageName, packageDirectory) === "published";
    if (alreadyPublished) {
      console.log(`${entry.packageName}@${version} is already published; skipping`);
    } else {
      const publish = runFile(
        npmCommand,
        ["publish", entry.tarball, "--access", "public"],
        { cwd: packageDirectory },
      );
      assertSuccessful(publish, `${entry.packageName} publish`);
      // npm can accept the upload before the version and its automatic
      // provenance appear in registry reads. Acceptance completes this step.
      console.log(`${entry.packageName}@${version} upload accepted by npm`);
    }
    setStatus(
      entry.packageName,
      alreadyPublished ? "skipped-already-published" : "accepted-by-npm",
    );
  }
} catch (error) {
  if (currentPackage) setStatus(currentPackage, "failed");
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
} finally {
  await appendJobSummary([
    summaryTable(version, statuses),
    "",
    "`accepted-by-npm` means `npm publish` exited successfully. Registry visibility",
    "and automatic provenance metadata may appear later; this job does not wait for them.",
  ].join("\n"));
}
