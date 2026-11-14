// cli/cli-session-sync/kiro.mjs
// Kiro CLI session-sync adapter (cli-agent-session-sync D3). Kiro GENERATES its session
// id, so nothing is injected: the adapter discovers the session this interactive run
// created, writes the Kiro session map entry under the key the daemon's KiroSpawner
// looks up (`backendSessionKey(sessionId, agentUuid)`, ~/.chorus/kiro-sessions.json),
// and records OWNERSHIP (agentUuid + anchor, cli/kiro-session-ownership.mjs) — without
// that record KiroSpawner refuses to resume any mapped session.
//
// VERIFICATION STATUS: `kiro-cli` is NOT installed on the host this adapter was written
// on (2026-11-09; `kiro-cli --version` → command not found). Paths, formats and flags
// come from the repo's Kiro code verified live against kiro-cli 2.12.1
// (cli/kiro-spawner.mjs, cli/kiro-transcript.mjs) and its fixtures:
//   • store  `$HOME/.kiro/sessions/cli/<sessionId>.json` (metadata: session_id, cwd,
//            created_at, updated_at, parent_session_id) + `<sessionId>.jsonl` (lines
//            `{kind:"Prompt"|"AssistantMessage"|…, data:{content:[{kind:"text",data}]}}`).
//            ONLY interactive/TUI runs persist there; `chat --no-interactive` does not.
//   • child  reviewer sub-agents get their own session with parent_session_id set — never
//            a discovery candidate and not part of the synced transcript.
//   • flags  interactive = bare `kiro-cli` or `kiro-cli chat`; `--resume/-r`,
//            `--resume-id <id>`, `--resume-picker` reuse an EXISTING session (registered
//            not continuable); `--no-interactive` persists nothing (not continuable);
//            `--list-sessions`, `--delete-session`, `-h/--help`, `-V/--version` and the
//            non-chat subcommands are not conversations.
// Transcript mode is "on_exit": the jsonl is reconstructed once after the child exits
// with kiro-transcript.mjs's parser (no live-append guarantee was verifiable without the
// CLI). Re-verify paths/flags and consider "live" when kiro-cli is available.

import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { kiroSessionsDir } from "../kiro-spawner.mjs";
import { parseSessionJsonl } from "../kiro-transcript.mjs";
import { kiroSessionMap } from "../kiro-session-map.mjs";
import { recordKiroSessionOwnership } from "../kiro-session-ownership.mjs";
import { extractTranscriptText } from "../upload-hooks.mjs";
import { defaultInspection } from "./contract.mjs";
import { optionTokens, scanOptions } from "./argv.mjs";
import { createSelfIdBinding } from "./self-id.mjs";
import { DISCOVERY_SKEW_MS } from "./codex.mjs";

export const KIRO_SUBCOMMANDS = Object.freeze(new Set(["agent", "doctor", "login", "logout", "whoami", "profile", "settings",
  "setup", "init", "update", "diagnostic", "issue", "mcp", "translate", "inline", "integrations", "user", "theme", "version",
  "dashboard", "acp", "help"]));
const VALUE_FLAGS = new Set(["--agent", "--model", "--trust-tools", "--resume-id", "--delete-session", "--wrap", "--profile"]);
const IDENTITY_FLAGS = new Set(["--resume", "-r", "--resume-id", "--resume-picker"]);
const HEADLESS_FLAGS = new Set(["--no-interactive"]);
const INFO_FLAGS = new Set(["-h", "--help", "-V", "--version", "--list-sessions", "--delete-session"]);

/**
 * @param {{ args: string[], userArgs?: string[] }} input
 * @returns {import("./contract.mjs").ArgInspection}
 */
export function inspectKiroArgs({ args }) {
  const result = { ...defaultInspection(), inject: false };
  const { flags, positional } = scanOptions(optionTokens(args), VALUE_FLAGS);
  if (positional && KIRO_SUBCOMMANDS.has(positional)) return { ...result, sync: false, continuable: false, reason: "subcommand" };
  for (const { name } of flags) {
    if (INFO_FLAGS.has(name)) return { ...result, sync: false, continuable: false, reason: "info_flag" };
    if (IDENTITY_FLAGS.has(name)) {
      result.continuable = false;
      result.reason = result.reason ?? "user_session_flag";
    }
    if (HEADLESS_FLAGS.has(name)) {
      result.continuable = false;
      result.reason = result.reason ?? "headless_not_persisted";
    }
  }
  return result;
}

const sameDir = (a, b) => {
  try {
    return resolve(a) === resolve(b);
  } catch {
    return false;
  }
};

