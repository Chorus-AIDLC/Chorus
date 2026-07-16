// cli/kiro-transcript.mjs
// Transcript reconstruction for the Kiro backend. `kiro-cli chat --no-interactive`
// emits no structured per-message stream (its `--format json` is list-commands-
// only), so unlike Claude/Codex there is nothing to parse live off stdout. Instead
// we reconstruct the transcript POST-RUN from Kiro's on-disk session store, and
// fall back to a single plain-text stdout blob if the store can't be read. This
// encodes the human's transcript decision: prefer store reconstruction, fall back
// to plain text.
//
// ⚠️ VERIFIED LIVE (kiro-cli 2.12.1, integration checkpoint): a `chat
// --no-interactive` run does NOT persist a session to the cli store — only
// interactive/TUI runs write `~/.kiro/sessions/cli/<id>.{jsonl,json}`. So on the
// DAEMON's headless path the store lookup normally finds nothing and the
// PLAIN-TEXT FALLBACK is the effective path. The store-reconstruction path is kept
// (it is correct and richer) for two reasons: it works if a future Kiro version
// persists headless sessions, and it captures reviewer-subagent child sessions
// when they ARE written. The fallback is not a rare degrade here — it is the
// common case — so it must produce clean text (see stripAnsi below): headless
// stdout is ANSI-styled with spinner frames, which must be stripped before storing.
//
// Store schema (verified live against kiro-cli 2.12.1):
//   ~/.kiro/sessions/cli/<sessionId>.jsonl  — one JSON object per line:
//     { version, kind, data: { message_id, content: [ { kind, data }, ... ] } }
//     kind ∈ { Prompt, AssistantMessage, ToolResults, ... }
//     A content block's kind ∈ { text, thinking, toolUse, toolResult, ... };
//     ONLY `text` blocks are conversation text (data is the string) — thinking /
//     toolUse / toolResult are dropped (parallels the Claude extractor keeping
//     only `text` content blocks).
//   ~/.kiro/sessions/cli/<sessionId>.json   — metadata:
//     { session_id, cwd, updated_at, created_at, parent_session_id,
//       session_created_reason, ... }
//     Reviewer subagents get their OWN session with parent_session_id === the
//     run's sessionId. NOTE: session_created_reason can be "subagent" even on a
//     root session, so child detection keys on parent_session_id, NOT on the
//     reason field.
//
// Entries are emitted in the CLAUDE stream-json envelope shape
//   { type: "user"|"assistant", message: { role, content: [ { type:"text", text } ] } }
// so the existing upload-hooks `extractTranscriptText` consumes them with NO
// dialect change (it already recognizes that shape).
//
// CONTRACT: best-effort, MUST NEVER throw into the wake path (the caller also
// wraps it in try/catch). Any IO/parse failure degrades — worst case, nothing (or
// the plain-text fallback) is emitted, with a visible log.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { kiroSessionsDir } from "./kiro-spawner.mjs";

const NOOP_LOGGER = { info() {}, warn() {}, error() {} };

// `kiro-cli chat --no-interactive` writes ANSI-styled text + braille spinner
// frames to stdout (it renders for a terminal even headless). Strip them so the
// plain-text fallback stores clean conversation text, not escape soup.
//   - CSI sequences: ESC [ … <final byte>
//   - OSC sequences: ESC ] … (BEL | ESC \)
//   - braille spinner glyphs U+2800–U+28FF
//   - a leading "> " prompt marker Kiro prints before the answer
const ANSI_CSI = /\x1b\[[0-9;?]*[ -/]*[@-~]/g;
const ANSI_OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const SPINNER = /[⠀-⣿]/g;

/**
 * Strip ANSI escapes + spinner frames from a headless-CLI stdout blob and tidy
 * whitespace. Exported for testing.
 * @param {string} s
 * @returns {string}
 */
export function stripAnsi(s) {
  if (typeof s !== "string") return "";
  let out = s.replace(ANSI_OSC, "").replace(ANSI_CSI, "").replace(SPINNER, "");
  // Drop a leading "> " answer marker and collapse runs of blank lines.
  out = out.replace(/^[ \t]*>[ \t]?/gm, "");
  out = out.replace(/\n{3,}/g, "\n\n");
  return out.trim();
}

/** Map a store line's `kind` to a transcript role, or null to skip the line. */
function roleForKind(kind) {
  if (kind === "Prompt") return "user";
  if (kind === "AssistantMessage") return "assistant";
  return null; // ToolResults / lifecycle / unknown → not conversation text
}

/**
 * Concatenate the `text` content blocks of one store line's `data.content[]`,
 * dropping thinking / toolUse / toolResult / non-text blocks. Returns "" when the
 * line carries no conversation text.
 * @param {any} data  the line's `data` object
 * @returns {string}
 */
export function extractLineText(data) {
  if (!data || typeof data !== "object") return "";
  const content = data.content;
  if (typeof content === "string") return content; // defensive: bare string
  if (!Array.isArray(content)) return "";
  const parts = [];
  for (const block of content) {
    if (block && typeof block === "object" && block.kind === "text" && typeof block.data === "string") {
      parts.push(block.data);
    }
  }
  return parts.join("");
}

/**
 * Parse one session `.jsonl` into ordered transcript entries (Claude-dialect
 * envelopes). Skips blank / malformed lines and non-conversation kinds. Never
 * throws — a malformed line is warned-and-skipped.
 * @param {string} raw  full file contents
 * @param {{warn(m:string):void}} logger
 * @returns {Array<{ type: "user"|"assistant", message: { role: string, content: Array<{type:"text",text:string}> } }>}
 */
export function parseSessionJsonl(raw, logger = NOOP_LOGGER) {
  const out = [];
  const lines = raw.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      logger.warn("[Chorus] kiro-transcript: skipping a malformed store line");
      continue;
    }
    if (!obj || typeof obj !== "object") continue;
    const role = roleForKind(obj.kind);
    if (!role) continue;
    const text = extractLineText(obj.data);
    if (!text.trim()) continue; // a message with no conversation text → nothing to store
    out.push({ type: role, message: { role, content: [{ type: "text", text }] } });
  }
  return out;
}

