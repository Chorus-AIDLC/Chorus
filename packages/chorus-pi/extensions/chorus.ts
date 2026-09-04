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
 * MCP: no installer needed. pi-mcp-adapter auto-discovers the repo's .mcp.json
 * (or ~/.pi/agent/mcp.json) and exposes the chorus_* tools to the main agent.
 * This extension only calls chorus_* for its own bookkeeping (checkin, session
 * create/close) over a direct MCP-over-HTTP fetch — it does NOT rely on the
 * main agent's MCP gateway for that, so hooks fire even before the first turn.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
  isWorkerAgent,
  subagentTaskItems,
  sessionWorkflow,
  hasSessionMarker,
  extractRunIdFromToolResultEvent,
  detectOpenSpec,
  buildSessionBanner,
  parseMaxCodeReviewRounds,
  resolveChorusBin,
  resolveChorusConfigFromMcpJson,
  resolveChorusToolName,
  NUDGE_TOOL_NAMES,
} from "../lib/lib.js";

// ─── Config ────────────────────────────────────────────────────────────
// Connection: CHORUS_URL + CHORUS_API_KEY env vars take precedence. When
// either is unset, fall back to the .mcp.json that pi-mcp-adapter auto-
// discovers (project-root .mcp.json, then ~/.pi/agent/mcp.json) so a single
// config source covers both the MCP gateway (literal URL+Bearer) and this
// extension's own checkin / the OpenSpec wrapper script.
const _envUrl = process.env.CHORUS_URL ?? "";
const _envKey = process.env.CHORUS_API_KEY ?? "";
const _mcp = _envUrl && _envKey
  ? { url: "", apiKey: "" }
  : (() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const _fs = require("node:fs");
      const _home = process.env.HOME || "";
      return resolveChorusConfigFromMcpJson(
        [`${process.cwd()}/.mcp.json`, `${_home}/.pi/agent/mcp.json`],
        { existsSync: _fs.existsSync },
        (p: string) => _fs.readFileSync(p, "utf-8"),
      );
    })();
const CHORUS_URL = _envUrl || _mcp.url;
const CHORUS_API_KEY = _envKey || _mcp.apiKey;
const OPENSPEC_OPTOUT = process.env.CHORUS_OPENSPEC_MODE === "off";

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
const CONFIGURED = CHORUS_URL !== "" && CHORUS_API_KEY !== "";

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
let mcpSessionId: string | null = null;

function endpoint(): string {
  const base = CHORUS_URL.replace(/\/$/, "");
  return base.includes("/api/mcp") ? base : `${base}/api/mcp`;
}

