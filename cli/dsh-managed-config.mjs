// Managed dsh profile composition for the daemon's `dsh --profile sdk` backend.
//
// dsh 0.1.2-rc.1 replaced the standalone `dsh-jsonrpc-agent` bin + hand-authored
// `cordis.yml` (DSH_CORDIS_CONFIG) model with a profile launcher: `dsh --profile
// sdk` boots the `sdk` profile under `$DSH_HOME/profiles/sdk` — an ordered stack
// of plugin-bundle patch layers (dsh-base + dsh-sdk-app, the latter mounting the
// `@deepseek-ai/dsh-sdk-jsonrpc-server` runtime that owns stdout). Chorus is a
// native dsh bundle: `dsh plugin --profile sdk add @chorus-aidlc/chorus-dsh -w`
// appends it to the profile's `dsh.profile.bundles` list, so its own
// `cordis.patch.yml` (the chorus-dsh-lifecycle, chorus-mcp, chorus-skill-filesystem
// and chorus-persona rows) auto-applies as a bundle layer — no `--patch` needed for
// the Chorus rows, and pnpm auto-installs chorus-dsh's peers (mcp-client, persona,
// skill-filesystem, tool-skill).
//
// The owner chose external_runtime: the `dsh` CLI itself comes from PATH /
// CHORUS_DSH_PATH and is NEVER installed into the managed home. We only COMPOSE a
// managed profile home under ~/.chorus/dsh/releases/<fingerprint>-<uuid>/ and hand
// its path back as the child's DSH_HOME. Credentials reach the chorus-mcp row via
// the CHORUS_URL / CHORUS_API_KEY the spawner injects into the child env (the
// chorus-dsh-lifecycle plugin's documented fallback also reads $DSH_HOME/.env).

import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export const DSH_BUNDLE = "@chorus-aidlc/chorus-dsh";
/** The shipped profile template the daemon boots: dsh-base + dsh-sdk-app. */
export const DSH_PROFILE = "sdk";
export const DSH_RC_VERSION = "0.1.2-rc.1";
/** The JSON-RPC runtime identity the SDK profile reports on `initialize`. */
export const RUNTIME_IDENTITY = "deepseek-harness-sdk-runtime";
/** The provider served out-of-the-box by the base profile (no overlay needed). */
export const DEFAULT_DSH_PROVIDER = "deepseek-official";

// Bumped from 1: active.json now records a managed DSH_HOME (+ optional --patch
// path) instead of a configPath/runtimePath pair. An old marker fails the shape
// check in activeState() and is transparently re-prepared.
const STATE_VERSION = 2;

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function redactedErrorText(error, values = []) {
  let text = errorText(error);
  for (const value of values) {
    if (typeof value === "string" && value) text = text.replaceAll(value, "[REDACTED]");
  }
  return text;
}

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

export function managedDshRoot(env = process.env) {
  const home = env.HOME || env.USERPROFILE || homedir();
  return join(home, ".chorus", "dsh");
}

/**
 * Build the optional `--patch` overlay for a non-default provider. The base
 * profile serves `deepseek-official` unchanged, so that (and an empty value)
 * yields `null` — no overlay, no `--patch`. For any other provider we emit a
 * minimal overlay selecting it as the profile's default-model provider by
 * targeting the base `agent-default-model` row (always present, so the tree
 * still composes and the structural `initialize` probe still passes). Provider
 * routing + credentials are exercised only on a live turn — a guarded extension
 * point, not a verified path. Keep this small.
 * @param {string} provider
 * @returns {{ fileName: string, yaml: string } | null}
 */
export function buildProviderPatch(provider) {
  const value = typeof provider === "string" ? provider.trim() : "";
  if (!value || value === DEFAULT_DSH_PROVIDER) return null;
  const yaml =
    `# Chorus-generated provider overlay (CHORUS_DSH_PROVIDER=${value}).\n` +
    `# Applied after the profile layer via \`dsh --profile ${DSH_PROFILE} --patch\`.\n` +
    `- id: agent-default-model\n` +
    `  config:\n` +
    `    provider: ${JSON.stringify(value)}\n`;
  return { fileName: "chorus-provider.patch.yml", yaml };
}

