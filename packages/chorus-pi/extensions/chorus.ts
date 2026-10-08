/**
 * Chorus AI-DLC extension for the Pi coding agent.
 *
 * Ported from the Claude Code plugin (public/chorus-plugin/) and the Codex
 * port (plugins/chorus/). Where those shipped bash hook scripts driven by a
 * hooks.json manifest, Pi ships a single TypeScript extension that subscribes
 * to Pi's native events. See docs/CONNECT_PI.md for the design rationale.
 *
 * Capabilities (mirrors the Claude Code plugin):
 *   - session_start          → chorus_checkin + context injection (SessionStart hook)
 *   - before_agent_start     → inject checkin result once (replaces UserPromptSubmit noise)
 *   - tool_call (subagent, pre-execution, MUTABLE input)
 *                            → for each WORKER task in the `subagent` invocation
 *                              (single / parallel / chain), create a Chorus session and
 *                              inject its UUID + the session workflow into that task. This
 *                              is the Pi-native equivalent of Claude's SubagentStart hook
 *                              injecting session context — a capability the Codex port
 *                              lacks (Codex has no pre-spawn mutation channel, so its
 *                              workers must manage sessions manually).
 *                            → pin every REVIEWER and WORKER task to the background
 *                              (`async: true`), so it keeps the ambient MCP tools it
 *                              needs (reviewers: chorus_add_comment for the VERDICT;
 *                              workers: chorus_session_checkin_task / chorus_update_task
 *                              / chorus_report_work / chorus_submit_for_verify). A
 *                              foreground (`async: false`) child is in-process and never
 *                              loads ambient extensions, so those tools are missing:
 *                              a reviewer's declared allowlist makes that a failed run,
 *                              a worker (no allowlist) degrades silently. The bundled
 *                              subagent ignores the flag (its child is a separate `pi`
 *                              process) and is unaffected.
 *   - tool_result            → close the ephemeral worker session(s) once the `subagent`
 *   - tool_result            → for the official blocking subagent, close the ephemeral
 *                              worker session(s) once the `subagent` tool call returns
 *                              (spawn → run → exit within one tool call, so there is no
 *                              persistent agentId and no separate close tool). For the
 *                              nicobailon `pi-subagents` tool (async/detached by default,
 *                              `details.asyncId` on tool_result) the sessions are deferred
 *                              and closed on subagent:async-complete / process-terminal.
 *                            → reviewer nudges after submit_proposal / submit_for_verify
 *                              / admin_verify_task (the 3 PostToolUse hooks)
 *   - tool_execution_end     → fallback close of the worker session(s) if tool_result
 *                              did not fire (idempotent — a successful close deletes the
 *                              bookkeeping entry)
 *   - session_shutdown       → close stray sessions (SessionEnd hook)
 *
 * MCP: Pi 1.x has native support (global ~/.pi/agent/mcp.json or trusted-project
 * .pi/mcp.json). Default codemode subcalls emit tool_call/tool_result with real
 * mcp__<server>__<tool> names and parentToolCallId; direct MCP events use the same
 * outer-name matcher. The codemode parent does not identify a workflow.
 * pi-mcp-adapter remains a legacy route (.mcp.json or ~/.pi/agent/mcp.json) and
 * replaces built-in MCP in sessions when it registers /mcp.
 * This extension calls chorus_* for its own bookkeeping (checkin, session
 * create/close) over a direct MCP-over-HTTP fetch, independently of either
 * main-agent MCP route. Export CHORUS_URL + CHORUS_API_KEY for native project
 * config; the existing fallback does not read .pi/mcp.json.
 */

