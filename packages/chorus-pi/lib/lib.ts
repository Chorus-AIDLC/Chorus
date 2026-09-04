/**
 * Pure helpers extracted from the chorus-pi extension for unit testing.
 *
 * These functions hold no mutable state and (except for detectOpenSpec, which
 * takes injectable fs/execSync) have no I/O — so they can be tested without a
 * running Pi session or a live Chorus instance. The extension imports them
 * from here; tests import the same functions.
 */

import { dirname, join } from "node:path";

/**
 * Minimal fs surface needed by the config readers below.
 * (detectOpenSpec already uses FsLike; keep this as the shared type.)
 */
export interface FsLike {
  existsSync(p: string): boolean;
}

/**
 * Read raw file contents (utf-8). Injected so tests can stub the disk.
 */
export type ReadFileLike = (p: string) => string;

export interface ChorusConnection {
  url: string;
  apiKey: string;
}

/**
 * Parse the chorus server entry out of a standard .mcp.json shape:
 *   { "mcpServers": { "chorus": { "url": "…/api/mcp",
 *       "headers": { "Authorization": "Bearer cho_…" } } } }
 *
 * Returns { url, apiKey } with apiKey extracted from the Authorization header
 * (accepts both "Bearer cho_…" and a bare "cho_…"). Empty strings if absent.
 * Pure given the raw file text — no fs dependency — so it is unit-testable.
 */
export function parseChorusServerFromMcpJson(rawJson: string): ChorusConnection {
  if (!rawJson) return { url: "", apiKey: "" };
  let obj: any;
  try {
    obj = JSON.parse(rawJson);
  } catch {
    return { url: "", apiKey: "" };
  }
  const srv = obj?.mcpServers?.chorus;
  if (!srv || typeof srv !== "object") return { url: "", apiKey: "" };
  const url = typeof srv.url === "string" ? srv.url : "";
  let apiKey = "";
  const auth = srv?.headers?.Authorization;
  if (typeof auth === "string") {
    if (auth.startsWith("Bearer ")) apiKey = auth.slice("Bearer ".length);
    else if (auth.startsWith("cho_")) apiKey = auth;
  }
  return { url, apiKey };
}

/**
 * Resolve the Chorus connection (url + apiKey) from the standard .mcp.json
 * auto-discovered by pi-mcp-adapter. Searches candidate paths in order
 * (project-root .mcp.json, then ~/.pi/agent/mcp.json), and returns the first
 * COMPLETE chorus server entry (both url AND apiKey present). A partial entry
 * (e.g. only url, no Authorization) is skipped so a complete global candidate
 * is still reached — a partial project config must NOT shadow a complete
 * ~/.pi/agent/mcp.json. Returns { "", "" } if no candidate is complete.
 *
 * Used as a fallback when CHORUS_URL / CHORUS_API_KEY env vars are unset,
 * so a single .mcp.json config source covers both the MCP gateway (literal
 * URL+Bearer) and the extension's own checkin + the OpenSpec wrapper.
 */
export function resolveChorusConfigFromMcpJson(
  candidatePaths: string[],
  fs: FsLike,
  readFile: ReadFileLike,
): ChorusConnection {
  for (const p of candidatePaths) {
    if (!fs.existsSync(p)) continue;
    const { url, apiKey } = parseChorusServerFromMcpJson(readFile(p));
    if (url && apiKey) return { url, apiKey };
  }
  return { url: "", apiKey: "" };
}

export type ExecSync = (cmd: string, opts: { stdio: "ignore" }) => void;

/**
 * Matches the three Chorus reviewer agent names. These do NOT get a Chorus
 * session — they are read-only and post a single VERDICT comment.
 */
export function isReviewerAgent(name: string): boolean {
  return /^(chorus-proposal|chorus-task|chorus-code)-reviewer$/.test(name);
}

/**
 * Positive classification of an agent that should get an auto-managed Chorus
 * session + task-lifecycle (checkin/update/report/checkout) injection.
 *
 * Only canonical worker agent names get a session. The three Chorus reviewers
 * are read-only (handled by isReviewerAgent) and the official subagent example's
 * read-only agents `scout` / `planner` / `reviewer` are NOT workers — injecting
 * the session workflow into them adds irrelevant task-lifecycle instructions and
 * unnecessary chorus_create_session API traffic for agents that never touch a task.
 *
 * `chorus-worker` is this package's own general-purpose implementer agent
 * (agents/chorus-worker.md); `worker` is retained for back-compat with pi's
 * subagent example. This is a positive allowlist (not a reviewer exclusion) so
 * arbitrary custom read-only agents also do NOT get a session. Add more worker
 * names here if the project introduces them.
 */