/**
 * Root Kiro sessions of `cwd` created at/after `launchedAt`. Never throws.
 * @param {{ dir: string, cwd: string, launchedAt: number, readdir?: (d: string) => string[], read?: (p: string) => string }} o
 * @returns {Array<{ id: string, createdAt: number }>}
 */
export function scanKiroSessions(o) {
  const readdir = o.readdir ?? ((d) => readdirSync(d));
  const read = o.read ?? ((p) => readFileSync(p, "utf8"));
  let names;
  try {
    names = readdir(o.dir);
  } catch {
    return [];
  }
  const cutoff = o.launchedAt - DISCOVERY_SKEW_MS;
  const out = [];
  for (const name of names) {
    if (typeof name !== "string" || !name.endsWith(".json")) continue;
    let meta;
    try {
      meta = JSON.parse(read(join(o.dir, name)));
    } catch {
      continue; // partial / unreadable metadata: retried on the next scan
    }
    if (!meta || typeof meta !== "object") continue;
    const id = typeof meta.session_id === "string" && meta.session_id ? meta.session_id : name.slice(0, -".json".length);
    if (typeof meta.cwd !== "string" || !sameDir(meta.cwd, o.cwd)) continue;
    if (typeof meta.parent_session_id === "string" && meta.parent_session_id) continue; // sub-agent child
    const createdAt = Date.parse(meta.created_at ?? meta.createdAt ?? "");
    if (!(createdAt >= cutoff)) continue;
    out.push({ id, createdAt });
  }
  return out;
}

/**
 * @param {{ sessionMap?: { entries: Function, set: Function, remove: Function }, mapDeps?: object,
 *   ownershipDeps?: object, readdir?: (d: string) => string[], read?: (p: string) => string }} [deps]
 * @returns {import("./contract.mjs").SessionSyncAdapter}
 */
export function createKiroAdapter(deps = {}) {
  const sessionMap = deps.sessionMap ?? kiroSessionMap;
  const read = deps.read ?? ((p) => readFileSync(p, "utf8"));
  const runs = new WeakMap();
  const dirFor = (ctx) => kiroSessionsDir(ctx.env, ctx.platform);

  const bindingFor = (ctx) => {
    let binding = runs.get(ctx);
    if (!binding) {
      const mapDeps = { logger: ctx.logger, ...(deps.mapDeps ?? {}) };
      const ownershipDeps = { logger: ctx.logger, ...(deps.ownershipDeps ?? {}) };
      binding = createSelfIdBinding({
        label: "kiro",
        listCandidates: (c) => scanKiroSessions({ dir: dirFor(c), cwd: c.cwd, launchedAt: c.launchedAt, readdir: deps.readdir, read }),
        map: {
          entries: () => sessionMap.entries(mapDeps),
          set: (k, v) => sessionMap.set(k, v, mapDeps),
          remove: (k, v) => sessionMap.remove(k, v, mapDeps),
        },
        onBound: (c, cand, key) => {
          recordKiroSessionOwnership({ sessionId: cand.id, agentUuid: c.agentUuid, anchor: c.sessionId, sessionKey: key, cwd: c.cwd }, ownershipDeps);
        },
      });
      runs.set(ctx, binding);
    }
    return binding;
  };

  return {
    id: "kiro",
    inspectArgs: inspectKiroArgs,

    prepareArgs(args, ctx) {
      const canBind = ctx.inspection?.continuable !== false && bindingFor(ctx).keyFor(ctx) !== null;
      return { args, backendSessionId: null, continuable: canBind };
    },

    async discoverSessionId(ctx) {
      if (ctx.inspection?.continuable === false) return null;
      return bindingFor(ctx).discover(ctx);
    },

    transcriptSource(ctx) {
      const id = bindingFor(ctx).candidate()?.id;
      if (!id) return null;
      let done = false;
      return {
        mode: "on_exit",
        async next() {
          if (done) return [];
          done = true;
          let raw;
          try {
            raw = read(join(dirFor(ctx), `${id}.jsonl`));
          } catch {
            ctx.logger.warn("[sync] kiro: session transcript not found at exit");
            return [];
          }
          const out = [];
          for (const entry of parseSessionJsonl(raw, ctx.logger)) {
            const msg = extractTranscriptText(entry);
            if (msg) out.push(msg);
          }
          return out;
        },
      };
    },

    async finalize(ctx) {
      if (ctx.inspection?.continuable === false) return { continuable: false, reason: ctx.inspection.reason ?? "user_session_flag" };
      return bindingFor(ctx).finalize(ctx);
    },
  };
}

export const kiroAdapter = createKiroAdapter();
