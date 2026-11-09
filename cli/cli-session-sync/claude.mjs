// cli/cli-session-sync/claude.mjs
// Claude Code session-sync adapter (cli-agent-session-sync D3).
//
// Resume identity: the daemon resumes a Chorus session `sessionId` with
// `backendSessionKey(sessionId, agentUuid)` (cli/claude-spawner.mjs #wake) and probes
// `<CLAUDE_CONFIG_DIR|~/.claude>/projects/<escapeCwd(cwd)>/<key>.jsonl` to choose
// `--session-id` (new) vs `--resume` (continue). So the CLI injects EXACTLY that key as
// `--session-id <key>` — computed with the shared helper, never reimplemented — and the
// transcript lands where the daemon's probe looks.
//
// Flags verified against the installed Claude Code 2.1.289 (`claude --help`):
//   -r, --resume [value] · -c, --continue · --session-id <uuid> · --fork-session ·
//   --from-pr [value] · --bg/--background · -w, --worktree [name] (runs in a different
//   cwd) · -v, --version · -h, --help · subcommands agents|attach|auth|auto-mode|doctor|
//   gateway|import|install|logs|mcp|plugin|plugins|purge|respawn|rm|setup-token|stop|
//   kill|ultrareview|update|upgrade.
// A user-supplied session/resume/fork/background/worktree flag means the conversation's
// identity (or cwd) is not the derived key: nothing is injected and the session is
// registered + released `continuable:false`.
//
// Transcript (verified against on-disk 2.1.289 JSONL): one JSON object per line;
// conversation lines are `type:"user"|"assistant"` with a `message` in the same shape
// as stream-json. Non-conversation lines (attachment, queue-operation, ai-title,
// last-prompt, cost-state, …) are dropped by the shared extractor's type gate. On disk
// the harness-synthetic marker is `isMeta:true` (stream-json says `isSynthetic`), so it
// is mapped onto `isSynthetic` before reusing the daemon's `extractTranscriptText`
// filter (drops tool_use/tool_result/thinking blocks, synthetic turns, system-reminder
// spans). Sub-agent sidechains live in separate files (and are flagged `isSidechain`);
// task-notification / system-originated user lines are not human input.

import { existsSync } from "node:fs";
import { backendSessionKey } from "../backend-session-identity.mjs";
import { transcriptPath, isValidSessionId } from "../claude-spawner.mjs";
import { extractTranscriptText } from "../upload-hooks.mjs";
import { createJsonlTail } from "./jsonl-tail.mjs";
import { defaultInspection } from "./contract.mjs";

export const CLAUDE_SUBCOMMANDS = Object.freeze(new Set([
  "agents", "attach", "auth", "auto-mode", "doctor", "gateway", "import", "install", "logs",
  "mcp", "plugin", "plugins", "purge", "respawn", "rm", "setup-token", "stop", "kill",
  "ultrareview", "update", "upgrade", "config", "migrate-installer",
]));

/** Long flags that set/choose the conversation identity (or its cwd) themselves. */
const IDENTITY_LONG_FLAGS = ["--session-id", "--resume", "--continue", "--fork-session", "--from-pr", "--bg", "--background", "--worktree"];
/** Short flags (also inside clusters like `-pc`) with the same effect: resume, continue, worktree. */
const IDENTITY_SHORT = new Set(["r", "c", "w"]);
const INFO_SHORT = new Set(["v", "h"]);

/** Local-only command/shell echo wrappers the TUI writes as user lines — terminal plumbing, not conversation. */
const LOCAL_ECHO_RE = /^\s*<(local-command-stdout|local-command-stderr|local-command-caveat|bash-stdout|bash-stderr)>/;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function longFlagName(tok) {
  const eq = tok.indexOf("=");
  return eq === -1 ? tok : tok.slice(0, eq);
}

/**
 * Inspect the planned argv (configured + user args, already merged by planAgentArgs).
 * Only tokens before claude's own `--` are options.
 * @param {{ args: string[], userArgs?: string[] }} input
 * @returns {import("./contract.mjs").ArgInspection}
 */