export const WORKER_AGENT_NAMES = ["worker", "chorus-worker"] as const;
export function isWorkerAgent(name: string): boolean {
  return (WORKER_AGENT_NAMES as readonly string[]).includes(name);
}
/**
 * Enumerate the (agent, task) items in an official `subagent` tool call's input,
 * across its three modes:
 *   - single:   { agent, task }
 *   - parallel: { tasks: [{ agent, task }, ...] }
 *   - chain:    { chain: [{ agent, task }, ...] }
 *
 * Each returned holder carries the agent name, the current task text, and a
 * `setTask` that writes back into the SAME input object in place — so the
 * extension can inject the Chorus session workflow into a worker's task before
 * the ephemeral child `pi` process is spawned (pi's `tool_call` event input is
 * mutable). Holders with a non-string / empty agent or task are skipped.
 *
 * Replaces the old persistent-model agentId extraction: the official subagent
 * children are ephemeral (spawn → run → exit within one tool call) and expose
 * no `sa_<uuid>` agentId to map, so there is nothing to parse out of a result.
 */
export interface SubagentTaskItem {
  agent: string;
  task: string;
  setTask: (task: string) => void;
}

export function subagentTaskItems(input: unknown): SubagentTaskItem[] {
  if (!input || typeof input !== "object") return [];
  const obj = input as Record<string, unknown>;
  const items: SubagentTaskItem[] = [];
  const collect = (holder: Record<string, unknown>): void => {
    const agent = typeof holder.agent === "string" ? holder.agent : "";
    const task = typeof holder.task === "string" ? holder.task : "";
    if (!agent || !task) return;
    items.push({
      agent,
      task,
      setTask: (t) => {
        holder.task = t;
      },
    });
  };
  if (Array.isArray(obj.tasks)) {
    for (const t of obj.tasks) if (t && typeof t === "object") collect(t as Record<string, unknown>);
  } else if (Array.isArray(obj.chain)) {
    for (const c of obj.chain) if (c && typeof c === "object") collect(c as Record<string, unknown>);
  } else {
    collect(obj);
  }
  return items;
}

/**
 * Build the session-workflow suffix injected into a spawned worker's task
 * (via the tool_call event's mutable input). The subprocess receives this
 * appended to its task prompt and reads the `Session UUID` from it.
 */
export function sessionWorkflow(sessionUuid: string): string {
  const s = sessionUuid;
  return [
    "",
    "--- Chorus session (auto-injected by the chorus-pi extension) ---",
    `Session UUID: ${s}`,
    "For each Chorus task you work on:",
    `  1. chorus_session_checkin_task({ sessionUuid: "${s}", taskUuid: <task-uuid> })`,
    `  2. chorus_update_task({ taskUuid: <task-uuid>, status: "in_progress", sessionUuid: "${s}" })`,
    "  3. ...do the work, commit...",
    `  4. chorus_report_work({ taskUuid: <task-uuid>, report: \"...\", sessionUuid: "${s}" })`,
    `  5. chorus_session_checkout_task({ sessionUuid: "${s}", taskUuid: <task-uuid> })`,
    "Do NOT call chorus_create_session or chorus_close_session — the extension owns the lifecycle.",
  ].join("\n");
}

/**
 * True when a worker task already carries an injected session block.
 *
 * Matches the block header at the start of a line (`--- Chorus session`), so
 * prose that merely mentions "Chorus session" does not suppress injection.
 * Covers both this extension's injected block and any main-agent template.
 * The header is exactly "--- Chorus session" followed by " (…)" or end of line;
 * a hyphenated continuation like "--- Chorus session-notes" is not a header.
 */
