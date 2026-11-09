// cli/cli-session-sync/codex.mjs
// Codex + TRAE CLI session-sync adapters (cli-agent-session-sync D3). Both CLIs are the
// Codex App Server family (cli/codex-family.mjs): they GENERATE their thread id, and the
// daemon (CodexSpawner) resumes a Chorus session only through the per-profile session
// map entry keyed `backendSessionKey(sessionId, agentUuid)` — it refuses legacy
// raw-anchor entries of unknown ownership. So this adapter injects nothing; it
// discovers the thread this run created and writes exactly that keyed entry
// (~/.chorus/codex-sessions.json | ~/.chorus/trae-sessions.json, via familySessionMap).
//
// VERIFIED against the installed CLIs on this host (2026-11-09, live TUI runs in a pty
// plus the on-disk stores) — not taken from the design text:
//
//   codex-cli 0.167.0 (`codex --version`)
//     store   $CODEX_HOME|~/.codex/sessions/YYYY/MM/DD/rollout-<local-ts>-<threadId>.jsonl
//             (local-time date dirs; state_5.sqlite `threads.rollout_path` points at it).
//     line 1  {type:"session_meta", payload:{id, session_id, timestamp(ISO), cwd,
//             originator:"codex-tui", source:"cli"|"vscode"|{subagent:…}, cli_version}}.
//             Daemon App Server threads carry originator "chorus"; sub-agent threads a
//             `source.subagent` object — both are never candidates.
//     lazy    the TUI creates the rollout on the FIRST user message (an idle TUI that
//             exits writes nothing → not continuable), then APPENDS records as the turn
//             runs (observed growing in ~1 s steps) → transcript mode "live".
//     text    `event_msg` payload.type "item_completed" with payload.item
//             {type:"UserMessage", content:[{type:"text",text}]} /
//             {type:"AgentMessage", content:[{type:"Text",text}], phase}. response_item
//             user messages also carry harness context (<environment_context>, skills) and
//             are NOT used.
//     flags   interactive: `codex [OPTIONS] [PROMPT]`; resume/fork are SUBCOMMANDS
//             (`codex resume [SESSION_ID]`, `codex fork`); `-C/--cd <DIR>`, `--worktree`
//             and `--remote <ADDR>` move the thread off this cwd/host; -h/--help,
//             -V/--version are info.
//
//   traecli 0.209.1 (`traecli --version`; rollouts record cli_version 0.209.1)
//     store   $TRAECLI_HOME|$TRAE_HOME/cli|~/.trae/cli/sessions/YYYY/MM/DD/rollout-*.jsonl
//             (same naming; data lives under ~/.trae/cli, config in ~/.trae/traecli.toml).
//     line 1  session_meta with originator "traex-tui", source "cli".
//     lazy    rollout created at the first user turn and appended live → "live".
//     text    paginated-history dialect: `history_mutation` records whose
//             payload.display_completions[].item is the same UserMessage / AgentMessage
//             item shape (plus `event_msg item_completed` for tool items).
//     flags   `--resume [ID]`, `--session-id <ID>` ("legacy compatibility flag for
//             selecting or naming the session" — live run: it only NAMES the thread, the
//             thread id is still generated), `-w/--worktree [NAME]`, `-C/--cd`,
//             `--remote`, `--acp` (ACP server, not a conversation), resume/fork
//             subcommands; -h/--help, -V/--version.
//
// Discovery = launch cwd + created at/after launch + not daemon/sub-agent + single free
// candidate (cli/cli-session-sync/self-id.mjs). Any store/format surprise fails soft:
// no candidate → released `continuable:false`; unknown records → no transcript text.

import { closeSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { CODEX_FAMILY } from "../codex-family.mjs";
import { familySessionMap } from "../codex-session-map.mjs";
import { getAgentEnv } from "../agent-cli-config.mjs";
import { createJsonlTail } from "./jsonl-tail.mjs";
import { defaultInspection } from "./contract.mjs";
import { optionTokens, scanOptions } from "./argv.mjs";
import { createSelfIdBinding } from "./self-id.mjs";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Clock slack between "launchedAt" (taken just before spawn) and the CLI's own timestamp. */
export const DISCOVERY_SKEW_MS = 2_000;
const FIRST_LINE_MAX = 4 * 1024 * 1024;

const SHARED_VALUE_FLAGS = ["-c", "--config", "--enable", "--disable", "--remote", "--remote-auth-token-env",
  "-i", "--image", "-m", "--model", "--local-provider", "-p", "--profile", "-s", "--sandbox", "-C", "--cd",
  "--add-dir", "-a", "--ask-for-approval"];

/** Per-backend argv tables (verified against the installed --help output, see header). */
export const CODEX_ARGV = Object.freeze({
  codex: {
    subcommands: new Set(["agents", "exec", "e", "review", "login", "logout", "mcp", "mcp-server", "plugin", "app-server",
      "remote-control", "completion", "update", "doctor", "sandbox", "debug", "apply", "a", "resume", "queue", "archive",
      "delete", "migrate-rollouts", "migrate-nfs-db", "unarchive", "fork", "cloud", "exec-server", "features", "help"]),
    // Conversation subcommands that are still synced (exec runs a persisted thread).
    conversationSubcommands: new Set(["exec", "e"]),
    identitySubcommands: new Set(["resume", "fork"]),
    valueFlags: new Set(SHARED_VALUE_FLAGS),
    identityFlags: new Set(["-C", "--cd", "--worktree", "--remote"]),
    infoFlags: new Set(["-h", "--help", "-V", "--version"]),
    nonConversationFlags: new Set(),
  },
  trae: {
    subcommands: new Set(["worktree-apply", "dashboard", "exec", "e", "review", "login", "update", "logout", "mcp", "plugin",
      "channel", "acp", "app-server", "remote-control", "completion", "sandbox", "debug", "models", "apply", "a", "resume",
      "fork", "archive", "migrate-rollouts", "queue", "delete", "unarchive", "exec-server", "features", "doctor", "migrate", "help"]),
    conversationSubcommands: new Set(["exec", "e"]),
    identitySubcommands: new Set(["resume", "fork"]),
    valueFlags: new Set([...SHARED_VALUE_FLAGS, "--session-id", "--worktree-base", "--worktree-mode", "--permission-mode",
      "--shell-tool-timeout", "--allowed-tool", "--disallowed-tool", "--disabled-tool"]),
    identityFlags: new Set(["-C", "--cd", "-w", "--worktree", "--remote", "--resume", "--session-id"]),
    infoFlags: new Set(["-h", "--help", "-V", "--version"]),
    nonConversationFlags: new Set(["--acp"]),
  },
});

/**
 * @param {keyof typeof CODEX_ARGV} family
 * @returns {(input: { args: string[], userArgs?: string[] }) => import("./contract.mjs").ArgInspection}
 */
export function makeCodexInspector(family) {
  const t = CODEX_ARGV[family];
  return ({ args }) => {
    const result = defaultInspection();
    // Self-generated ids: there is never anything to inject.
    result.inject = false;
    const { flags, positional } = scanOptions(optionTokens(args), t.valueFlags);
    for (const { tok, name } of flags) {
      // `-C<dir>` attached short-value form.
      const short = tok.startsWith("-C") && !tok.startsWith("--") ? "-C" : name;
      if (t.infoFlags.has(short)) return { ...result, sync: false, continuable: false, reason: "info_flag" };
      if (t.nonConversationFlags.has(short)) return { ...result, sync: false, continuable: false, reason: "subcommand" };
      if (t.identityFlags.has(short)) {
        result.continuable = false;
        result.reason = result.reason ?? "user_session_flag";
      }
    }
    if (positional && t.subcommands.has(positional)) {
      if (t.identitySubcommands.has(positional)) {
        return { ...result, continuable: false, reason: "user_session_flag" };
      }
      if (!t.conversationSubcommands.has(positional)) return { ...result, sync: false, continuable: false, reason: "subcommand" };
    }
    return result;
  };
}

/** Session-store roots to scan for a profile, deduplicated, in priority order. */
export function rolloutRoots(profile, env = process.env, platform = process.platform) {
  const home = getAgentEnv(env, "HOME", platform) || getAgentEnv(env, "USERPROFILE", platform) || homedir();
  const roots = [];
  if (profile.agentType === "trae") {
    const cliHome = getAgentEnv(env, "TRAECLI_HOME", platform);
    const traeHome = getAgentEnv(env, profile.homeEnv, platform);
    if (cliHome) roots.push(join(cliHome, "sessions"));
    if (traeHome) roots.push(join(traeHome, "cli", "sessions"));
    if (!cliHome && !traeHome) roots.push(join(home, profile.homeDir, "cli", "sessions"));
  } else {
    const codexHome = getAgentEnv(env, profile.homeEnv, platform);
    roots.push(join(codexHome || join(home, profile.homeDir), "sessions"));
  }
  return [...new Set(roots)];
}

/** Local-time `YYYY/MM/DD` day dirs from (from - 1 day) to (to + 1 day). */
export function dayDirs(fromMs, toMs) {
  const out = [];
  const pad = (n) => String(n).padStart(2, "0");
  const start = new Date(fromMs - DAY_MS);
  start.setHours(0, 0, 0, 0);
  for (let d = start; d.getTime() <= toMs + DAY_MS; d = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1)) {
    out.push(join(String(d.getFullYear()), pad(d.getMonth() + 1), pad(d.getDate())));
  }
  return out;
}