import { getAgentDir, VERSION, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { mcpCall as callChorusMcp } from "../lib/mcp-client.js";
import {
  forceSubagentCallAsync,
  isReviewerAgent,
  isWorkerAgent,
  subagentTaskItems,
  sessionWorkflow,
  hasSessionMarker,
  extractRunIdFromToolResultEvent,
  resolveSpecMode,
  buildSessionBanner,
  parseMaxCodeReviewRounds,
  resolveChorusBin,
  resolveChorusConfigFromMcpJson,
  chorusConfigPaths,
  chorusMcpBackend,
  resolveChorusToolName,
  NUDGE_TOOL_NAMES,
} from "../lib/lib.js";

// ─── Config ────────────────────────────────────────────────────────────
function resolveConnection(cwd: string, backend?: ReturnType<typeof chorusMcpBackend>) {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const _fs = require("node:fs");
  return resolveChorusConfigFromMcpJson(
    chorusConfigPaths(cwd, getAgentDir(), VERSION, _fs, backend),
    { existsSync: _fs.existsSync },
    (path: string) => _fs.readFileSync(path, "utf-8"),
    process.env,
  );
}
const _mcp = resolveConnection(process.cwd());
let CHORUS_URL = _mcp.url;
let CHORUS_API_KEY = _mcp.apiKey;

// A neutral SpecModeResult for the not-configured / connection-failed banners,
// where buildSessionBanner returns before reading the spec fields.
const NO_SPEC = {
  specMode: "off" as const,
  specReason: "",
  specFail: "",
  openspecUsable: false,
  openspecUsableReason: "",
  openspecHint: "",
  chorusOpenspecActive: false,
};

// Reviewer toggle envs (mirror Claude Code plugin userConfig; Pi has no plugin
// settings UI, so env vars drive them). Defaults: all enabled.
const ENABLE_PROPOSAL_REVIEWER = process.env.CHORUS_ENABLE_PROPOSAL_REVIEWER !== "false";
const ENABLE_TASK_REVIEWER = process.env.CHORUS_ENABLE_TASK_REVIEWER !== "false";
const ENABLE_CODE_REVIEWER = process.env.CHORUS_ENABLE_CODE_REVIEWER !== "false";

// Max code-review rounds before escalating to a human. 0 = unlimited.
// Mirrors the Claude plugin's `maxCodeReviewRounds` userConfig (default 3).
// Parsed from CHORUS_MAX_CODE_REVIEW_ROUNDS; invalid/empty falls back to 3.
const MAX_CODE_REVIEW_ROUNDS = parseMaxCodeReviewRounds(process.env.CHORUS_MAX_CODE_REVIEW_ROUNDS);

// Resolve the bundled `bin/chorus-mcp-call.sh` wrapper relative to this extension's
// install location. Local-path installs (`pi install ./packages/chorus-pi`) don't link the bin
// onto PATH and don't live under ~/.pi/agent/npm, so the skill's `find` fallback
// misses it — the extension knows its own dir and can resolve it for the agent.
// Computed once at load; empty string if not found (skill falls back to PATH/find).
const CHORUS_BIN = resolveChorusBin(import.meta.url, {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  existsSync: require("node:fs").existsSync,
});
let CONFIGURED = CHORUS_URL !== "" && CHORUS_API_KEY !== "";

// Package version — single source of truth is the bundled package.json (kept in
// lockstep with the Chorus app version at release), never a hardcoded literal.
// Read once at load; falls back to "0.0.0" if unreadable so a broken read never
// crashes the extension.
const PKG_VERSION: string = (() => {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const _fs = require("node:fs");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const _path = require("node:path");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const _url = require("node:url");
    const _dir = _path.dirname(_url.fileURLToPath(import.meta.url));
    const _pkg = JSON.parse(_fs.readFileSync(_path.join(_dir, "..", "package.json"), "utf-8"));
    return typeof _pkg.version === "string" ? _pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
})();

// ─── MCP-over-HTTP helper (TS replacement for chorus-mcp-call.sh) ───────────
async function mcpCall<T = unknown>(tool: string, args: Record<string, unknown> = {}): Promise<T> {
  return callChorusMcp<T>({ url: CHORUS_URL, apiKey: CHORUS_API_KEY, version: PKG_VERSION }, tool, args);
}

// ─── Session bookkeeping (ephemeral subagent model) ────────────────────────
// The official `subagent` tool spawns EPHEMERAL child pi processes (single /
// parallel / chain) that run to completion within one tool call — there is no
// persistent agentId and no separate `subagent_manage close` tool. So we create
// a Chorus session for each WORKER task when the `subagent` tool call starts
// (tool_call, mutable input → inject the session UUID + workflow into that task)
// and close those sessions when the tool call finishes (tool_result, with
// tool_execution_end as an idempotent fallback).
//
// toolCallId → the Chorus session UUIDs created for that `subagent` invocation.
const callSessions = new Map<string, string[]>();
// runId (nicobailon async/detached `subagent` runs) → sessionUuid(s); closed on
// subagent:async-complete / subagent:process-terminal (blocking runs close at
// tool_result via callSessions and never enter this map).
const runIdToSid = new Map<string, string[]>();
let checkinContext: string | null = null;
let injectedOnce = false;

// Close a Chorus session, retaining the caller's bookkeeping entry on failure so
// session_shutdown can retry the close (Reviewer P1: a transient network/server
// error must NOT permanently leak the backend session). Only on success does
// this run onSuccess (which drops the sessionMap/pendingSessions entry) and
// report success. Returns whether the close succeeded.
type NotifyCtx = { ui: { notify(msg: string, level: "info" | "warning" | "error"): void } };

async function closeSessionOrRetain(
  sid: string,
  ctx: NotifyCtx,
  msgs: { fail: string; success: string; successLevel?: "info" | "warning" },
  onSuccess: () => void,
): Promise<boolean> {
  try {
    await mcpCall("chorus_close_session", { sessionUuid: sid });
  } catch (e) {
    ctx.ui.notify(`${msgs.fail} — ${(e as Error).message}`, "warning");
    return false;
  }
  onSuccess();
  ctx.ui.notify(msgs.success, msgs.successLevel ?? "info");
  return true;
}

// Close every Chorus session created for a `subagent` tool call. Idempotent:
// both tool_result and tool_execution_end call this for the same toolCallId, so
// the entry is deleted only once all its sessions close. A session whose close
// fails is retained in callSessions so a later event (or session_shutdown) can
// retry it — a transient network/server error must NOT leak the backend session.
async function closeCallSessions(
  toolCallId: string,
  ctx: NotifyCtx,
): Promise<void> {
  const sids = callSessions.get(toolCallId);
  if (!sids || sids.length === 0) return;
  const retained: string[] = [];
  for (const sid of sids) {
    const ok = await closeSessionOrRetain(
      sid,
      ctx,
      {
        fail: `Chorus: close failed for session ${sid.slice(0, 8)}… (will retry on shutdown)`,
        success: `Chorus: closed session ${sid.slice(0, 8)}…`,
      },
      () => {},
    );
    if (!ok) retained.push(sid);
  }
  if (retained.length > 0) callSessions.set(toolCallId, retained);
  else callSessions.delete(toolCallId);
}


// ─── Extension ────────────────────────────────────────────────────────────
export default function (pi: ExtensionAPI) {
  // SessionStart → checkin + build context (replaces Claude's on-session-start.sh)
  // Resolves the spec mode once (resolveSpecMode, the TS mirror of the bash
  // resolver) and injects a `## Spec Mode` block, plus a user-visible one-line
  // banner (ctx.ui.notify) mirroring the Claude plugin `systemMessage` / Codex
  // `$chorus` toast:
  //   connected + openspec -> "Chorus connected at <url> (spec: OpenSpec)"
  //   connected + lite      -> "Chorus connected at <url> (spec: spec-lite)"
  //   connected + off       -> "Chorus connected at <url> (spec: off — free-form)"
  //   connected + openspec-requested-but-unusable -> warning "(spec: OpenSpec requested but unusable — …)"
  //   not configured        -> warning (env vars missing)
  //   connection failed     -> error (checkin couldn't reach Chorus)
  pi.on("session_start", async (event, ctx) => {
    const backend = chorusMcpBackend(pi.getCommands?.() ?? []);
    if (backend) {
      const connection = resolveConnection(ctx.cwd, backend);
      CHORUS_URL = connection.url;
      CHORUS_API_KEY = connection.apiKey;
      CONFIGURED = CHORUS_URL !== "" && CHORUS_API_KEY !== "";
    }
    // Not configured — emit the warning banner and bail (no checkin to attempt).
    if (!CONFIGURED) {
      const banner = buildSessionBanner({
        configured: false,
        connected: false,
        chorusUrl: CHORUS_URL,
        spec: NO_SPEC,
      });
      ctx.ui.notify(banner.message, banner.level);
      return;
    }
    let connected = false;
    try {
      const checkin = await mcpCall("chorus_checkin");
      connected = true;
      // Resolve the spec mode once per session (single source of truth — the TS
      // reimplementation of the bash resolver). Rule: explicit CHORUS_SPEC_MODE
      // wins; unset → OpenSpec when usable, else spec-lite.
      const spec = resolveSpecMode(
        {
          specMode: process.env.CHORUS_SPEC_MODE,
          openspecMode: process.env.CHORUS_OPENSPEC_MODE,
          enableOpenSpec: process.env.CLAUDE_PLUGIN_OPTION_ENABLEOPENSPEC,
          projectRoot: ctx.cwd,
        },
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require("node:fs"),
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require("node:child_process").execSync,
      );
      // Route note per resolved mode (mirrors the bash/Codex `## Spec Mode` block).
      const specRoute =
        spec.specMode === "lite"
          ? "Routing: lite → follow the `spec-lite` skill (/skill:spec-lite). A capability's durable spec is `.chorus/specs/<slug>/spec.md` (edited in place, **never synced**, git history is its record); each change is a dated folder `.chorus/specs/<slug>/<YYYY-MM-DD>-<change-slug>/` of Chorus-typed docs (`prd.md` required; `tech_design.md` / `adr.md` / `guide.md` / `spec.md` optional) that **are** mirrored 1:1 into persistent Chorus Documents via `chorus mcp call … --arg-file content=<file>` (fallback `chorus-mcp-call.sh`). Put a `Spec-lite: .chorus/specs/<slug>/<YYYY-MM-DD>-<change-slug>/` locator line in the proposal description. Do NOT scaffold `openspec/changes/` or add an `OpenSpec change slug:` line."
          : spec.specMode === "off"
            ? "Routing: off → free-form, no spec artifact. Do NOT create `.chorus/specs/` or `openspec/changes/` files; author document drafts inline via direct MCP."
            : spec.specFail
              ? `Routing: openspec → **cannot be honored** — ${spec.specFail}. The proposal / yolo skill MUST halt after resolving the mode; do NOT silently fall back to lite/free-form. Surface this to the user.${spec.openspecHint ? ` Install hint: ${spec.openspecHint}.` : ""}`
              : `CHORUS_OPENSPEC_ACTIVE=1 (${spec.openspecUsableReason})\n\nRouting: openspec → load the openspec-aware skill (/skill:openspec-aware) and follow §3 (OpenSpec authoring) — do NOT re-run the §1 detection block, the answer is already known.\n\nCritical rule (openspec-aware §2 Rule 1): document mirror calls (\`chorus_pm_add_document_draft\` / \`chorus_pm_update_document_draft\` / \`chorus_pm_update_document\`) MUST fill \`content\` from the local file — prefer \`chorus mcp call <tool> '<json>' --arg-file content=<file>\`, falling back to \`chorus-mcp-call.sh\` when \`chorus\` is not on PATH. Do NOT invoke these MCP tools directly with hand-typed \`content\` in OpenSpec mode.`;
      checkinContext = [
        "# Chorus Plugin — Active",
        "",
        `Chorus is connected at ${CHORUS_URL}. Session lifecycle hooks are enabled.`,
        "",
        "## Checkin",
        "",
        "```json",
        JSON.stringify(checkin, null, 2),
        "```",
        "",
        "## Spec Mode",
        "",
        `CHORUS_SPEC_MODE=${spec.specMode} (${spec.specReason})`,
        "",
        specRoute,
        "",
        "## Quick Reference",
        "- **Sessions**: auto-managed. When you dispatch a WORKER via the `subagent` tool (one child per call; the bundled subagent also takes `tasks`/`chain` composites — nicobailon `pi-subagents` rejects those top-level fields, so a wave there is one single dispatch per worker), the extension creates a Chorus session per worker task and injects its UUID + the session workflow into that task automatically; the extension closes that session when the dispatch returns (blocking implementations) or when the run settles — `subagent:async-complete` / `process-terminal` — under nicobailon `pi-subagents`, which is where Chorus agents run by default. Do NOT call chorus_create_session/close_session yourself.",
        "- **Notifications**: chorus_get_notifications() fetches and auto-marks read.",
        "- **Reviewer sub-agents**: after submit_proposal/submit_for_verify the extension nudges you to spawn chorus-proposal-reviewer / chorus-task-reviewer. Dispatch it with the `subagent` tool and wait for its VERDICT comment — reviewers are pinned to the background/async path, because a foreground child has no `mcp` and could not post the comment; reviewers do NOT get a Chorus session.",
        "- **Code-review gateway**: bounded by `CHORUS_MAX_CODE_REVIEW_ROUNDS` (current: " + (MAX_CODE_REVIEW_ROUNDS === 0 ? "unlimited" : String(MAX_CODE_REVIEW_ROUNDS)) + "; on FAIL, fix via /skill:quick-dev and re-run — after the limit, escalate the Idea's feature-level BLOCKERs to a human instead of shipping.",
        (CHORUS_BIN
          ? "- **OpenSpec wrapper**: `bin/chorus-mcp-call.sh` is at `" + CHORUS_BIN + "` — the CLI-absent fallback for OpenSpec-mode document mirrors. Prefer `chorus mcp call <tool> '<json>' --arg-file content=<file>` (chorus >= 0.17.0); use this wrapper only when `chorus` is not on PATH (a bare `chorus-mcp-call.sh` will NOT be on PATH for local-path installs). See /skill:openspec-aware §2."
          : "- **OpenSpec wrapper**: `bin/chorus-mcp-call.sh` was not resolved relative to the extension — it is the CLI-absent fallback for OpenSpec-mode document mirrors (prefer `chorus mcp call <tool> '<json>' --arg-file content=<file>`). If you need it, locate it with `find ~/.pi/agent/npm -path '*chorus-pi/bin/chorus-mcp-call.sh'`. See /skill:openspec-aware §2."),
        "- **Skills**: /skill:chorus, /skill:idea, /skill:proposal, /skill:develop, /skill:review, /skill:quick-dev, /skill:yolo, /skill:spec-lite, /skill:openspec-aware",
      ].join("\n");
      const banner = buildSessionBanner({
        configured: true,
        connected: true,
        chorusUrl: CHORUS_URL,
        spec,
      });
      ctx.ui.notify(banner.message, banner.level);
    } catch (e) {
      checkinContext = `# Chorus: connection failed (${CHORUS_URL})\n\n${(e as Error).message}`;
      const banner = buildSessionBanner({
        configured: true,
        connected: false,
        chorusUrl: CHORUS_URL,
        spec: NO_SPEC,
      });
      ctx.ui.notify(banner.message, banner.level);
    }
  });

  // Inject checkin context once per session, before the first agent run
  // (replaces Claude's additionalContext + the noisy UserPromptSubmit hook)
  pi.on("before_agent_start", async () => {
    if (injectedOnce || !checkinContext) return;
    injectedOnce = true;
    return {
      message: { customType: "chorus", content: checkinContext, display: false },
    };
  });

  // tool_call (pre-execution, MUTABLE input) → for each WORKER task in the
  // `subagent` invocation (single / parallel / chain), create a Chorus session
  // and inject its UUID + the session workflow into that task. The ephemeral
  // child pi subprocess spawned for that task receives the UUID in its prompt.
  pi.on("tool_call", async (event, ctx) => {
    if (!CONFIGURED || event.toolName !== "subagent") return;
    const items = subagentTaskItems(event.input);
    // Every Chorus agent this extension spawns needs ambient MCP tools: the
    // reviewers post their VERDICT with chorus_add_comment, and the workers run
    // the whole task lifecycle (chorus_session_checkin_task / chorus_update_task
    // / chorus_report_work / chorus_submit_for_verify) — both agent bodies forbid
    // curl. Under the nicobailon `pi-subagents` implementation an in-process
    // foreground child (`async: false`) never loads the parent's ambient
    // extensions, so those tools simply do not exist: for a reviewer the declared
    // `tools` allowlist turns that into a failed run, for a worker (no allowlist)
    // it degrades silently. Pin both to the background path whatever the caller
    // asked for; the bundled subagent ignores the flag and keeps blocking + MCP.
    // The pin is CALL-level: one call has one mode, derived from the top-level
    // `async` (an item-level one is read by nothing), so a composite carrying a
    // Chorus agent is pinned as a whole.
    if (items.some((item) => isReviewerAgent(item.agent) || isWorkerAgent(item.agent)) && forceSubagentCallAsync(event.input)) {
      // The caller asked for foreground and we overrode it — surface that
      // instead of silently changing how their dispatch runs.
      ctx.ui.notify(
        "Chorus agents need ambient `mcp`/`chorus_*` tools, which a foreground child does not have — this dispatch was pinned to the background (async) path.",
        "info",
      );
    }
    // Positive worker classification: only canonical worker agents get a Chorus
    // session + task-lifecycle injection. The three Chorus reviewers are not
    // workers (read-only), and the example scout/planner/reviewer agents are
    // read-only too — injecting the session workflow into them adds irrelevant
    // instructions and unnecessary chorus_create_session traffic. See isWorkerAgent().
    const created: string[] = [];
    for (const item of items) {
      if (!isWorkerAgent(item.agent)) continue;
      // Manual main-agent template already injected — never double-inject.
      if (hasSessionMarker(item.task)) continue;
      try {
        const session = await mcpCall<{ uuid?: string }>("chorus_create_session", { name: item.agent });
        if (!session?.uuid) continue;
        created.push(session.uuid);
        // Mutate the task in place — the ephemeral child receives the UUID.
        item.setTask(item.task + sessionWorkflow(session.uuid));
      } catch {
        // Non-fatal: worker runs without observability (same as Codex fallback).
      }
    }
    if (created.length > 0) callSessions.set(event.toolCallId, created);
  });
  // tool_result (fires first; has input + details + content as first-class fields)
  // → PRIMARY handler that closes the ephemeral worker session(s) once a `subagent`
  //   tool call returns. The official subagent children are ephemeral (spawn → run
  //   → exit within one tool call), so the session lifecycle collapses to
  //   "create on tool_call start, close on tool_result".
  // → Also fires reviewer nudges after the 3 chorus_* submit/verify tools.
  pi.on("tool_result", async (event, ctx) => {
    if (!CONFIGURED) return;

    // ── subagent tool finished → close the worker session(s) ───────────
    // The official blocking subagent closes sessions at tool_result; the
    // nicobailon `pi-subagents` tool is async (detached) by default, so its
    // tool_result carries `details.asyncId` and the run completes later via
    // the pi event bus — in that case move the sessions to runIdToSid and
    // let subagent:async-complete / subagent:process-terminal close them.
    if (event.toolName === "subagent") {
      const runId = extractRunIdFromToolResultEvent(event);
      if (runId) {
        const sids = callSessions.get(event.toolCallId);
        if (sids && sids.length > 0) {
          runIdToSid.set(runId, [...(runIdToSid.get(runId) ?? []), ...sids]);
          callSessions.delete(event.toolCallId);
          ctx.ui.notify(`Chorus session(s): ${sids.map((s) => s.slice(0, 8)).join(",")}… deferred to async run ${runId.slice(0, 8)}…`, "info");
        }
        return;
      }
      // Blocking run (or no run id) — close now. closeCallSessions is
      // idempotent and retains any session whose close fails for a shutdown retry.
      await closeCallSessions(event.toolCallId, ctx);
      return;
    }

    // Reviewer nudges only fire on a successful chorus_* call.
    const adapterError = event.details && typeof event.details === "object"
      ? (event.details as { error?: unknown }).error : undefined;
    if (event.isError || (typeof adapterError === "string" && adapterError.length > 0)) return;

    // ── Reviewer nudges (the 3 Claude PostToolUse hooks) ──────────────
    // Resolve only the outer toolName using an exact workflow suffix with any
    // prefix. On Pi 1.x this includes native codemode child events: their own
    // toolName is the real mcp__<server>__<tool>, with parentToolCallId linking
    // the codemode call. Direct MCP events use the same rule. Arguments and
    // script text never affect recognition; input.tool is never parsed.
    // The codemode parent is a non-target, so it cannot add a second reminder.
    const native = resolveChorusToolName(event);
    if (native && (NUDGE_TOOL_NAMES as readonly string[]).includes(native)) {
      const nudges: Record<string, { spawn: string; enabled: boolean }> = {
        chorus_pm_submit_proposal: {
          spawn: "spawn chorus-proposal-reviewer to review the proposal, wait for its VERDICT comment, then close the agent",
          enabled: ENABLE_PROPOSAL_REVIEWER,
        },
        chorus_submit_for_verify: {
          spawn: "spawn chorus-task-reviewer to review the task, wait for its VERDICT comment, then close the agent",
          enabled: ENABLE_TASK_REVIEWER,
        },
        chorus_admin_verify_task: {
          spawn: "if this was the last task of an idea-rooted proposal: spawn chorus-code-reviewer over the idea's aggregate change, wait for its VERDICT comment, then remind to archive the openspec change",
          enabled: ENABLE_CODE_REVIEWER,
        },
      };
      const nudge = nudges[native];
      if (nudge?.enabled) {
        pi.sendUserMessage(nudge.spawn, { deliverAs: "steer" });
      }
    }
  });

  // tool_execution_end → idempotent FALLBACK close of the worker session(s).
  // tool_result normally fires first and already closed (and deleted) them, so
  // this is a no-op in the common case. It exists so that if tool_result did not
  // fire — or its close failed and retained the session — the sessions are still
  // closed (or retried) here rather than leaking until session_shutdown.
  // Reviewer nudges stay in tool_result above so this fallback cannot inject
  // a second reminder.
  pi.on("tool_execution_end", async (event, ctx) => {
    if (!CONFIGURED) return;
    if (event.toolName === "subagent") {
      // tool_result already moved async sessions to runIdToSid — nothing left
      // in callSessions for them. Blocking runs (or failed injection) close here.
      await closeCallSessions(event.toolCallId, ctx);
    }
  });

  // ── nicobailon async/detached `subagent` runs: close by runId ──────
  // tool_result deferred these sessions to runIdToSid; completion arrives on
  // the pi event bus. Delete the mapping BEFORE issuing the close so a
  // duplicate lifecycle event cannot double-close; re-add on failure so the
  // shutdown sweep can still retry it.
  //
  // In-flight closes are tracked so session_shutdown can await them before
  // sweeping: a close that fails after the sweep ran would otherwise re-add
  // its entry after the map was cleared (retry lost + stale entry).
  const inflightCloses = new Set<Promise<void>>();
  const closeRunSessions = (runId: string): void => {
    const sids = runIdToSid.get(runId);
    if (!sids || sids.length === 0) return;
    runIdToSid.delete(runId);
    const p: Promise<void> = (async () => {
      const failed: string[] = [];
      for (const sid of sids) {
        try { await mcpCall("chorus_close_session", { sessionUuid: sid }); } catch { failed.push(sid); }
      }
      if (failed.length > 0) {
        runIdToSid.set(runId, failed);
        console.warn(`[chorus-pi] failed to close ${failed.length} session(s) for run ${runId}: ${failed.join(", ")} — will retry at session_shutdown`);
      }
    })();
    inflightCloses.add(p);
    void p.finally(() => inflightCloses.delete(p));
  };
  // Only `runId` is trusted on async-complete; `id` (runId-or-id shape) is
  // accepted only on process-terminal, since async-complete could carry an
  // unrelated id field alongside runId.
  const eventBusRunId = (data: unknown, allowId: boolean): string | null => {
    const d = (data ?? {}) as Record<string, unknown>;
    if (typeof d.runId === "string" && d.runId) return d.runId;
    if (allowId && typeof d.id === "string" && d.id) return d.id;
    return null;
  };
  pi.events.on("subagent:async-complete", (data) => {
    const runId = eventBusRunId(data, false);
    if (runId) closeRunSessions(runId);
  });
  pi.events.on("subagent:process-terminal", (data) => {
    const runId = eventBusRunId(data, true);
    if (runId) closeRunSessions(runId);
  });

  // SessionEnd → close any stray worker sessions (replaces Claude's on-session-end.sh).
  // Retries every session still tracked in callSessions (e.g. a subagent call whose
  // close failed and was retained, or that never saw a tool_result/tool_execution_end).
  pi.on("session_shutdown", async () => {
    // Wait for in-flight async closes to settle FIRST: a close that fails
    // re-adds into runIdToSid, and the sweep below must see it (otherwise the
    // retry is lost and a stale entry survives the clear).
    await Promise.allSettled([...inflightCloses]);
    for (const sids of callSessions.values()) {
      for (const sid of sids) {
        await mcpCall("chorus_close_session", { sessionUuid: sid }).catch(() => {});
      }
    }
    for (const sids of runIdToSid.values()) {
      for (const sid of sids) {
        await mcpCall("chorus_close_session", { sessionUuid: sid }).catch(() => {});
      }
    }
    callSessions.clear();
    runIdToSid.clear();
    injectedOnce = false;
    checkinContext = null;
  });
}
