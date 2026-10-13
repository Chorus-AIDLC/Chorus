// cli/codex-family.mjs
// Profiles for backends that speak the Codex App Server protocol. TRAE CLI
// (`traecli`) is a Codex fork; one shared spawner implementation is parameterized
// by these frozen profiles so Codex behavior stays byte-identical while TRAE gets
// its own executable, home/config paths, local maps, labels and wake-error source.
//
// This module is the single source of the Codex/TRAE names, paths and env vars
// used by runtime spawn, path resolution and config probing. Verified baselines:
//   docs/verification/codex-app-server-protocol.md   (codex-cli 0.157.1)
//   docs/verification/trae-app-server-0.209.1.md     (traecli 0.209.1)

import { statSync } from "node:fs";
import { win32 as pathWin32, posix as pathPosix } from "node:path";
import { getAgentEnv } from "./agent-cli-config.mjs";

const freezeProfile = (profile) => Object.freeze({
  ...profile,
  binaries: Object.freeze({
    posix: Object.freeze([...profile.binaries.posix]),
    win32: Object.freeze([...profile.binaries.win32]),
  }),
});

export const CODEX_FAMILY = Object.freeze({
  codex: freezeProfile({
    agentType: "codex",
    displayName: "Codex",
    binaries: { posix: ["codex"], win32: ["codex.cmd", "codex.exe", "codex"] },
    pathEnv: "CHORUS_CODEX_PATH",
    homeEnv: "CODEX_HOME",
    homeDir: ".codex",
    configFile: "config.toml",
    sessionMapFile: "codex-sessions.json",
    usageMapFile: "codex-usage.json",
    wakeErrorSource: "codex",
    clientType: "codex",
    marketplaceSourceEnv: "CHORUS_MARKETPLACE_SOURCE_CODEX",
    minVersion: "0.157.1",
    // Codex 0.157.1 accepts `excludeTurns` on thread/resume without the
    // experimental capability, so old turn contents are not returned.
    resumeExcludeTurns: true,
  }),
  trae: freezeProfile({
    agentType: "trae",
    displayName: "TRAE CLI",
    binaries: { posix: ["traecli"], win32: ["traecli.cmd", "traecli.exe", "traecli"] },
    pathEnv: "CHORUS_TRAE_PATH",
    homeEnv: "TRAE_HOME",
    homeDir: ".trae",
    configFile: "traecli.toml",
    sessionMapFile: "trae-sessions.json",
    usageMapFile: "trae-usage.json",
    wakeErrorSource: "trae",
    clientType: "trae",
    marketplaceSourceEnv: "CHORUS_MARKETPLACE_SOURCE_TRAE",
    minVersion: "0.209.1",
    // traecli 0.209.1 rejects `excludeTurns` with -32600 "thread/resume.excludeTurns
    // requires experimentalApi capability"; Chorus never opts into experimental APIs.
    resumeExcludeTurns: false,
  }),
});

/** Profile for an agent type, or null when it is not a Codex-family backend. */
export function codexFamilyProfile(agentType) {
  return Object.hasOwn(CODEX_FAMILY, agentType) ? CODEX_FAMILY[agentType] : null;
}

/**
 * Resolve a Codex-family executable WITHOUT a shell. On Windows the bin may be
 * an npm `.cmd` shim, which `spawn` can't exec directly without shell:true, so we
 * walk PATH for the platform candidates. `profile.pathEnv` overrides when it
 * names an existing file.
 * @param {typeof CODEX_FAMILY.codex} profile
 * @param {{ env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform, isFile?: (p: string) => boolean }} [deps]
 * @returns {string | null}
 */
export function resolveFamilyPath(profile, deps = {}) {
  const env = deps.env ?? process.env;
  const platform = deps.platform ?? process.platform;
  const isFile =
    deps.isFile ??
    ((p) => {
      try {
        return statSync(p).isFile();
      } catch {
        return false;
      }
    });

  const override = getAgentEnv(env, profile.pathEnv, platform);
  if (override && isFile(override)) {
    return override;
  }

  const isWin = platform === "win32";
  const p = isWin ? pathWin32 : pathPosix;
  const names = isWin ? profile.binaries.win32 : profile.binaries.posix;
  const pathVar = getAgentEnv(env, "PATH", platform) || env.Path || "";
  const dirs = pathVar.split(p.delimiter).filter(Boolean);
  for (const dir of dirs) {
    for (const name of names) {
      const candidate = p.join(dir, name);
      if (isFile(candidate)) return candidate;
    }
  }
  return null;
}