/** First line of a file (bounded), or null. */
function readFirstLine(path, fs) {
  let fd;
  try {
    fd = fs.openSync(path, "r");
    const chunks = [];
    let total = 0;
    while (total < FIRST_LINE_MAX) {
      const buf = Buffer.alloc(64 * 1024);
      const n = fs.readSync(fd, buf, 0, buf.length, total);
      if (!n) break;
      const nl = buf.subarray(0, n).indexOf(0x0a);
      if (nl !== -1) {
        chunks.push(buf.subarray(0, nl));
        return Buffer.concat(chunks).toString("utf8");
      }
      chunks.push(buf.subarray(0, n));
      total += n;
    }
    return null; // no complete first line yet (being written) or oversized
  } catch {
    return null;
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        /* ignore */
      }
    }
  }
}

const sameDir = (a, b) => {
  try {
    return resolve(a) === resolve(b);
  } catch {
    return false;
  }
};

/**
 * Parse a rollout's session_meta line into a discovery candidate, or null when it is not
 * an eligible user thread. Exported for tests.
 * @returns {{ id: string, path: string, cwd: string, createdAt: number, originator: string|null }|null}
 */
export function parseSessionMeta(line, path) {
  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }
  if (!obj || obj.type !== "session_meta" || !obj.payload || typeof obj.payload !== "object") return null;
  const p = obj.payload;
  const id = typeof p.id === "string" && p.id ? p.id : typeof p.session_id === "string" ? p.session_id : null;
  if (!id || typeof p.cwd !== "string") return null;
  if (p.originator === "chorus") return null; // the daemon's own App Server threads
  if (p.source && typeof p.source === "object") return null; // sub-agent / spawned threads
  if (typeof p.thread_source === "string" && p.thread_source !== "user") return null;
  const createdAt = Date.parse(p.timestamp ?? obj.timestamp ?? "");
  return { id, path, cwd: p.cwd, createdAt: Number.isFinite(createdAt) ? createdAt : NaN, originator: p.originator ?? null };
}

/**
 * Scan the store for threads created in `cwd` at/after `launchedAt`. Never throws.
 * @param {{ roots: string[], cwd: string, launchedAt: number, now?: number,
 *   fs?: { readdirSync: Function, statSync: Function, openSync: Function, readSync: Function, closeSync: Function },
 *   cache?: Map<string, any> }} o
 */
export function scanRollouts(o) {
  const fs = o.fs ?? { readdirSync, statSync, openSync, readSync, closeSync };
  const cache = o.cache ?? new Map();
  const cutoff = o.launchedAt - DISCOVERY_SKEW_MS;
  const out = [];
  for (const root of o.roots) {
    for (const day of dayDirs(o.launchedAt, o.now ?? Date.now())) {
      const dir = join(root, day);
      let names;
      try {
        names = fs.readdirSync(dir);
      } catch {
        continue; // no such day yet
      }
      for (const name of names) {
        if (!name.startsWith("rollout-") || !name.endsWith(".jsonl")) continue;
        const path = join(dir, name);
        let meta = cache.get(path);
        if (meta === undefined) {
          let st;
          try {
            st = fs.statSync(path);
          } catch {
            continue;
          }
          if (st.mtimeMs < cutoff) continue; // untouched since before launch: not ours (re-checked next scan)
          const line = readFirstLine(path, fs);
          if (line === null) continue; // still being written — retry next scan
          meta = parseSessionMeta(line, path);
          cache.set(path, meta);
        }
        if (!meta) continue;
        if (!sameDir(meta.cwd, o.cwd)) continue;
        if (!(meta.createdAt >= cutoff)) continue;
        out.push(meta);
      }
    }
  }
  return out;
}