async function mcpCall<T = unknown>(tool: string, args: Record<string, unknown> = {}): Promise<T> {
  const url = endpoint();
  const headers: Record<string, string> = {
    Authorization: `Bearer ${CHORUS_API_KEY}`,
    "Content-Type": "application/json",
    Accept: "application/json, text/event-stream",
  };
  if (mcpSessionId) headers["Mcp-Session-Id"] = mcpSessionId;

  // 1. initialize
  const init = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "chorus-pi", version: PKG_VERSION },
      },
    }),
  });
  mcpSessionId = init.headers.get("mcp-session-id") ?? mcpSessionId;

  // 2. initialized notification (no reply expected)
  await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });

  // 3. tools/call
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: tool, arguments: args },
    }),
  });
  let raw = await res.text();
  // Streamable transport may wrap in SSE framing; strip 'data: ' prefix.
  if (/^(event:|data:)/m.test(raw)) {
    raw = raw
      .split("\n")
      .find((l) => l.startsWith("data: "))
      ?.slice(6) ?? raw;
  }
  const json = JSON.parse(raw);
  if (json.error) throw new Error(`MCP ${tool}: ${json.error.message ?? JSON.stringify(json.error)}`);
  const text = json.result?.content?.[0]?.text ?? "{}";
  try {
    return JSON.parse(text) as T;
  } catch {
    return text as unknown as T;
  }
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
  // Emits a user-visible one-line banner (ctx.ui.notify) mirroring the Claude
  // plugin's SessionStart `systemMessage` / the Codex `$chorus` toast (#442):
  //   connected + active   -> "Chorus connected at <url> (OpenSpec Enabled)"
  //   connected + opt-out   -> "Chorus connected at <url> (OpenSpec off)"
  //   connected + unset     -> "Chorus connected at <url> (OpenSpec off — run /skill:chorus enable openspec to set it up)"
  //   not configured        -> warning (env vars missing)
  //   connection failed     -> error (checkin couldn't reach Chorus)
  pi.on("session_start", async (event, ctx) => {
    // Not configured — emit the warning banner and bail (no checkin to attempt).
    if (!CONFIGURED) {
      const banner = buildSessionBanner({
        configured: false,
        connected: false,
        chorusUrl: CHORUS_URL,
        openspec: { active: false, reason: "not configured", optout: false, hint: "" },
      });
      ctx.ui.notify(banner.message, banner.level);
      return;
    }
    let connected = false;
    try {
      const checkin = await mcpCall("chorus_checkin");
      connected = true;
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const os = detectOpenSpec(
        ctx.cwd,
        OPENSPEC_OPTOUT,
        require("node:fs"),
        require("node:child_process").execSync,
      );
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
        "## OpenSpec Mode",
        "",
        `CHORUS_OPENSPEC_ACTIVE=${os.active} (${os.reason})`,
        os.active
          ? "OpenSpec mode is **active**. proposal/develop/yolo skills follow the openspec-aware path."
          : os.optout
            ? "OpenSpec was **explicitly turned off** — do not nag."
            : os.hint
              ? `Note: this repo has an \`openspec/\` directory but the \`openspec\` CLI is not installed — ${os.hint}. Run \`/skill:chorus enable openspec\` to set it up.`
              : "OpenSpec is not set up in this repo. Spec-driven authoring is optional — free-form works fine. If the user wants spec-driven mode, run `/skill:chorus enable openspec` (§6 walks the install + re-launch).",
        "",
        "## Quick Reference",
        "- **Sessions**: auto-managed. When you dispatch a WORKER via the `subagent` tool (single/parallel/chain), the extension creates a Chorus session per worker task and injects its UUID + the session workflow into that task automatically; the session is closed when the `subagent` tool call returns (children are ephemeral). Do NOT call chorus_create_session/close_session yourself.",
        "- **Notifications**: chorus_get_notifications() fetches and auto-marks read.",
        "- **Reviewer sub-agents**: after submit_proposal/submit_for_verify the extension nudges you to spawn chorus-proposal-reviewer / chorus-task-reviewer. Use the blocking `subagent` tool so it waits for the VERDICT; reviewers do NOT get a Chorus session.",
        "- **Code-review gateway**: bounded by `CHORUS_MAX_CODE_REVIEW_ROUNDS` (current: " + (MAX_CODE_REVIEW_ROUNDS === 0 ? "unlimited" : String(MAX_CODE_REVIEW_ROUNDS)) + "; on FAIL, fix via /skill:quick-dev and re-run — after the limit, escalate the Idea's feature-level BLOCKERs to a human instead of shipping.",
        (CHORUS_BIN
          ? "- **OpenSpec wrapper**: `bin/chorus-mcp-call.sh` is at `" + CHORUS_BIN + "` — the CLI-absent fallback for OpenSpec-mode document mirrors. Prefer `chorus mcp call <tool> '<json>' --arg-file content=<file>` (chorus >= 0.17.0); use this wrapper only when `chorus` is not on PATH (a bare `chorus-mcp-call.sh` will NOT be on PATH for local-path installs). See /skill:openspec-aware §2."
          : "- **OpenSpec wrapper**: `bin/chorus-mcp-call.sh` was not resolved relative to the extension — it is the CLI-absent fallback for OpenSpec-mode document mirrors (prefer `chorus mcp call <tool> '<json>' --arg-file content=<file>`). If you need it, locate it with `find ~/.pi/agent/npm -path '*chorus-pi/bin/chorus-mcp-call.sh'`. See /skill:openspec-aware §2."),
        "- **Skills**: /skill:chorus, /skill:idea, /skill:proposal, /skill:develop, /skill:review, /skill:quick-dev, /skill:yolo",
      ].join("\n");
      const banner = buildSessionBanner({
        configured: true,
        connected: true,
        chorusUrl: CHORUS_URL,
        openspec: os,
      });
      ctx.ui.notify(banner.message, banner.level);
    } catch (e) {
      checkinContext = `# Chorus: connection failed (${CHORUS_URL})\n\n${(e as Error).message}`;
      const banner = buildSessionBanner({
        configured: true,
        connected: false,
        chorusUrl: CHORUS_URL,
        openspec: { active: false, reason: "connection failed", optout: false, hint: "" },
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
  pi.on("tool_call", async (event, _ctx) => {
    if (!CONFIGURED || event.toolName !== "subagent") return;
    // Positive worker classification: only canonical worker agents get a Chorus
    // session + task-lifecycle injection. The three Chorus reviewers are not
    // workers (read-only), and the example scout/planner/reviewer agents are
    // read-only too — injecting the session workflow into them adds irrelevant
    // instructions and unnecessary chorus_create_session traffic. See isWorkerAgent().
    const created: string[] = [];
    for (const item of subagentTaskItems(event.input)) {
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
    if (event.isError) return;

    // ── Reviewer nudges (the 3 Claude PostToolUse hooks) ──────────────
    // In MCP gateway mode event.toolName === "mcp" and the real chorus tool
    // name is in event.input.tool. resolveChorusToolName handles both gateway
    // and direct modes and returns the native name (e.g. "chorus_submit_for_verify").
    const native = resolveChorusToolName(event);
    if (native && (NUDGE_TOOL_NAMES as readonly string[]).includes(native)) {
      const nudges: Record<string, { spawn: string; enabled: boolean }> = {
        chorus_pm_submit_proposal: {
          spawn: "spawn chorus-proposal-reviewer to review the proposal (blocking subagent tool), then close the agent",
          enabled: ENABLE_PROPOSAL_REVIEWER,
        },
        chorus_submit_for_verify: {
          spawn: "spawn chorus-task-reviewer to review the task (blocking subagent tool), then close the agent",
          enabled: ENABLE_TASK_REVIEWER,
        },
        chorus_admin_verify_task: {
          spawn: "if this was the last task of an idea-rooted proposal: spawn chorus-code-reviewer over the idea's aggregate change (blocking subagent tool), then remind to archive the openspec change",
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
  // NOTE: this event has NO `input` field (per pi ToolExecutionEndEvent type),
  // so reviewer nudges (which need event.input to resolve the chorus tool name in
  // MCP gateway mode) are handled in tool_result above, not here.
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
  const closeRunSessions = (runId: string): void => {
    const sids = runIdToSid.get(runId);
    if (!sids || sids.length === 0) return;
    runIdToSid.delete(runId);
    void (async () => {
      const failed: string[] = [];
      for (const sid of sids) {
        try { await mcpCall("chorus_close_session", { sessionUuid: sid }); } catch { failed.push(sid); }
      }
      if (failed.length > 0) runIdToSid.set(runId, failed);
    })();
  };
  const eventBusRunId = (data: unknown): string | null => {
    const d = (data ?? {}) as Record<string, unknown>;
    if (typeof d.runId === "string" && d.runId) return d.runId;
    if (typeof d.id === "string" && d.id) return d.id;
    return null;
  };
  pi.events.on("subagent:async-complete", (data) => {
    const runId = eventBusRunId(data);
    if (runId) closeRunSessions(runId);
  });
  pi.events.on("subagent:process-terminal", (data) => {
    const runId = eventBusRunId(data);
    if (runId) closeRunSessions(runId);
  });

  // SessionEnd → close any stray worker sessions (replaces Claude's on-session-end.sh).
  // Retries every session still tracked in callSessions (e.g. a subagent call whose
  // close failed and was retained, or that never saw a tool_result/tool_execution_end).
  pi.on("session_shutdown", async () => {
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
    mcpSessionId = null;
  });
}
