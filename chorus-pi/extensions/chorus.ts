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
 *   - tool_call (subagent_spawn, pre-execution, MUTABLE input)
 *                            → create a Chorus session and inject its UUID + the session
 *                              workflow into the spawned worker's task. This is the
 *                              Pi-native equivalent of Claude's SubagentStart hook
 *                              injecting session context — a capability the Codex port
 *                              lacks (Codex has no pre-spawn mutation channel, so its
 *                              workers must manage sessions manually).
 *   - tool_execution_end     → reviewer nudges after submit_proposal / submit_for_verify
 *                              / admin_verify_task (the 3 PostToolUse hooks)
 *                            → agentId→sessionUuid mapping on spawn result; close orphan
 *                              session on spawn error
 *                            → close the mapped session on subagent_manage close
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
  isReviewerAgent,
  extractAgentId,
  extractAgentIdFromToolResultEvent,
  sessionWorkflow,
  detectOpenSpec,
  resolveChorusToolName,
  NUDGE_TOOL_NAMES,
} from "../lib/lib.js";

// ─── Config ────────────────────────────────────────────────────────────────
const CHORUS_URL = process.env.CHORUS_URL ?? "";
const CHORUS_API_KEY = process.env.CHORUS_API_KEY ?? "";
const OPENSPEC_OPTOUT = process.env.CHORUS_OPENSPEC_MODE === "off";

// Reviewer toggle envs (mirror Claude Code plugin userConfig; Pi has no plugin
// settings UI, so env vars drive them). Defaults: all enabled.
const ENABLE_PROPOSAL_REVIEWER = process.env.CHORUS_ENABLE_PROPOSAL_REVIEWER !== "false";
const ENABLE_TASK_REVIEWER = process.env.CHORUS_ENABLE_TASK_REVIEWER !== "false";
const ENABLE_CODE_REVIEWER = process.env.CHORUS_ENABLE_CODE_REVIEWER !== "false";

const CONFIGURED = CHORUS_URL !== "" && CHORUS_API_KEY !== "";

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
        clientInfo: { name: "chorus-pi", version: "0.14.4" },
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

// ─── Session bookkeeping ──────────────────────────────────────────────────
// agentId (sa_<uuid>, from subagent_spawn result) → Chorus sessionUuid
const sessionMap = new Map<string, string>();
// toolCallId → sessionUuid (pending between tool_call create and tool_result/tool_execution_end map)
const pendingSessions = new Map<string, string>();
// toolCallIds whose agentId→sessionUuid mapping was already done by tool_result (so tool_execution_end skips them)
const spawnMapped = new Set<string>();
let checkinContext: string | null = null;
let injectedOnce = false;