export function hasSessionMarker(task: string): boolean {
  return /^--- Chorus session(?=[ (\u2014]|$)/m.test(task);
}

/**
 * Detect an async (detached) nicobailon pi-subagents `subagent` run from its
 * tool_result EVENT, and extract the run id that its completion events will
 * carry.
 *
 * The official bundled subagent (blocking) returns at tool_result with no run
 * id — the session lifecycle closes there. The nicobailon `pi-subagents` tool
 * launches async (detached) by default: spawn returns immediately with
 * `details.asyncId`, and completion arrives later on the pi event bus as
 * `subagent:async-complete` / `subagent:process-terminal` with `{runId}`/`{id}`.
 * Only `details.asyncId`/`details.runId` are trusted — the nicobailon contract
 * always carries the run id in `details` for async launches, and a blocking
 * run's worker output (even standalone JSON) must never be misclassified as
 * an async run (which would leak the session until session_shutdown).
 */
export function extractRunIdFromToolResultEvent(event: {
  details?: unknown;
}): string | null {
  const d = (event.details ?? {}) as Record<string, unknown>;
  for (const key of ["asyncId", "runId"]) {
    if (typeof d[key] === "string" && (d[key] as string).length > 0) return d[key] as string;
  }
  return null;
}

/**
 * Resolved OpenSpec mode for a repo. `active` is the effective on/off; `reason`
 * is a human-readable explanation; `optout` marks an explicit opt-out (so the
 * banner does not nag); `hint` is an optional install hint when the directory
 * exists but the CLI is missing.
 */
export interface OpenSpecState {
  active: boolean;
  reason: string;
  optout: boolean;
  hint: string;
}

/**
 * Detect OpenSpec mode for a repo. Active only when all three hold:
 *   (1) not explicitly opted out (CHORUS_OPENSPEC_MODE != "off")
 *   (2) an openspec/ directory exists at the project root
 *   (3) the `openspec` CLI is on PATH
 *
 * fs and execSync are injected so tests can stub the filesystem and the CLI
 * presence check without touching the real environment.
 */
export function detectOpenSpec(
  cwd: string,
  optout: boolean,
  fs: FsLike,
  execSync: ExecSync,
): OpenSpecState {
  if (optout) {
    return { active: false, reason: "CHORUS_OPENSPEC_MODE=off (explicit opt-out)", optout: true, hint: "" };
  }
  const openspecDir = `${cwd}/openspec`;
  if (!fs.existsSync(openspecDir)) {
    return { active: false, reason: `no openspec/ directory at ${openspecDir}`, optout: false, hint: "" };
  }
  let cliPresent = false;
  try {
    execSync("command -v openspec", { stdio: "ignore" });
    cliPresent = true;
  } catch {
    cliPresent = false;
  }
  if (!cliPresent) {
    return {
      active: false,
      reason: "openspec/ directory present but `openspec` CLI not on PATH",
      optout: false,
      hint: "install with: npm i -g @fission-ai/openspec",
    };
  }
  return { active: true, reason: "openspec/ directory + openspec CLI both present", optout: false, hint: "" };
}

/**
 * Build the user-visible one-line startup banner (the Pi equivalent of the
 * Claude plugin's SessionStart `systemMessage` / Codex `$chorus` toast).
 *
 * Mirrors the three OpenSpec states from upstream (#442):
 *   - active            -> "(OpenSpec Enabled)"
 *   - explicit opt-out  -> "(OpenSpec off)"            [neutral, no nag]
 *   - not set up        -> "(OpenSpec off — run /skill:chorus enable openspec to set it up)"
 *
 * Plus two non-OpenSpec states:
 *   - not configured    -> warning that CHORUS_URL / CHORUS_API_KEY are missing
 *   - connection failed -> error that the checkin couldn't reach Chorus
 *
 * Pure (no I/O) so it can be unit-tested without a running Pi session.
 */
export interface SessionBanner {
  message: string;
  level: "info" | "warning" | "error";
}

export function buildSessionBanner(args: {
  configured: boolean;
  connected: boolean;
  chorusUrl: string;
  openspec: OpenSpecState;
}): SessionBanner {
  // Not configured at all — env vars missing. Warn once so the user knows
  // the plugin loaded but is inert (Claude's hook emits the same warning).
  if (!args.configured) {
    return {
      message: "Chorus plugin: not configured (set CHORUS_URL and CHORUS_API_KEY)",
      level: "warning",
    };
  }

  // Configured but checkin failed — the session runs but hooks are dead.
  if (!args.connected) {
    return {
      message: `Chorus: connection failed (${args.chorusUrl})`,
      level: "error",
    };
  }

  // Connected. Append the OpenSpec status suffix.
  let suffix: string;
  if (args.openspec.active) {
    suffix = "(OpenSpec Enabled)";
  } else if (args.openspec.optout) {
    suffix = "(OpenSpec off)";
  } else {
    suffix = "(OpenSpec off — run /skill:chorus enable openspec to set it up)";
  }
  return {
    message: `Chorus connected at ${args.chorusUrl} ${suffix}`,
    level: "info",
  };
}

/**
 * Parse CHORUS_MAX_CODE_REVIEW_ROUNDS into a non-negative integer.
 * Mirrors the Claude plugin's `maxCodeReviewRounds` userConfig (default 3,
 * 0 = unlimited). Empty/absent → default. Invalid (NaN, negative, non-integer)
 * → default. Pure so it is unit-testable.
 */
export const DEFAULT_MAX_CODE_REVIEW_ROUNDS = 3;
export function parseMaxCodeReviewRounds(raw: string | undefined): number {
  if (raw == null) return DEFAULT_MAX_CODE_REVIEW_ROUNDS;
  const trimmed = raw.trim();
  if (trimmed === "") return DEFAULT_MAX_CODE_REVIEW_ROUNDS;
  // Use Number (not parseInt) so "3.5" or "3abc" both fall through to default
  // instead of silently parsing the leading digits.
  const n = Number(trimmed);
  if (!Number.isInteger(n) || n < 0) return DEFAULT_MAX_CODE_REVIEW_ROUNDS;
  return n;
}

/**
 * Resolve the bundled `bin/chorus-mcp-call.sh` wrapper path.
 *
 * The wrapper ships inside the chorus-pi package (`bin/chorus-mcp-call.sh`,
 * declared as a `bin` in package.json). When installed via `pi install ./packages/chorus-pi`
 * (a local path), the script is neither linked onto PATH nor placed under
 * `~/.pi/agent/npm/...` (those only happen for npm/git installs), so the skill's
 * `find ~/.pi/agent/npm` fallback misses it. Instead, the extension knows its own
 * install location and can resolve the wrapper relative to the package root.
 *
 * Strategy:
 *   1. start from the extension module's own URL (import.meta.url) → its dir
 *   2. walk up at most a few levels looking for `bin/chorus-mcp-call.sh`
 *      (handles `extensions/chorus.ts` → `..`/bin, and `dist/extensions/...` →
 *      `../../bin` if the package is ever bundled)
 *   3. return the first existing match, or "" if none found (the skill then falls
 *      back to PATH / find)
 *
 * Pure given an injectable fs so it is unit-testable without a real layout.
 */
export function resolveChorusBin(extensionFileUrl: string, fs: FsLike): string {
  if (!extensionFileUrl) return "";
  // file: URL → filesystem path. Works for import.meta.url of a real .ts/.js file.
  let extPath: string;
  try {
    extPath = extensionFileUrl.startsWith("file:")
      ? new URL(extensionFileUrl).pathname
      : extensionFileUrl;
  } catch {
    return "";
  }
  if (!extPath) return "";
  let dir = dirname(extPath);
  // Walk up at most 6 levels to find <pkgRoot>/bin/chorus-mcp-call.sh.
  for (let i = 0; i < 6; i++) {
    const candidate = join(dir, "bin", "chorus-mcp-call.sh");
    if (fs.existsSync(candidate)) return candidate;
    const parent = dirname(dir);
    if (parent === dir) break; // reached filesystem root
    dir = parent;
  }
  return "";
}

/**
 * The 3 Chorus tool names that should trigger a reviewer nudge after they run.
 * These are the BACKEND native names (no server prefix).
 */
export const NUDGE_TOOL_NAMES = [
  "chorus_pm_submit_proposal",
  "chorus_submit_for_verify",
  "chorus_admin_verify_task",
] as const;
export type NudgeToolName = (typeof NUDGE_TOOL_NAMES)[number];

/**
 * Normalize a tool name seen in a pi event to the Chorus backend native name,
 * so it can be matched against NUDGE_TOOL_NAMES regardless of how pi-mcp-adapter
 * exposed it.
 *
 * Handles all three exposure modes:
 *   - gateway mode:  event.toolName === "mcp", real name in event.input.tool
 *                  (e.g. "chorus_chorus_submit_for_verify" — server-prefixed)
 *   - direct, toolPrefix "server": "chorus_chorus_submit_for_verify"
 *   - direct, toolPrefix "none":   "chorus_submit_for_verify" (native)
 *
 * Strips at most one leading "chorus_" server prefix. Returns null if the input
 * is empty or not a chorus tool.
 */
export function normalizeChorusToolName(name: string | undefined | null): string | null {
  if (!name) return null;
  let n = name;
  // The chorus server name is "chorus"; the adapter prefixes it once. Strip one.
  if (n.startsWith("chorus_chorus_")) n = n.slice("chorus_".length);
  // Must still be a chorus tool after stripping.
  if (!n.startsWith("chorus_")) return null;
  return n;
}

/**
 * Resolve the Chorus native tool name from a tool_result / tool_execution_end event,
 * accounting for MCP gateway mode (where the real name lives in event.input.tool).
 *
 * Returns the native name (e.g. "chorus_submit_for_verify") or null.
 */
export function resolveChorusToolName(event: {
  toolName: string;
  input?: { tool?: string } | Record<string, unknown>;
}): string | null {
  // Gateway mode: the agent called the `mcp` proxy tool; the real chorus tool
  // name is in event.input.tool.
  if (event.toolName === "mcp") {
    const input = event.input as { tool?: string } | undefined;
    return normalizeChorusToolName(input?.tool);
  }
  // Direct mode: the tool name itself is the (possibly server-prefixed) chorus name.
  return normalizeChorusToolName(event.toolName);
}