/** Text of one rollout UserMessage / AgentMessage item, or null. */
function itemToMessage(item) {
  if (!item || typeof item !== "object") return null;
  const role = item.type === "UserMessage" ? "user" : item.type === "AgentMessage" ? "assistant" : null;
  if (!role || !Array.isArray(item.content)) return null;
  const text = item.content
    .filter((b) => b && typeof b === "object" && (b.type === "text" || b.type === "Text") && typeof b.text === "string")
    .map((b) => b.text)
    .join("");
  return text.trim() ? { role, text } : null;
}

/**
 * Conversation items carried by one rollout record (Codex `event_msg item_completed`
 * and TRAE `history_mutation display_completions`). Exported for tests.
 * @returns {Array<{ id: string|null, item: any }>}
 */
export function rolloutItems(record) {
  if (!record || typeof record !== "object" || !record.payload || typeof record.payload !== "object") return [];
  const p = record.payload;
  if (record.type === "event_msg" && p.type === "item_completed" && p.item) return [{ id: p.item.id ?? null, item: p.item }];
  if (record.type === "history_mutation" && Array.isArray(p.display_completions)) {
    return p.display_completions.filter((d) => d && d.item).map((d) => ({ id: d.item.id ?? null, item: d.item }));
  }
  return [];
}

/** Stateful record → message mapper (dedupes items seen in more than one record). */
export function createRolloutMessageMapper() {
  const seen = new Set();
  return (record) => {
    const out = [];
    for (const { id, item } of rolloutItems(record)) {
      if (id) {
        if (seen.has(id)) continue;
        seen.add(id);
      }
      const msg = itemToMessage(item);
      if (msg) out.push(msg);
    }
    return out;
  };
}

/**
 * @param {typeof CODEX_FAMILY.codex} profile
 * @param {{ sessionMap?: ReturnType<typeof familySessionMap>, mapDeps?: object, fs?: any,
 *   now?: () => number, tailFactory?: typeof createJsonlTail }} [deps]
 * @returns {import("./contract.mjs").SessionSyncAdapter}
 */
export function createCodexFamilyAdapter(profile, deps = {}) {
  const sessionMap = deps.sessionMap ?? familySessionMap(profile);
  const tailFactory = deps.tailFactory ?? createJsonlTail;
  const now = deps.now ?? Date.now;
  /** @type {WeakMap<object, { binding: ReturnType<typeof createSelfIdBinding>, cache: Map<string, any> }>} */
  const runs = new WeakMap();

  const runFor = (ctx) => {
    let run = runs.get(ctx);
    if (!run) {
      const cache = new Map();
      const mapDeps = { logger: ctx.logger, ...(deps.mapDeps ?? {}) };
      run = {
        cache,
        binding: createSelfIdBinding({
          label: profile.agentType,
          listCandidates: (c) => scanRollouts({
            roots: rolloutRoots(profile, c.env, c.platform), cwd: c.cwd, launchedAt: c.launchedAt, now: now(), fs: deps.fs, cache,
          }),
          map: {
            entries: () => sessionMap.entries(mapDeps),
            set: (k, v) => sessionMap.set(k, v, mapDeps),
            remove: (k, v) => sessionMap.remove(k, v, mapDeps),
          },
        }),
      };
      runs.set(ctx, run);
    }
    return run;
  };

  return {
    id: profile.agentType,
    inspectArgs: makeCodexInspector(profile.agentType),

    prepareArgs(args, ctx) {
      const canBind = ctx.inspection?.continuable !== false && runFor(ctx).binding.keyFor(ctx) !== null;
      return { args, backendSessionId: null, continuable: canBind };
    },

    async discoverSessionId(ctx) {
      if (ctx.inspection?.continuable === false) return null; // user-chosen thread / cwd: never bind
      return runFor(ctx).binding.discover(ctx);
    },

    transcriptSource(ctx) {
      const cand = runFor(ctx).binding.candidate();
      if (!cand) return null;
      const tail = tailFactory({ path: cand.path, startAt: "beginning", logger: ctx.logger });
      const map = createRolloutMessageMapper();
      return {
        mode: "live",
        async next() {
          const out = [];
          for (const record of tail.readNew()) out.push(...map(record));
          return out;
        },
      };
    },

    async finalize(ctx) {
      if (ctx.inspection?.continuable === false) return { continuable: false, reason: ctx.inspection.reason ?? "user_session_flag" };
      return runFor(ctx).binding.finalize(ctx);
    },
  };
}

export const codexAdapter = createCodexFamilyAdapter(CODEX_FAMILY.codex);
export const traeAdapter = createCodexFamilyAdapter(CODEX_FAMILY.trae);
