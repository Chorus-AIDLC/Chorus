import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

export const scriptDirectory = dirname(fileURLToPath(import.meta.url));
export const repositoryRoot = resolve(scriptDirectory, "../..");
export const artifactDirectory = resolve(repositoryRoot, ".release-artifacts/npm");
export const prepareResultPath = resolve(artifactDirectory, "prepare-result.json");

const expectedPackages = [
  [".", "@chorus-aidlc/chorus"],
  ["packages/openclaw-plugin", "@chorus-aidlc/chorus-openclaw-plugin"],
  ["packages/chorus-dsh", "@chorus-aidlc/chorus-dsh"],
];

export async function loadManifest() {
  const manifest = JSON.parse(
    await readFile(resolve(scriptDirectory, "manifest.json"), "utf8"),
  );
  const identities = manifest.packages?.map(({ directory, packageName }) => [
    directory,
    packageName,
  ]);
  if (JSON.stringify(identities) !== JSON.stringify(expectedPackages)) {
    throw new Error(
      "Release manifest must contain exactly Chorus CLI, OpenClaw, and dsh in publish order",
    );
  }
  return manifest;
}

export function parseReleaseTag(tag) {
  const match = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(tag);
  if (!match) {
    throw new Error(`Release tag must be an exact vX.Y.Z version; received ${JSON.stringify(tag)}`);
  }
  return tag.slice(1);
}

export function run(
  command,
  { cwd = repositoryRoot, capture = false, env = process.env } = {},
) {
  console.log(`$ ${command}`);
  const result = spawnSync(command, {
    cwd,
    env,
    encoding: "utf8",
    shell: true,
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = capture
      ? `\n${[result.stdout, result.stderr].filter(Boolean).join("\n").trim()}`
      : "";
    throw new Error(`Command failed with exit code ${result.status}: ${command}${detail}`);
  }
  return capture ? result.stdout.trim() : "";
}

export function runFile(command, args, { cwd = repositoryRoot, capture = false } = {}) {
  console.log(`$ ${command} ${args.join(" ")}`);
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.error) throw result.error;
  return result;
}

export async function packageIdentity(packageDirectory) {
  const packageJsonPath = resolve(repositoryRoot, packageDirectory, "package.json");
  return JSON.parse(await readFile(packageJsonPath, "utf8"));
}

export async function sha256(file) {
  return createHash("sha256").update(await readFile(file)).digest("hex");
}

export function assertSuccessful(result, description) {
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join("\n").trim();
    throw new Error(`${description} failed with exit code ${result.status}${detail ? `\n${detail}` : ""}`);
  }
}

export async function appendJobSummary(markdown) {
  if (process.env.GITHUB_STEP_SUMMARY) {
    const { appendFile } = await import("node:fs/promises");
    await appendFile(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
  } else {
    console.log(markdown);
  }
}

export function summaryTable(version, rows, heading = "Coordinated npm release") {
  return [
    `## ${heading}`,
    "",
    `Release version: \`${version}\``,
    "",
    "| Package | Status |",
    "| --- | --- |",
    ...rows.map(({ packageName, status }) => `| \`${packageName}\` | ${status} |`),
  ].join("\n");
}