// ─── Extension ────────────────────────────────────────────────────────────
export default function (pi: ExtensionAPI) {
  // SessionStart → checkin + build context (replaces Claude's on-session-start.sh)
  pi.on("session_start", async (event, ctx) => {
    if (!CONFIGURED) return;
    try {
      const checkin = await mcpCall("chorus_checkin");
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
              ? `Note: ${os.hint}`
              : "",
        "",
        "## Quick Reference",
        "- **Sessions**: auto-managed. When you `subagent_spawn` a worker, the extension creates a Chorus session and injects its UUID + the session workflow into the worker's task automatically. When you `subagent_manage close` the agent, the extension closes the session. Do NOT call chorus_create_session/close_session yourself.",
        "- **Notifications**: chorus_get_notifications() fetches and auto-marks read.",
        "- **Reviewer sub-agents**: after submit_proposal/submit_for_verify the extension nudges you to spawn chorus-proposal-reviewer / chorus-task-reviewer. Use the blocking `subagent` tool so it waits for the VERDICT; reviewers do NOT get a Chorus session.",
        "- **Skills**: /skill:chorus, /skill:idea, /skill:proposal, /skill:develop, /skill:review, /skill:quick-dev, /skill:yolo",
      ].join("\n");
    } catch (e) {
      checkinContext = `# Chorus: connection failed (${CHORUS_URL})\n\n${(e as Error).message}`;
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

  // tool_call (pre-execution, MUTABLE input) → create session + inject sessionUuid
  // into the spawned worker's task. The spawned subprocess receives the UUID.
  pi.on("tool_call", async (event, _ctx) => {
    if (!CONFIGURED || event.toolName !== "subagent_spawn") return;
    const input = event.input as { agent?: string; task?: string };
    const agentName = input?.agent ?? "";
    // Reviewers and non-worker agents don't get a Chorus session.
    if (isReviewerAgent(agentName) || !input.task) return;
    try {
      const session = await mcpCall<{ uuid?: string }>("chorus_create_session", { name: agentName });
      if (!session?.uuid) return;
      pendingSessions.set(event.toolCallId, session.uuid);
      // Mutate the task in place — the spawned subprocess receives the UUID.
      input.task = input.task + sessionWorkflow(session.uuid);
    } catch {
      // Non-fatal: worker runs without observability (same as Codex fallback).
    }
  });
  // tool_result (fires first; has input + details + content as first-class fields)
  // → PRIMARY handler for BOTH ends of the session lifecycle:
  //   - subagent_spawn  → map agentId → sessionUuid (from event.details.agent.id)
  //   - subagent_manage {action:"close"} → close the mapped session (from event.input)
  // Per pi source (agent-session.js afterToolCall), emitToolResult receives
  // `input: args, content: result.content, details: result.details` directly from
  // the tool's return — NOT nested under `result` like tool_execution_end, and
  // `input` IS present (unlike tool_execution_end which has no input field).
  pi.on("tool_result", async (event, ctx) => {
    if (!CONFIGURED || event.isError) return;

    // ── subagent_spawn → map agentId → sessionUuid ─────────────────────
    if (event.toolName === "subagent_spawn") {
      const sid = pendingSessions.get(event.toolCallId);
      if (!sid) return;
      const agentId = extractAgentIdFromToolResultEvent(event);
      if (agentId) {
        sessionMap.set(agentId, sid);
        spawnMapped.add(event.toolCallId);
        ctx.ui.notify(`Chorus session: ${sid.slice(0, 8)}… (worker ${agentId.slice(0, 11)}…)`, "info");
      } else {
        // tool_result had the best shot and still failed — log for diagnostics.
        // tool_execution_end will try event.result as a last resort.
        console.error("[chorus-pi] tool_result could not extract agentId. event keys:",
          Object.keys(event), "details:", event.details, "content:", event.content?.map((c: any) => c?.text));
      }
      return;
    }

    // ── subagent_manage {action:"close"} → close the mapped session ───
    // tool_result has event.input (ToolResultEventBase.input) — tool_execution_end does NOT.
    if (event.toolName === "subagent_manage") {
      const input = event.input as { action?: string; agentId?: string };
      if (input?.action !== "close" || !input.agentId) return;
      const sid = sessionMap.get(input.agentId);
      if (sid) {
        await mcpCall("chorus_close_session", { sessionUuid: sid }).catch(() => {});
        sessionMap.delete(input.agentId);
        ctx.ui.notify(`Chorus: closed session ${sid.slice(0, 8)}…`, "info");
      } else {
        // No mapping for this agentId — either it was a reviewer (no session),
        // the spawn mapping failed, or the agent predated this session.
        ctx.ui.notify(`Chorus: no session mapped to ${input.agentId.slice(0, 11)}… — nothing to close`, "warning");
      }
      return;
    }

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

  // tool_execution_end → FALLBACK agentId extraction + error cleanup + reviewer nudges
  // NOTE: this event has NO `input` field (per pi ToolExecutionEndEvent type).
  // subagent_manage close is handled in tool_result above, not here.
  pi.on("tool_execution_end", async (event, ctx) => {
    if (!CONFIGURED) return;

    // ── subagent_spawn result: map agentId → sessionUuid (or close orphan on error)
    if (event.toolName === "subagent_spawn") {
      const sid = pendingSessions.get(event.toolCallId);
      pendingSessions.delete(event.toolCallId);
      if (!sid) return;
      if (event.isError) {
        await mcpCall("chorus_close_session", { sessionUuid: sid }).catch(() => {});
        return;
      }
      // tool_result already mapped this one — nothing to do.
      if (spawnMapped.has(event.toolCallId)) {
        spawnMapped.delete(event.toolCallId);
        return;
      }
      // Fallback: tool_result didn't fire or couldn't extract. Try event.result.
      const agentId = extractAgentId(event.result);
      if (agentId) {
        sessionMap.set(agentId, sid);
        ctx.ui.notify(`Chorus session: ${sid.slice(0, 8)}… (worker ${agentId.slice(0, 11)}…)`, "info");
      } else {
        // Diagnostic: log the actual result shape so the runtime contract can be confirmed.
        console.error("[chorus-pi] FALLBACK also failed. result type:", typeof event.result,
          "keys:", event.result && typeof event.result === "object" ? Object.keys(event.result) : "n/a",
          "result:", JSON.stringify(event.result)?.slice(0, 300));
        ctx.ui.notify(`Chorus: created session ${sid.slice(0, 8)}… but could not extract agentId (neither tool_result nor tool_execution_end) — close-on-manage will not fire`, "warning");
      }
      return;
    }

    // subagent_manage close is handled in tool_result (which has event.input);
    // tool_execution_end has no input field, so there is nothing to do here for manage.

    // tool_execution_end has no input field, so there is nothing to do here for manage.

    // tool_execution_end has no input field, so there is nothing to do here for manage.

    // Reviewer nudges are handled in tool_result above (which has event.input,
    // needed to resolve the real chorus tool name in MCP gateway mode).
  });

  // SessionEnd → close any stray sessions (replaces Claude's on-session-end.sh)
  pi.on("session_shutdown", async () => {
    for (const sid of sessionMap.values()) {
      await mcpCall("chorus_close_session", { sessionUuid: sid }).catch(() => {});
    }
    for (const sid of pendingSessions.values()) {
      await mcpCall("chorus_close_session", { sessionUuid: sid }).catch(() => {});
    }
    sessionMap.clear();
    pendingSessions.clear();
    spawnMapped.clear();
    injectedOnce = false;
    checkinContext = null;
    mcpSessionId = null;
  });
}