/** Windows npm/cmd shims need cmd.exe while retaining argv isolation. */
function runCommand(command, argv, opts) {
  const platform = opts.platform ?? process.platform;
  const isCmd = platform === "win32" && /\.(cmd|bat)$/i.test(command);
  const executable = isCmd ? opts.env?.ComSpec || opts.env?.COMSPEC || "cmd.exe" : command;
  const commandArgs = isCmd ? ["/d", "/s", "/c", command, ...argv] : argv;
  const result = spawnSync(executable, commandArgs, {
    cwd: opts.cwd,
    env: opts.env,
    encoding: "utf8",
    shell: false,
    timeout: opts.timeout,
    input: opts.input,
    windowsHide: true,
  });
  if (result.error || result.status !== 0) {
    const detail = result.error?.message || result.stderr?.trim() || `exit ${result.status}`;
    throw new Error(detail);
  }
  return result;
}

/**
 * Cheap structural check that a prepared home actually carries the composed
 * profile: its manifest lists the Chorus bundle and the package is installed.
 * Runs on both a fresh prepare and every reuse (fast — no dsh spawn).
 * @param {string} home managed DSH_HOME
 */
export function validateManagedDshProfile(home, opts = {}) {
  const pathExists = opts.profileExists ?? existsSync;
  const readManifest = opts.readJson ?? readJson;
  const profileDir = join(home, "profiles", DSH_PROFILE);
  const manifest = readManifest(join(profileDir, "package.json"));
  const bundles = manifest?.dsh?.profile?.bundles;
  if (!Array.isArray(bundles) || !bundles.includes(DSH_BUNDLE)) {
    throw new Error(`dsh managed profile is missing the ${DSH_BUNDLE} bundle layer`);
  }
  const bundlePkg = join(profileDir, "node_modules", ...DSH_BUNDLE.split("/"), "package.json");
  if (!pathExists(bundlePkg)) {
    throw new Error(`dsh managed profile did not install ${DSH_BUNDLE}`);
  }
  return { profileDir, bundles };
}

/**
 * Drive one JSON-RPC `initialize` over stdin against `dsh --profile sdk` (with
 * any provider `--patch`) and assert the SDK runtime answers with the expected
 * identity. `initialize` makes no LLM/network call, so this needs no real
 * credentials or provider routing — it structurally confirms the composed tree
 * loads and the JSON-RPC server owns stdout. Uses the DEFAULT provider for the
 * probe regardless of any configured override (routing is a live-turn concern).
 * @param {string} home managed DSH_HOME
 */
export function validateManagedDshComposition(home, opts = {}) {
  const dshPath = opts.dshPath;
  if (!dshPath) throw new Error("cannot validate dsh composition: the dsh CLI was not found");
  const env = {
    ...(opts.env ?? process.env),
    CHORUS_DAEMON_HEADLESS: "1",
    CHORUS_URL: opts.creds?.url ?? "http://127.0.0.1",
    CHORUS_API_KEY: opts.creds?.apiKey ?? "cho_validation",
    DSH_HOME: home,
    DSH_CWD: home,
  };
  const argv = ["--profile", DSH_PROFILE, ...(opts.patchPath ? ["--patch", opts.patchPath] : [])];
  const request = `${JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { cwd: home, provider: DEFAULT_DSH_PROVIDER, model: "deepseek-v4-flash" },
  })}\n`;
  const runner = opts.runCommand ?? runCommand;
  const result = runner(dshPath, argv, {
    cwd: home,
    env,
    input: request,
    timeout: opts.timeoutMs ?? 30_000,
    platform: opts.platform,
  });
  const stdout = String(result.stdout ?? "");
  if (!stdout.includes('"id":1')) {
    throw new Error("dsh composition validation did not complete JSON-RPC initialization");
  }
  if (!stdout.includes(RUNTIME_IDENTITY)) {
    throw new Error("dsh composition validation returned an unexpected server identity");
  }
}

function activeState(root, pathExists = existsSync) {
  const state = readJson(join(root, "active.json"));
  if (!state || state.version !== STATE_VERSION || typeof state.home !== "string") return null;
  if (!pathExists(state.home)) return null;
  if (state.patchPath && !pathExists(state.patchPath)) return null;
  return state;
}

/**
 * Ensure a validated managed dsh profile home exists and return where it lives.
 * Reuses the last-known-good release when the fingerprint (profile + Chorus
 * bundle spec + dsh RC + provider) is unchanged; otherwise composes a fresh
 * release in an isolated dir, validates it, and atomically flips active.json.
 * A failed fresh prepare rolls back and leaves the prior marker intact.
 *
 * @returns {Promise<{ version:number, fingerprint:string, home:string,
 *   patchPath:(string|null), validatedAt:string, reused:boolean }>}
 */