/**
 * List the run's session plus any CHILD sessions (reviewer subagents), ordered so
 * the parent precedes its children and children are in creation order. Each entry
 * is `{ sessionId, createdAt }`. Best-effort: unreadable metadata is skipped.
 * @param {string} sessionId  the run's (parent) sessionId
 * @param {{ dir?: string, readdir?: (d:string)=>string[], read?: (p:string)=>string, logger?: any }} [deps]
 * @returns {Array<{ sessionId: string, createdAt: number }>}
 */
export function collectSessionChain(sessionId, deps = {}) {
  const dir = deps.dir ?? kiroSessionsDir();
  const readdir = deps.readdir ?? ((d) => readdirSync(d));
  const read = deps.read ?? ((p) => readFileSync(p, "utf8"));
  // (no logging here — collectSessionChain silently skips unreadable metadata.)

  const children = [];
  let files = [];
  try {
    files = readdir(dir);
  } catch {
    // No store dir → just the run's own session (its jsonl may still exist elsewhere).
    return [{ sessionId, createdAt: 0 }];
  }
  for (const f of files) {
    if (!f.endsWith(".json")) continue;
    let meta;
    try {
      meta = JSON.parse(read(join(dir, f)));
    } catch {
      continue;
    }
    if (!meta || typeof meta !== "object") continue;
    // Child detection keys on parent_session_id (NOT session_created_reason, which
    // can be "subagent" on a root session too).
    if (meta.parent_session_id === sessionId) {
      const sid = typeof meta.session_id === "string" ? meta.session_id : f.replace(/\.json$/, "");
      children.push({ sessionId: sid, createdAt: Date.parse(meta.created_at ?? meta.updated_at ?? "") || 0 });
    }
  }
  children.sort((a, b) => a.createdAt - b.createdAt);
  // Parent first, then children in creation order.
  return [{ sessionId, createdAt: 0 }, ...children];
}

/**
 * Reconstruct the transcript for a completed Kiro run and feed each entry to
 * `onMessage`. This is the hook KiroSpawner invokes post-run. Reads the run's
 * session `.jsonl` (and any child subagent sessions) from the store; if that
 * yields nothing usable, falls back to a single plain-text `stdout` entry. Emits
 * Claude-dialect envelopes so the existing upload-hooks extractor consumes them
 * unchanged. Never throws.
 *
 * @param {{
 *   sessionId: string,
 *   cwd?: string,
 *   onMessage?: (obj: any) => void,
 *   stdout?: string,
 *   logger?: { info(m:string):void, warn(m:string):void, error(m:string):void },
 *   dir?: string,
 *   readdir?: (d: string) => string[],
 *   read?: (p: string) => string,
 * }} params
 * @returns {void}
 */
export function reconstructTranscript(params) {
  const { sessionId, onMessage, stdout } = params;
  const logger = params.logger ?? NOOP_LOGGER;
  if (!onMessage) return; // nothing to feed
  if (typeof sessionId !== "string" || !sessionId) {
    emitFallback(stdout, onMessage, logger, "no sessionId");
    return;
  }

  const dir = params.dir ?? kiroSessionsDir();
  const read = params.read ?? ((p) => readFileSync(p, "utf8"));

  let emitted = 0;
  let anyStoreRead = false;
  try {
    const chain = collectSessionChain(sessionId, { dir, readdir: params.readdir, read, logger });
    for (const { sessionId: sid } of chain) {
      let raw;
      try {
        raw = read(join(dir, `${sid}.jsonl`));
      } catch {
        continue; // this session has no readable jsonl — skip it
      }
      anyStoreRead = true;
      const entries = parseSessionJsonl(raw, logger);
      for (const entry of entries) {
        try {
          onMessage(entry);
          emitted++;
        } catch (err) {
          logger.warn(`[Chorus] kiro-transcript: onMessage threw (ignored): ${err}`);
        }
      }
    }
  } catch (err) {
    logger.warn(`[Chorus] kiro-transcript: store reconstruction failed (${err}) — trying plain-text fallback`);
  }

  // Fallback (option 1): the store was missing / unreadable / empty of
  // conversation text — emit the raw stdout as a single plain-text entry so the
  // turn is not left with an empty transcript.
  if (emitted === 0) {
    emitFallback(stdout, onMessage, logger, anyStoreRead ? "store had no conversation text" : "store unreadable");
  }
}

/**
 * Emit the run's raw stdout as one plain-text assistant transcript entry. No-op
 * when there is no stdout. Logs the degrade. Never throws.
 */
function emitFallback(stdout, onMessage, logger, reason) {
  const text = stripAnsi(stdout);
  if (!text) {
    logger.warn(`[Chorus] kiro-transcript: ${reason} and no stdout — transcript left empty for this turn`);
    return;
  }
  logger.warn(`[Chorus] kiro-transcript: ${reason} — falling back to a plain-text stdout entry`);
  try {
    onMessage({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text }] } });
  } catch (err) {
    logger.warn(`[Chorus] kiro-transcript: fallback onMessage threw (ignored): ${err}`);
  }
}
