// cli/init/detect.mjs
// Cross-platform detection primitives for `chorus init` adapters. Dual signal:
// a CLI binary resolvable on PATH, and/or an agent config directory present.
// All IO (env, filesystem, platform, home) is injectable so adapters unit-test
// without a real machine. Zero runtime dependencies beyond node core.

import { existsSync as fsExistsSync } from "node:fs";
import { homedir } from "node:os";
import { join, delimiter as pathDelimiter } from "node:path";

/**
 * Expand a config-dir spec into an absolute path:
 *   - a leading `~` → the home directory,
 *   - a leading `$VAR` segment → env[VAR] (whole spec dropped if unset),
 * Returns null when the spec cannot be resolved (e.g. `$DSH_HOME` unset).
 * @param {string} spec
 * @param {{ env?: Record<string,string|undefined>, home?: string }} [deps]
 * @returns {string | null}
 */
export function expandPath(spec, { env = process.env, home = homedir() } = {}) {
  if (typeof spec !== "string" || !spec) return null;
  if (spec.startsWith("~")) {
    return join(home, spec.slice(1).replace(/^[/\\]/, ""));
  }
  if (spec.startsWith("$")) {
    const slash = spec.search(/[/\\]/);
    const varName = (slash === -1 ? spec.slice(1) : spec.slice(1, slash));
    const value = env[varName];
    if (!value) return null; // unset env var → this candidate does not apply
    const rest = slash === -1 ? "" : spec.slice(slash + 1);
    return rest ? join(value, rest) : value;
  }
  return spec;
}

/**
 * True if any of `names` resolves to an executable on PATH. Scans PATH entries
 * and (on Windows) the PATHEXT extension list. Pure lookup — never executes.
 * @param {string[]} names  candidate binary base names (e.g. ["claude"])
 * @param {{
 *   env?: Record<string,string|undefined>,
 *   existsSync?: (p: string) => boolean,
 *   platform?: NodeJS.Platform,
 * }} [deps]
 * @returns {boolean}
 */
export function binaryOnPath(names, { env = process.env, existsSync = fsExistsSync, platform = process.platform } = {}) {
  const rawPath = env.PATH ?? env.Path ?? "";
  if (!rawPath) return false;
  const sep = platform === "win32" ? ";" : pathDelimiter;
  const dirs = rawPath.split(sep).filter(Boolean);
  const exts =
    platform === "win32"
      ? ["", ...String(env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";").filter(Boolean)]
      : [""];
  for (const name of names) {
    if (!name) continue;
    for (const dir of dirs) {
      for (const ext of exts) {
        // Windows filesystems are case-insensitive; try the ext as-given.
        if (existsSync(join(dir, name + ext))) return true;
      }
    }
  }
  return false;
}

/**
 * True if any of the config-dir specs (after expandPath) exists on disk.
 * @param {string[]} specs
 * @param {{
 *   env?: Record<string,string|undefined>,
 *   existsSync?: (p: string) => boolean,
 *   home?: string,
 * }} [deps]
 * @returns {boolean}
 */
export function configDirPresent(specs, { env = process.env, existsSync = fsExistsSync, home = homedir() } = {}) {
  for (const spec of specs || []) {
    const resolved = expandPath(spec, { env, home });
    if (resolved && existsSync(resolved)) return true;
  }
  return false;
}

/**
 * Compute the dual-signal detection for one agent descriptor.
 * @param {{ binaries: string[], configDirs: string[] }} descriptor
 * @param {object} [deps]  forwarded to binaryOnPath / configDirPresent
 * @returns {{ binaryOnPath: boolean, configDirPresent: boolean }}
 */
export function detectSignals(descriptor, deps = {}) {
  return {
    binaryOnPath: binaryOnPath(descriptor.binaries || [], deps),
    configDirPresent: configDirPresent(descriptor.configDirs || [], deps),
  };
}