export function inspectClaudeArgs({ args, userArgs = [] }) {
  const result = defaultInspection();
  const first = userArgs[0];
  if (typeof first === "string" && CLAUDE_SUBCOMMANDS.has(first)) {
    return { ...result, sync: false, inject: false, continuable: false, reason: "subcommand" };
  }
  const end = args.indexOf("--");
  const opts = end === -1 ? args : args.slice(0, end);
  for (let i = 0; i < opts.length; i += 1) {
    const tok = opts[i];
    if (typeof tok !== "string" || !tok.startsWith("-") || tok === "-") continue;
    if (tok.startsWith("--")) {
      const name = longFlagName(tok);
      if (name === "--version" || name === "--help") {
        return { ...result, sync: false, inject: false, continuable: false, reason: "info_flag" };
      }
      if (IDENTITY_LONG_FLAGS.includes(name)) {
        result.inject = false;
        result.continuable = false;
        result.reason = result.reason ?? "user_session_flag";
        if (name === "--session-id" || name === "--resume") {
          const value = tok.includes("=") ? tok.slice(tok.indexOf("=") + 1) : opts[i + 1];
          if (typeof value === "string" && UUID_RE.test(value)) {
            result.userSessionId = value.toLowerCase();
            result.userResume = name === "--resume";
          }
        }
      }
      continue;
    }
    // Short flag or cluster (`-r`, `-pc`, `-r <id>`).
    const letters = tok.slice(1);
    if (!/^[A-Za-z]+$/.test(letters)) continue;
    if ([...letters].some((ch) => INFO_SHORT.has(ch))) {
      return { ...result, sync: false, inject: false, continuable: false, reason: "info_flag" };
    }
    if ([...letters].some((ch) => IDENTITY_SHORT.has(ch))) {
      result.inject = false;
      result.continuable = false;
      result.reason = result.reason ?? "user_session_flag";
      if (letters.endsWith("r")) {
        const value = opts[i + 1];
        if (typeof value === "string" && UUID_RE.test(value)) {
          result.userSessionId = value.toLowerCase();
          result.userResume = true;
        }
      }
    }
  }
  return result;
}

/**
 * Map one on-disk Claude JSONL entry to a transcript message (or null), reusing the
 * daemon's stream-json filter.
 * @param {any} entry
 * @returns {import("./contract.mjs").SyncMessage|null}
 */
export function claudeDiskEntryToMessage(entry) {
  if (!entry || typeof entry !== "object") return null;
  if (entry.type !== "user" && entry.type !== "assistant") return null;
  if (entry.isSidechain === true || entry.isCompactSummary === true) return null;
  if (entry.type === "user") {
    if (entry.promptSource === "system") return null;
    const originKind = entry.origin && typeof entry.origin === "object" ? entry.origin.kind : undefined;
    if (typeof originKind === "string" && originKind !== "human") return null;
  }
  const normalized = entry.type === "user" && entry.isMeta === true ? { ...entry, isSynthetic: true } : entry;
  const msg = extractTranscriptText(normalized);
  if (!msg) return null;
  if (msg.role === "user" && LOCAL_ECHO_RE.test(msg.text)) return null;
  return msg;
}

/** The session id this run's transcript is filed under (derived key or the user's own id). */
function transcriptSessionId(ctx) {
  if (ctx.inspection?.inject) return ctx.backendSessionId;
  return ctx.inspection?.userSessionId ?? null;
}

/**
 * @param {{ exists?: (p: string) => boolean, tailFactory?: typeof createJsonlTail }} [deps]
 * @returns {import("./contract.mjs").SessionSyncAdapter}
 */
export function createClaudeAdapter(deps = {}) {
  const exists = deps.exists ?? existsSync;
  const tailFactory = deps.tailFactory ?? createJsonlTail;
  return {
    id: "claude-code",
    inspectArgs: inspectClaudeArgs,

    prepareArgs(args, ctx) {
      if (!ctx.inspection?.inject) {
        return { args, backendSessionId: ctx.inspection?.userSessionId ?? null, continuable: false };
      }
      const key = backendSessionKey(ctx.sessionId, ctx.agentUuid);
      if (!isValidSessionId(key)) {
        ctx.logger.warn("[sync] derived Claude session key is not a valid UUID; launching without injection");
        return { args, backendSessionId: null, continuable: false };
      }
      return { args: ["--session-id", key, ...args], backendSessionId: key, continuable: true };
    },

    async discoverSessionId(ctx) {
      return ctx.backendSessionId ?? null;
    },

    transcriptSource(ctx) {
      const id = transcriptSessionId(ctx);
      if (!id) return null;
      const path = transcriptPath(id, ctx.cwd, { env: ctx.env, platform: ctx.platform });
      // A user `--resume <id>` attaches to existing history: sync only what this run adds.
      const tail = tailFactory({ path, startAt: ctx.inspection?.userResume ? "end" : "beginning", logger: ctx.logger });
      return {
        mode: "live",
        async next() {
          const out = [];
          for (const entry of tail.readNew()) {
            const msg = claudeDiskEntryToMessage(entry);
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
      // No transcript under the derived key → claude never started a conversation
      // (e.g. it failed at startup); there is nothing for the daemon to resume.
      const path = transcriptPath(ctx.backendSessionId, ctx.cwd, { env: ctx.env, platform: ctx.platform });
      if (!exists(path)) return { continuable: false, reason: "no_transcript" };
      return { continuable: true, reason: null };
    },
  };
}

export const claudeAdapter = createClaudeAdapter();
