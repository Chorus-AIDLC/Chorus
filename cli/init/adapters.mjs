// cli/init/adapters.mjs
// The per-agent adapters `chorus init` configures. One descriptor per supported
// coding-agent harness; buildAdapter() turns each into an AgentAdapter
// (contracts.mjs). Detection is shared (cli/init/detect.mjs); the plugin-install
// mechanism (descriptor.install) is added by the plugin-install task — until
// then installPlugin reports "unsupported" rather than guessing a command.
//
// LAYOUT PROVENANCE (binary + config dir), so future edits don't drift into
// LLM-guessed paths (verified against each agent's real CLI / install-*.sh):
//   - claude   : bin `claude`;   dir ~/.claude              (this machine + docs/CONNECT_CLAUDE_CODE.md)
//   - codex    : bin `codex`;    dir ~/.codex               (public/install-codex.sh: CODEX_HOME=$HOME/.codex)
//   - kiro     : bin `kiro`;     dir ~/.kiro                (public/install-kiro.sh: ~/.kiro global)
//   - opencode : bin `opencode`; dir ~/.config/opencode     (public/install-opencode.sh: OPENCODE_CONFIG_DIR)
//   - openclaw : bin `openclaw`; dir ~/.openclaw|~/.config/openclaw  (NOT independently verified — probe both; see NOTE)
//   - pi       : bin `pi`;       dir ~/.pi|~/.config/pi       (NOT independently verified — probe both; see NOTE)
//   - dsh      : bin `dsh`;      dir $DSH_HOME|~/.dsh         ($DSH_HOME per dsh integration; see NOTE)
//
// NOTE: openclaw / pi / dsh config-dir specifics were not verifiable on this
// build host (their CLIs/config were not all present); the descriptors probe the
// most likely locations. A wrong config-dir guess only weakens the *config-dir*
// half of the dual signal (the binary-on-PATH half still detects them) and never
// blocks selection — undetected agents remain selectable. The plugin-install
// task must still verify each install command against the real CLI.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { detectSignals } from "./detect.mjs";
import { OUTCOME_ACTIONS } from "./contracts.mjs";
import { CHORUS_PLUGIN_ID, CHORUS_MARKETPLACE_NAME, CHORUS_MARKETPLACE_SOURCE } from "./chorus-plugin-consts.mjs";
import {
  installClaude,
  installCodex,
  installOpencode,
  installDsh,
  readCodexInstallState,
  readOpencodeInstallState,
  readDshInstallState,
  guided,
  GUIDED_MESSAGES,
} from "./install-methods.mjs";

// Re-export the shared marketplace identifiers from their canonical home so
// existing importers of these names from adapters.mjs keep working.
export { CHORUS_PLUGIN_ID, CHORUS_MARKETPLACE_NAME, CHORUS_MARKETPLACE_SOURCE };

/** Read + JSON-parse a file, or null on any error. Never throws. */
function readJsonSafe(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Claude Code install-state reader (verified against CC 2.1.235 on-disk layout):
 * `~/.claude/plugins/installed_plugins.json` (v2 keyed by `<plugin>@<marketplace>`)
 * and `known_marketplaces.json`. Read-only — never hand-writes these files.
 * @param {{ home?: string, readJson?: (p: string) => any }} [deps]
 * @returns {{ marketplaceRegistered: boolean, pluginInstalled: boolean, version?: string }}
 */
export function readClaudeInstallState({ home = homedir(), readJson = readJsonSafe } = {}) {
  const pluginsDir = join(home, ".claude", "plugins");
  const installed = readJson(join(pluginsDir, "installed_plugins.json"));
  const markets = readJson(join(pluginsDir, "known_marketplaces.json"));

  const marketplaceRegistered = !!(markets && typeof markets === "object" && markets[CHORUS_MARKETPLACE_NAME]);

  let pluginInstalled = false;
  let version;
  const entries = installed && typeof installed === "object" ? installed.plugins?.[CHORUS_PLUGIN_ID] : null;
  if (Array.isArray(entries) && entries.length > 0) {
    pluginInstalled = true;
    version = entries[0]?.version;
  }
  return { marketplaceRegistered, pluginInstalled, version };
}

/**
 * The supported-agent descriptors. `install` / `readState` are optional hooks the
 * plugin-install task fills in per agent; absent ⇒ generic behavior.
 * @type {Array<{
 *   id: string, displayName: string, binaries: string[], configDirs: string[],
 *   readState?: (deps: object) => object, install?: (ctx: object) => object,
 * }>}
 */
export const AGENT_DESCRIPTORS = [
  { id: "claude", displayName: "Claude Code", binaries: ["claude"], configDirs: ["~/.claude"], readState: readClaudeInstallState, install: installClaude },
  { id: "codex", displayName: "Codex CLI", binaries: ["codex"], configDirs: ["~/.codex"], readState: readCodexInstallState, install: installCodex },
  { id: "kiro", displayName: "Kiro CLI", binaries: ["kiro"], configDirs: ["~/.kiro"], install: guided("kiro", GUIDED_MESSAGES.kiro) },
  { id: "opencode", displayName: "opencode", binaries: ["opencode"], configDirs: ["~/.config/opencode", "~/.opencode"], readState: readOpencodeInstallState, install: installOpencode },
  { id: "openclaw", displayName: "OpenClaw", binaries: ["openclaw"], configDirs: ["~/.openclaw", "~/.config/openclaw"], install: guided("openclaw", GUIDED_MESSAGES.openclaw) },
  { id: "pi", displayName: "Pi", binaries: ["pi"], configDirs: ["~/.pi", "~/.config/pi"], install: guided("pi", GUIDED_MESSAGES.pi) },
  { id: "dsh", displayName: "DeepSeek Harness (dsh)", binaries: ["dsh"], configDirs: ["$DSH_HOME", "~/.dsh"], readState: readDshInstallState, install: installDsh },
];

/**
 * Build an AgentAdapter from a descriptor.
 * @param {typeof AGENT_DESCRIPTORS[number]} d
 * @returns {import("./contracts.mjs").AgentAdapter}
 */
export function buildAdapter(d) {
  return {
    id: d.id,
    displayName: d.displayName,
    detect: (env = process.env) => detectSignals(d, { env }),
    readInstallState: (deps = {}) => {
      const base = typeof d.readState === "function"
        ? d.readState(deps)
        : { marketplaceRegistered: false, pluginInstalled: false };
      // `supported` = an automated install path exists for this agent (wired by
      // the plugin-install task via descriptor.install).
      return { supported: typeof d.install === "function", ...base };
    },
    installPlugin: (ctx = {}) =>
      typeof d.install === "function"
        ? d.install(ctx)
        : {
            stepId: "plugin-install",
            agentId: d.id,
            action: OUTCOME_ACTIONS.UNSUPPORTED,
            detail: `no automated plugin install for ${d.displayName} yet — configure manually`,
          },
  };
}

/** All supported adapters, built from the descriptors. */
export const ADAPTERS = AGENT_DESCRIPTORS.map(buildAdapter);
