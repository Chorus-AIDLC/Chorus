import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { runCommand } from "./run-command.mjs";
import {
  PI_SUPPORTED_RANGE, PI_MIN_SUPPORTED_VERSION, PI_MAX_SUPPORTED_MAJOR,
  PI_NATIVE_MCP_MIN_VERSION, PI_LEGACY_ADAPTER_SPEC,
} from "./pi-compatibility.mjs";

export const PI_CHORUS_SPEC = "npm:@chorus-aidlc/chorus-pi";
const ADAPTER = "npm:pi-mcp-adapter";
const object = (value) => value && typeof value === "object" && !Array.isArray(value);
const compare = (left, right) => {
  for (let index = 0; index < 3; index++) {
    if (left[index] !== right[index]) return left[index] - right[index];
  }
  return 0;
};

export function parsePiVersion(output) {
  const unknown = { mode: "unknown", version: null, supported: null,
    reason: "Pi version unknown; run pi --version and confirm a stable supported host before completing MCP setup." };
  if (typeof output !== "string") return unknown;
  const matches = [...output.matchAll(/(?<![\w.+-])v?(\d+)\.(\d+)\.(\d+)(-[\w.-]+)?(?:\+[\w.-]+)?(?![\w.+-])/g)];
  if (matches.length !== 1) return unknown;
  const match = matches[0];
  const parts = match.slice(1, 4).map(Number);
  if (match[4] || parts.some((part) => !Number.isSafeInteger(part)) || match.slice(1, 4).some((part) => /^0\d/.test(part))) return unknown;
  const version = parts.join(".");
  const mode = compare(parts, PI_NATIVE_MCP_MIN_VERSION) >= 0 ? "native" : "legacy";
  const supported = compare(parts, PI_MIN_SUPPORTED_VERSION) >= 0 && parts[0] < PI_MAX_SUPPORTED_MAJOR;
  return { mode, version, supported, reason: supported ? `Pi ${version}: ${mode} MCP backend.`
    : `Pi ${version} is unsupported; Chorus requires stable Pi ${PI_SUPPORTED_RANGE}. No package commands were run.` };
}

export function probePiBackend({ run = runCommand, env = process.env, cwd } = {}) {
  try {
    const result = run("pi", ["--version"], { env, cwd, timeoutMs: 5_000 });
    return parsePiVersion(result?.ok ? result.stdout : undefined);
  } catch {
    return parsePiVersion(undefined);
  }
}

export function piAgentDir(env = process.env) {
  return env.PI_CODING_AGENT_DIR?.trim() || join(env.HOME || homedir(), ".pi", "agent");
}

export function piPackageSource(entry, spec) {
  const source = typeof entry === "string" ? entry : object(entry) ? entry.source : undefined;
  return typeof source === "string" && (source === spec || (source.startsWith(`${spec}@`) && source.length > spec.length + 1)) ? source : undefined;
}

function readSettings(path) {
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return undefined; throw error; }
}

export function inspectPiSettings({ env = process.env, cwd = process.cwd(), readJson = readSettings } = {}) {
  const scopes = [
    { scope: "global", path: join(piAgentDir(env), "settings.json") },
    { scope: "current-project", path: join(cwd, ".pi", "settings.json") },
  ];
  return scopes.map((entry) => {
    try {
      const settings = readJson(entry.path);
      if (settings !== undefined && (!object(settings) ||
        (settings.packages !== undefined && (!Array.isArray(settings.packages) || settings.packages.some((pkg) =>
          typeof pkg !== "string" && !(object(pkg) && typeof pkg.source === "string")))) ||
        (settings.extensions !== undefined && (!Array.isArray(settings.extensions) || settings.extensions.some((extension) => typeof extension !== "string"))))) throw new Error();
      const packages = settings?.packages ?? [];
      return { ...entry, packages, adapters: packages.map((pkg) => piPackageSource(pkg, ADAPTER)).filter(Boolean),
        chorus: packages.map((pkg) => piPackageSource(pkg, PI_CHORUS_SPEC)).filter(Boolean),
        nativeDisabled: settings?.extensions?.includes("-builtin:mcp") ?? false, uncertain: false };
    } catch {
      return { ...entry, packages: [], adapters: [], chorus: [], nativeDisabled: false, uncertain: true };
    }
  });
}