export async function prepareManagedDshConfig(opts = {}) {
  const env = opts.env ?? process.env;
  const root = opts.root ?? managedDshRoot(env);
  const bundleVersion = opts.bundleVersion;
  if (!bundleVersion) throw new Error("dsh managed preparation requires a Chorus bundle version");
  const dshPath = opts.dshPath;
  if (!dshPath) {
    throw new Error("dsh managed preparation requires the dsh CLI (install dsh or set CHORUS_DSH_PATH)");
  }
  // Bundle spec passed to `dsh plugin --profile sdk add`. Defaults to the
  // published `@chorus-aidlc/chorus-dsh@<appVersion>`. `CHORUS_DSH_BUNDLE_SPEC`
  // overrides it with any pnpm-installable spec — a local package dir, a packed
  // tarball, or a pinned version — so a pre-publish local build can be composed
  // and tested end-to-end against a real dsh runtime without publishing first.
  // Unset in production. `opts.bundleSpec` (tests) still wins over the env.
  const bundleSpec =
    opts.bundleSpec ?? nonEmpty(env.CHORUS_DSH_BUNDLE_SPEC) ?? `${DSH_BUNDLE}@${bundleVersion}`;
  const provider = nonEmpty(env.CHORUS_DSH_PROVIDER) ?? nonEmpty(env.DSH_PROVIDER) ?? DEFAULT_DSH_PROVIDER;
  const providerPatch = buildProviderPatch(provider);
  const fingerprint = createHash("sha256")
    .update(JSON.stringify({ version: STATE_VERSION, profile: DSH_PROFILE, bundleSpec, dshRc: DSH_RC_VERSION, provider }))
    .digest("hex")
    .slice(0, 16);
  const current = activeState(root, opts.statePathExists ?? existsSync);

  if (current?.fingerprint === fingerprint) {
    await (opts.validateProfile ?? validateManagedDshProfile)(current.home, opts);
    return { ...current, reused: true };
  }

  const releaseDir = join(root, "releases", `${fingerprint}-${randomUUID()}`);
  const markerTmp = join(root, `.active-${randomUUID()}.json`);
  mkdirSync(releaseDir, { recursive: true });
  try {
    // Compose the managed profile with the EXTERNAL dsh CLI: `dsh plugin
    // --profile sdk add <bundle> -w`. `-w` is required — the profile dir is a
    // pnpm workspace root, so pnpm refuses a bare `add` (ERR_PNPM_ADDING_TO_ROOT).
    // This initializes profiles/sdk (base + sdk-app), appends the Chorus bundle
    // to its bundle list, and installs it plus its peers.
    const runner = opts.runCommand ?? runCommand;
    const install = opts.install ?? ((home) => runner(
      dshPath,
      ["plugin", "--profile", DSH_PROFILE, "add", bundleSpec, "-w"],
      { cwd: home, env: { ...env, DSH_HOME: home }, timeout: opts.installTimeoutMs ?? 300_000, platform: opts.platform },
    ));
    try {
      install(releaseDir);
    } catch (error) {
      throw new Error(
        `dsh managed profile installation failed: ` +
          redactedErrorText(error, [env.CHORUS_API_KEY, opts.creds?.apiKey]),
      );
    }

    await (opts.validateProfile ?? validateManagedDshProfile)(releaseDir, opts);

    let patchPath = null;
    if (providerPatch) {
      patchPath = join(releaseDir, providerPatch.fileName);
      writeFileSync(patchPath, providerPatch.yaml, { mode: 0o600 });
    }

    try {
      (opts.validateComposition ?? validateManagedDshComposition)(releaseDir, {
        ...opts,
        dshPath,
        patchPath,
      });
    } catch (error) {
      throw new Error(
        `dsh managed composition validation failed: ` +
          redactedErrorText(error, [env.CHORUS_API_KEY, opts.creds?.apiKey]),
      );
    }

    const state = {
      version: STATE_VERSION,
      fingerprint,
      home: releaseDir,
      patchPath,
      validatedAt: new Date().toISOString(),
    };
    mkdirSync(root, { recursive: true });
    writeFileSync(markerTmp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
    renameSync(markerTmp, join(root, "active.json"));
    return { ...state, reused: false };
  } catch (error) {
    rmSync(markerTmp, { force: true });
    rmSync(releaseDir, { recursive: true, force: true });
    throw error;
  }
}
