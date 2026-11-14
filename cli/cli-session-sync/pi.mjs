// cli/cli-session-sync/pi.mjs
// Pi session-sync adapter (cli-agent-session-sync D3). Pi is a CALLER-SUPPLIED-id
// backend like Claude: the daemon wakes a Chorus session with
// `pi --mode rpc --session-id backendSessionKey(sessionId, agentUuid)` (cli/pi-spawner.mjs
// buildPiArgs), which is create-or-resume in the cwd-scoped session store. So the CLI
// injects EXACTLY that key with Pi's interactive `--session-id <id>` and the terminal
// conversation is the one the daemon resumes. No discovery.
//
// VERIFIED against the installed pi 1.3.0 (`pi --version`; `pi --help`; the shipped
// dist/main.js + dist/core/session-manager.js; on-disk sessions) on 2026-11-09:
//   • `--session-id <id>` — "Use exact project session ID, creating it if missing" — works
//     in interactive mode (prints a one-line "No project session found … creating a new
//     session with that id" notice on first use). It is rejected together with
//     --session/--continue/--resume (exit 1), so it is never injected alongside them.
//   • Identity flags the user may pass instead: `--session <path|id>`, `--session-id`,
//     `-c/--continue`, `-r/--resume`, `--fork <path|id>`, `--no-session` (ephemeral),
//     `--session-dir <dir>` (moves the store away from where the daemon looks) → nothing
//     injected, registered + released `continuable:false`.
//   • Not conversations: subcommands install/remove/uninstall/update/list/config/auth/mcp,
//     `-h/--help`, `-v/--version`, `--export <file>`, `--list-models`. Pi's multi-letter
//     short flags (`-nc`, `-nt`, …) are NOT clusters.
//   • Store: `<sessionDir>/<ISO-ts with :. → ->_<id>.jsonl`, sessionDir = settings
//     `sessionDir` (project <cwd>/.pi/settings.json over global <agentDir>/settings.json)
//     or `<agentDir>/sessions/--<cwd without leading /, [/\\:] → ->--/`;
//     agentDir = $PI_CODING_AGENT_DIR (~ expanded) | ~/.pi/agent.
//   • Format: JSONL; line 1 `{type:"session",version:3,id,cwd}`; conversation lines are
//     `{type:"message", message:{role:"user"|"assistant"|"toolResult"|"system", content}}`
//     with Claude-shaped content blocks (text / thinking / toolCall). `custom_message`,
//     `model_change`, `thinking_level_change`, `context_edit` are not conversation.
//   • Persistence is LIVE: SessionManager._persist writes the file once the first
//     user/assistant message exists, then appendFileSync's every entry → mode "live".

import { readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { backendSessionKey } from "../backend-session-identity.mjs";
import { getAgentEnv } from "../agent-cli-config.mjs";
import { extractTranscriptText } from "../upload-hooks.mjs";
import { createJsonlTail } from "./jsonl-tail.mjs";
import { defaultInspection } from "./contract.mjs";
import { optionTokens, scanOptions } from "./argv.mjs";

export const PI_SUBCOMMANDS = Object.freeze(new Set(["install", "remove", "uninstall", "update", "list", "config", "auth", "mcp"]));
const VALUE_FLAGS = new Set(["--provider", "--model", "--api-key", "--system-prompt", "--append-system-prompt", "--mode",
  "--session", "--session-id", "--fork", "--session-dir", "--name", "-n", "--models", "--tools", "-t", "--exclude-tools", "-xt",
  "--thinking", "--extension", "-e", "--skill", "--prompt-template", "--theme", "--use-theme", "--export", "--tui-mode"]);
const IDENTITY_FLAGS = new Set(["--session", "--session-id", "-c", "--continue", "-r", "--resume", "--fork", "--no-session", "--session-dir"]);
const INFO_FLAGS = new Set(["-h", "--help", "-v", "--version", "--export", "--list-models"]);

/**
 * @param {{ args: string[], userArgs?: string[] }} input
 * @returns {import("./contract.mjs").ArgInspection}
 */
export function inspectPiArgs({ args, userArgs = [] }) {
  const result = defaultInspection();
  const { flags } = scanOptions(optionTokens(args), VALUE_FLAGS);
  for (const { name } of flags) {
    if (INFO_FLAGS.has(name)) return { ...result, sync: false, inject: false, continuable: false, reason: "info_flag" };
    if (IDENTITY_FLAGS.has(name)) {
      result.inject = false;
      result.continuable = false;
      result.reason = result.reason ?? "user_session_flag";
    }
  }
  // Pi only treats its FIRST argv token as a subcommand (`pi list`, `pi auth …`).
  if (PI_SUBCOMMANDS.has(userArgs[0]) || PI_SUBCOMMANDS.has(args[0])) {
    return { ...result, sync: false, inject: false, continuable: false, reason: "subcommand" };
  }
  return result;
}

function expandTilde(p, home) {
  if (p === "~") return home;
  if (p.startsWith("~/") || p.startsWith("~\\")) return join(home, p.slice(2));
  return p;
}

/** Pi's default per-cwd session dir (mirrors session-manager getDefaultSessionDirPath). */
export function piDefaultSessionDir(cwd, agentDir) {
  const safe = `--${resolve(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
  return join(agentDir, "sessions", safe);
}

/**
 * Every directory Pi may file this cwd's sessions in, most specific first.
 * @param {{ cwd: string, env?: NodeJS.ProcessEnv, platform?: NodeJS.Platform, args?: string[],
 *   read?: (p: string) => string }} o
 */
export function piSessionDirs(o) {
  const env = o.env ?? process.env;
  const platform = o.platform ?? process.platform;
  const read = o.read ?? ((p) => readFileSync(p, "utf8"));
  const home = getAgentEnv(env, "HOME", platform) || getAgentEnv(env, "USERPROFILE", platform) || homedir();
  const envDir = getAgentEnv(env, "PI_CODING_AGENT_DIR", platform);
  const agentDir = envDir ? expandTilde(envDir, home) : join(home, ".pi", "agent");
  const dirs = [];
  const add = (d) => {
    if (typeof d === "string" && d.trim()) {
      const expanded = expandTilde(d.trim(), home);
      dirs.push(isAbsolute(expanded) ? expanded : resolve(o.cwd, expanded));
    }
  };
  // A configured `--session-dir` (agent profile args — the daemon passes the same ones).
  const opts = optionTokens(o.args ?? []);
  for (let i = 0; i < opts.length; i += 1) {
    if (opts[i] === "--session-dir") add(opts[i + 1]);
    else if (typeof opts[i] === "string" && opts[i].startsWith("--session-dir=")) add(opts[i].slice("--session-dir=".length));
  }
  for (const file of [join(o.cwd, ".pi", "settings.json"), join(agentDir, "settings.json")]) {
    try {
      const s = JSON.parse(read(file));
      if (s && typeof s === "object") add(s.sessionDir);
    } catch {
      /* missing / unreadable settings: ignore */
    }
  }
  dirs.push(piDefaultSessionDir(o.cwd, agentDir));
  return [...new Set(dirs)];
}

/**
 * Locate `<dir>/<ts>_<id>.jsonl` for a session id (newest name wins). Never throws.
 * @returns {string|null}
 */
export function findPiSessionFile(dirs, id, readdir = (d) => readdirSync(d)) {
  const suffix = `_${String(id).toLowerCase()}.jsonl`;
  for (const dir of dirs) {
    let names;
    try {
      names = readdir(dir);
    } catch {
      continue;
    }
    const hits = names.filter((n) => typeof n === "string" && n.toLowerCase().endsWith(suffix)).sort();
    if (hits.length) return join(dir, hits.at(-1));
  }
  return null;
}

/** Map one on-disk Pi entry to a transcript message (or null). */
export function piDiskEntryToMessage(entry) {
  if (!entry || typeof entry !== "object" || entry.type !== "message") return null;
  const message = entry.message;
  if (!message || typeof message !== "object") return null;
  if (message.role !== "user" && message.role !== "assistant") return null;
  return extractTranscriptText({ type: message.role, message });
}

/**
 * @param {{ readdir?: (d: string) => string[], read?: (p: string) => string, tailFactory?: typeof createJsonlTail }} [deps]
 * @returns {import("./contract.mjs").SessionSyncAdapter}
 */
export function createPiAdapter(deps = {}) {
  const tailFactory = deps.tailFactory ?? createJsonlTail;
  const dirsFor = (ctx) => piSessionDirs({ cwd: ctx.cwd, env: ctx.env, platform: ctx.platform, args: ctx.plannedArgs, read: deps.read });
  return {
    id: "pi",
    inspectArgs: inspectPiArgs,

    prepareArgs(args, ctx) {
      if (!ctx.inspection?.inject) return { args, backendSessionId: null, continuable: false };
      if (typeof ctx.agentUuid !== "string" || !ctx.agentUuid) {
        ctx.logger.warn("[sync] pi: agent uuid unknown; cannot derive the daemon's session key");
        return { args, backendSessionId: null, continuable: false };
      }
      const key = backendSessionKey(ctx.sessionId, ctx.agentUuid);
      ctx.plannedArgs = args;
      return { args: ["--session-id", key, ...args], backendSessionId: key, continuable: true };
    },

    async discoverSessionId(ctx) {
      return ctx.backendSessionId ?? null;
    },

    transcriptSource(ctx) {
      if (!ctx.inspection?.inject || !ctx.backendSessionId) return null;
      let tail = null;
      return {
        mode: "live",
        async next() {
          if (!tail) {
            // Pi names the file `<timestamp>_<id>.jsonl` only once the first message exists.
            const path = findPiSessionFile(dirsFor(ctx), ctx.backendSessionId, deps.readdir);
            if (!path) return [];
            tail = tailFactory({ path, startAt: "beginning", logger: ctx.logger });
          }
          const out = [];
          for (const entry of tail.readNew()) {
            const msg = piDiskEntryToMessage(entry);
            if (msg) out.push(msg);
          }
          return out;
        },
      };
    },

    async finalize(ctx) {
      if (!ctx.inspection?.inject || !ctx.backendSessionId) {
        return { continuable: false, reason: ctx.inspection?.reason ?? "no_session_identity" };
      }
      // No session file → Pi never persisted a conversation (exited before any message).
      if (!findPiSessionFile(dirsFor(ctx), ctx.backendSessionId, deps.readdir)) return { continuable: false, reason: "no_transcript" };
      return { continuable: true, reason: null };
    },
  };
}

export const piAdapter = createPiAdapter();