export function piMigrationWarnings(backend, scopes) {
  const warnings = [];
  for (const entry of scopes) {
    if (entry.uncertain) warnings.push(`Cannot safely read ${entry.scope} Pi settings; package/MCP conflict state is uncertain. Inspect that settings.json manually.`);
    if (backend.mode !== "native" || backend.supported === false) continue;
    if (entry.adapters.length) warnings.push(`The ${entry.scope} pi-mcp-adapter replaces native MCP. To use native MCP, manually remove its package entry from ${entry.scope} settings.json (preserve other packages and filters); no adapter was removed or updated.`);
    if (entry.nativeDisabled) warnings.push(`Native MCP is disabled by -builtin:mcp in ${entry.scope} settings.json. Manually re-enable it before expecting native tools; the filter was preserved.`);
  }
  return warnings;
}

export function readPiPackageState(options = {}) {
  const scopes = inspectPiSettings(options);
  const global = scopes[0];
  const backend = options.backend ?? probePiBackend(options);
  const chorusPiInstalled = global.chorus.length > 0;
  const adapterInstalled = global.adapters.length > 0;
  const adapterCompatible = adapterInstalled && global.adapters.every((source) => source === PI_LEGACY_ADAPTER_SPEC);
  return { marketplaceRegistered: false, chorusPiInstalled, adapterInstalled, adapterCompatible, backend, scopes,
    pluginInstalled: backend.supported === true && chorusPiInstalled && (backend.mode === "native" || adapterCompatible) };
}

export function managePiPackages({ backend, scopes, run = runCommand, env = process.env, cwd, update = false }) {
  const warnings = piMigrationWarnings(backend, scopes);
  const details = [backend.reason, ...warnings];
  const global = scopes[0];
  let complete = backend.supported === true, changed = false, failed = false;
  const finish = () => ({ complete, changed, failed, warnings, detail: details.join(" ") });
  if (backend.supported === false || global.uncertain) {
    complete = false;
    return finish();
  }
  const components = backend.mode === "legacy"
    ? [{ spec: PI_LEGACY_ADAPTER_SPEC, sources: global.adapters, adapter: true }, { spec: PI_CHORUS_SPEC, sources: global.chorus }]
    : [{ spec: PI_CHORUS_SPEC, sources: global.chorus }];
  const help = new Map();
  for (const component of components) {
    const { spec, sources, adapter } = component;
    const present = sources.length > 0;
    if (adapter && present && sources.some((source) => source !== PI_LEGACY_ADAPTER_SPEC)) {
      complete = false;
      details.push(`Legacy adapter constraints/source are not the verified ${PI_LEGACY_ADAPTER_SPEC} policy pin; settings preserved. Review compatibility manually; latest/ranges are not verified.`);
      continue;
    }
    if (present && !update) continue;
    if (adapter && present) {
      details.push(`Retained verified compatibility pin ${PI_LEGACY_ADAPTER_SPEC}; no unbounded adapter update.`);
      continue;
    }
    if (present && sources.some((source) => source !== spec && source !== `${spec}@latest`)) {
      complete = false;
      details.push("Chorus version constraints preserved; latest refresh incomplete. Other eligible components were attempted.");
      continue;
    }
    const operation = present ? "update" : "install";
    if (!help.has(operation)) {
      const result = run("pi", [operation, "--help"], { env, cwd });
      help.set(operation, result?.ok && /--no-approve\b/.test(result.stdout) &&
        (operation !== "update" || /--extension\s+<source>/.test(result.stdout)));
    }
    if (!help.get(operation)) {
      complete = false;
      details.push(`Pi targeted ${operation} unsupported; no all-extension update was run.`);
      continue;
    }
    const args = present ? ["update", "--extension", sources[0], "--no-approve"] : ["install", spec, "--no-approve"];
    changed = true;
    let result;
    try { result = run("pi", args, { env, cwd }); } catch { result = { ok: false }; }
    if (!result?.ok) {
      complete = false;
      failed = true;
      details.push(`Pi ${operation} failed for ${adapter ? "the compatibility adapter" : "Chorus"}; setup incomplete.`);
      if (adapter && !update) break;
    }
  }
  if (complete) details.push(`${changed ? "Refreshed" : "Already installed"} required ${backend.mode} packages only; MCP connectivity is not verified.`);
  else details.push("MCP setup incomplete; resolve the diagnostics and rerun.");
  return finish();
}
