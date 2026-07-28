import { test, expect } from "bun:test";
import {
  isReviewerAgent,
  extractAgentId,
  extractAgentIdFromToolResultEvent,
  sessionWorkflow,
  detectOpenSpec,
  buildSessionBanner,
  parseMaxCodeReviewRounds,
  DEFAULT_MAX_CODE_REVIEW_ROUNDS,
  type FsLike,
  type ExecSync,
} from "../lib/lib.js";

// ─── isReviewerAgent ────────────────────────────────────────────────────────
test("isReviewerAgent: matches the three reviewer names", () => {
  expect(isReviewerAgent("chorus-proposal-reviewer")).toBe(true);
  expect(isReviewerAgent("chorus-task-reviewer")).toBe(true);
  expect(isReviewerAgent("chorus-code-reviewer")).toBe(true);
});

test("isReviewerAgent: rejects non-reviewers (workers, built-ins, partials)", () => {
  expect(isReviewerAgent("worker")).toBe(false);
  expect(isReviewerAgent("scout")).toBe(false);
  expect(isReviewerAgent("chorus-proposal")).toBe(false); // missing -reviewer suffix
  expect(isReviewerAgent("chorus-proposal-reviewer-x")).toBe(false);
  expect(isReviewerAgent("")).toBe(false);
});

// ─── extractAgentId ──────────────────────────────────────────────────────────
test("extractAgentId: reads details.agent.id (the pi-subagents summarizeAgent() path)", () => {
  const result = {
    details: { agent: { id: "sa_4d762c7d-213d-4bb3-9fe0-4123bf406c08", agent: "worker", state: "running" } },
  };
  expect(extractAgentId(result)).toBe("sa_4d762c7d-213d-4bb3-9fe0-4123bf406c08");
});

test("extractAgentId: falls back to top-level agentId", () => {
  expect(extractAgentId({ agentId: "sa_fallback" })).toBe("sa_fallback");
});

test("extractAgentId: returns null when neither path present", () => {
  expect(extractAgentId({ details: { agent: {} } })).toBe(null);
  expect(extractAgentId({})).toBe(null);
  expect(extractAgentId(undefined)).toBe(null);
  expect(extractAgentId(null)).toBe(null);
});

test("extractAgentId: parses sa_<uuid> from result content text when details is absent (the runtime-confirmed shape)", () => {
  const text = "Spawned worker as sa_4d762c7d-213d-4bb3-9fe0-4123bf406c08. Do useful non-overlapping work immediately.";
  expect(extractAgentId({ content: [{ type: "text", text }] })).toBe("sa_4d762c7d-213d-4bb3-9fe0-4123bf406c08");
});

test("extractAgentId: parses sa_<uuid> even when surrounded by other text (multiline content)", () => {
  expect(
    extractAgentId({
      content: [{ text: "some prefix\n" }, { text: "Spawned scout as sa_0aa265af-1234-5678-9abc-def012345678. done." }],
    }),
  ).toBe("sa_0aa265af-1234-5678-9abc-def012345678");
});

test("extractAgentId: returns null when content has no sa_<uuid>", () => {
  expect(extractAgentId({ content: [{ text: "some other message" }] })).toBe(null);
});

test("extractAgentId: structured path wins over text fallback", () => {
  const result = {
    details: { agent: { id: "sa_structured" } },
    content: [{ text: "Spawned x as sa_textfallback-0000-…" }],
  };
  expect(extractAgentId(result)).toBe("sa_structured");
});
test("extractAgentId: prefers details.agent.id over agentId when both present", () => {
  expect(
    extractAgentId({
      details: { agent: { id: "sa_primary" } },
      agentId: "sa_secondary",
    }),
  ).toBe("sa_primary");
});

// ─── sessionWorkflow ─────────────────────────────────────────────────────────
test("sessionWorkflow: embeds the session UUID in every step", () => {
  const uuid = "11111111-2222-3333-4444-555555555555";
  const w = sessionWorkflow(uuid);
  // UUID appears in the header and in each of the 5 chorus_* tool calls
  const occurrences = (w.match(new RegExp(uuid, "g")) || []).length;
  expect(occurrences).toBe(5); // header + checkin + update + report + checkout (status uses it too = 5 total calls, but header is 1; count all)
  expect(w).toContain(`Session UUID: ${uuid}`);
  expect(w).toContain(`chorus_session_checkin_task({ sessionUuid: "${uuid}"`);
  expect(w).toContain(`chorus_update_task({ taskUuid: <task-uuid>, status: "in_progress", sessionUuid: "${uuid}"`);
  expect(w).toContain(`chorus_report_work({ taskUuid: <task-uuid>, report: \"...\", sessionUuid: "${uuid}"`);
  expect(w).toContain(`chorus_session_checkout_task({ sessionUuid: "${uuid}"`);
});

test("sessionWorkflow: tells the worker NOT to manage session lifecycle", () => {
  const w = sessionWorkflow("x");
  expect(w).toContain("Do NOT call chorus_create_session");
  expect(w).toContain("chorus_close_session");
});

test("sessionWorkflow: starts with a blank line so it separates cleanly from the task body", () => {
  expect(sessionWorkflow("u").startsWith("\n")).toBe(true);
});

// ─── detectOpenSpec ──────────────────────────────────────────────────────────
// Helpers to build injectable fs/execSync stubs.
function fsWith(dirs: string[]): FsLike {
  return { existsSync: (p: string) => dirs.includes(p) };
}
function execOk(): ExecSync {
  return () => {}; // succeeds (CLI present)
}
function execMissing(): ExecSync {
  return () => {
    throw new Error("not found");
  }; // throws (CLI absent)
}

const CWD = "/proj";

test("detectOpenSpec: optout wins even if dir + CLI present", () => {
  const r = detectOpenSpec(CWD, true, fsWith([`${CWD}/openspec`]), execOk());
  expect(r).toEqual({
    active: false,
    reason: "CHORUS_OPENSPEC_MODE=off (explicit opt-out)",
    optout: true,
    hint: "",
  });
});

test("detectOpenSpec: no openspec/ dir → inactive, not optout", () => {
  const r = detectOpenSpec(CWD, false, fsWith([]), execOk());
  expect(r.active).toBe(false);
  expect(r.optout).toBe(false);
  expect(r.reason).toContain("no openspec/ directory");
  expect(r.hint).toBe("");
});

test("detectOpenSpec: dir present but CLI missing → inactive with install hint", () => {
  const r = detectOpenSpec(CWD, false, fsWith([`${CWD}/openspec`]), execMissing());
  expect(r).toEqual({
    active: false,
    reason: "openspec/ directory present but `openspec` CLI not on PATH",
    optout: false,
    hint: "install with: npm i -g @fission-ai/openspec",
  });
});

test("detectOpenSpec: dir + CLI both present → active", () => {
  const r = detectOpenSpec(CWD, false, fsWith([`${CWD}/openspec`]), execOk());
  expect(r).toEqual({
    active: true,
    reason: "openspec/ directory + openspec CLI both present",
    optout: false,
    hint: "",
  });
});

test("detectOpenSpec: CLI presence is probed only when the dir exists (optout short-circuits first)", () => {
  let calls = 0;
  const exec = (() => {
    calls++;
  }) as unknown as ExecSync;
  // optout=true → must NOT touch execSync even if dir missing
  detectOpenSpec(CWD, true, fsWith([]), exec);
  expect(calls).toBe(0);
  // dir missing → must NOT touch execSync either
  detectOpenSpec(CWD, false, fsWith([]), exec);
  expect(calls).toBe(0);
  // dir present → must probe execSync
  detectOpenSpec(CWD, false, fsWith([`${CWD}/openspec`]), exec);
  expect(calls).toBe(1);
});

// ─── extractAgentId: string fallback (path #4) ─────────────────────────────
test("extractAgentId: parses sa_<uuid> from a plain string result", () => {
  expect(extractAgentId("Spawned worker as sa_99999999-aaaa-bbbb-cccc-dddddddddddd. Done.")).toBe(
    "sa_99999999-aaaa-bbbb-cccc-dddddddddddd",
  );
});

test("extractAgentId: returns null for a string with no sa_<uuid>", () => {
  expect(extractAgentId("some text without an agent id")).toBe(null);
});

// ─── extractAgentIdFromToolResultEvent ──────────────────────────────────────
test("extractAgentIdFromToolResultEvent: reads details.agent.id directly", () => {
  expect(
    extractAgentIdFromToolResultEvent({
      details: { agent: { id: "sa_aaaa1111-2222-3333-4444-555555555555" } },
    }),
  ).toBe("sa_aaaa1111-2222-3333-4444-555555555555");
});

test("extractAgentIdFromToolResultEvent: falls back to content text", () => {
  expect(
    extractAgentIdFromToolResultEvent({
      content: [{ text: "Spawned x as sa_bbbb2222-3333-4444-5555-666666666666." }],
    }),
  ).toBe("sa_bbbb2222-3333-4444-5555-666666666666");
});

test("extractAgentIdFromToolResultEvent: returns null when neither present", () => {
  expect(extractAgentIdFromToolResultEvent({})).toBe(null);
  expect(extractAgentIdFromToolResultEvent({ details: {} })).toBe(null);
});

// ─── normalizeChorusToolName + resolveChorusToolName ────────────────────────
import { normalizeChorusToolName, resolveChorusToolName, NUDGE_TOOL_NAMES } from "../lib/lib.js";

test("normalizeChorusToolName: native name passes through", () => {
  expect(normalizeChorusToolName("chorus_submit_for_verify")).toBe("chorus_submit_for_verify");
});

test("normalizeChorusToolName: strips one chorus_ server prefix (gateway/direct-server mode)", () => {
  expect(normalizeChorusToolName("chorus_chorus_submit_for_verify")).toBe("chorus_submit_for_verify");
});

test("normalizeChorusToolName: returns null for non-chorus tools", () => {
  expect(normalizeChorusToolName("bash")).toBe(null);
  expect(normalizeChorusToolName("subagent_spawn")).toBe(null);
  expect(normalizeChorusToolName("")).toBe(null);
  expect(normalizeChorusToolName(undefined)).toBe(null);
});

test("resolveChorusToolName: gateway mode reads event.input.tool", () => {
  expect(resolveChorusToolName({ toolName: "mcp", input: { tool: "chorus_chorus_submit_for_verify" } }))
    .toBe("chorus_submit_for_verify");
});

test("resolveChorusToolName: direct mode reads event.toolName", () => {
  expect(resolveChorusToolName({ toolName: "chorus_chorus_submit_for_verify" })).toBe("chorus_submit_for_verify");
  expect(resolveChorusToolName({ toolName: "chorus_submit_for_verify" })).toBe("chorus_submit_for_verify");
});

test("resolveChorusToolName: non-chorus tool returns null", () => {
  expect(resolveChorusToolName({ toolName: "bash" })).toBe(null);
  expect(resolveChorusToolName({ toolName: "mcp", input: { tool: "bash" } })).toBe(null);
});

test("NUDGE_TOOL_NAMES: the three reviewer-trigger tools", () => {
  expect([...NUDGE_TOOL_NAMES]).toEqual([
    "chorus_pm_submit_proposal",
    "chorus_submit_for_verify",
    "chorus_admin_verify_task",
  ]);
});

// ─── buildSessionBanner (user-visible startup banner) ───────────────────────
// Mirrors the Claude plugin's SessionStart `systemMessage` (#442): a one-line
// toast with the connection + OpenSpec status.
const URL = "http://localhost:8637";

test("buildSessionBanner: not configured → warning, no URL surfaced", () => {
  const r = buildSessionBanner({
    configured: false,
    connected: false,
    chorusUrl: "",
    openspec: { active: false, reason: "not configured", optout: false, hint: "" },
  });
  expect(r.level).toBe("warning");
  expect(r.message).toContain("not configured");
  expect(r.message).toContain("CHORUS_URL");
  expect(r.message).toContain("CHORUS_API_KEY");
});

test("buildSessionBanner: connection failed → error with the URL", () => {
  const r = buildSessionBanner({
    configured: true,
    connected: false,
    chorusUrl: URL,
    openspec: { active: false, reason: "connection failed", optout: false, hint: "" },
  });
  expect(r.level).toBe("error");
  expect(r.message).toContain("connection failed");
  expect(r.message).toContain(URL);
});

test("buildSessionBanner: connected + OpenSpec active → info, (OpenSpec Enabled)", () => {
  const r = buildSessionBanner({
    configured: true,
    connected: true,
    chorusUrl: URL,
    openspec: { active: true, reason: "both present", optout: false, hint: "" },
  });
  expect(r.level).toBe("info");
  expect(r.message).toContain("connected at " + URL);
  expect(r.message).toContain("(OpenSpec Enabled)");
});

test("buildSessionBanner: connected + explicit opt-out → info, neutral (OpenSpec off), no nag", () => {
  const r = buildSessionBanner({
    configured: true,
    connected: true,
    chorusUrl: URL,
    openspec: { active: false, reason: "CHORUS_OPENSPEC_MODE=off", optout: true, hint: "" },
  });
  expect(r.level).toBe("info");
  expect(r.message).toContain("(OpenSpec off)");
  // the opt-out case must NOT carry the enable-openspec nudge
  expect(r.message).not.toContain("enable openspec");
});

test("buildSessionBanner: connected + not set up (no dir) → info, nudge to enable openspec", () => {
  const r = buildSessionBanner({
    configured: true,
    connected: true,
    chorusUrl: URL,
    openspec: { active: false, reason: "no openspec/ directory", optout: false, hint: "" },
  });
  expect(r.level).toBe("info");
  expect(r.message).toContain("(OpenSpec off");
  expect(r.message).toContain("/skill:chorus enable openspec");
  expect(r.message).toContain("to set it up");
});

test("buildSessionBanner: connected + dir present but CLI missing → info, still nudges (not-set-up kind)", () => {
  // The hint case is still a "not set up" state (optout=false), so the banner
  // nudges the same way — the richer hint lives in the injected agent context, not the toast.
  const r = buildSessionBanner({
    configured: true,
    connected: true,
    chorusUrl: URL,
    openspec: {
      active: false,
      reason: "openspec/ directory present but `openspec` CLI not on PATH",
      optout: false,
      hint: "install with: npm i -g @fission-ai/openspec",
    },
  });
  expect(r.level).toBe("info");
  expect(r.message).toContain("/skill:chorus enable openspec");
});

test("buildSessionBanner: not-configured wins over connection-failed (configured checked first)", () => {
  // When env vars are missing we never attempt a checkin, so the banner must be
  // the "not configured" warning, not a connection-failed error.
  const r = buildSessionBanner({
    configured: false,
    connected: true, // hypothetical: even if we pretend connected
    chorusUrl: "",
    openspec: { active: false, reason: "x", optout: false, hint: "" },
  });
  expect(r.level).toBe("warning");
  expect(r.message).toContain("not configured");
});

// ─── parseMaxCodeReviewRounds ─────────────────────────────────────────────
// Mirrors the Claude plugin's `maxCodeReviewRounds` userConfig (default 3,
// 0 = unlimited). Env: CHORUS_MAX_CODE_REVIEW_ROUNDS.
test("parseMaxCodeReviewRounds: undefined / empty → default (3)", () => {
  expect(parseMaxCodeReviewRounds(undefined)).toBe(DEFAULT_MAX_CODE_REVIEW_ROUNDS);
  expect(parseMaxCodeReviewRounds("")).toBe(3);
  expect(DEFAULT_MAX_CODE_REVIEW_ROUNDS).toBe(3);
});

test("parseMaxCodeReviewRounds: valid integers pass through", () => {
  expect(parseMaxCodeReviewRounds("0")).toBe(0);   // unlimited
  expect(parseMaxCodeReviewRounds("1")).toBe(1);
  expect(parseMaxCodeReviewRounds("3")).toBe(3);   // default
  expect(parseMaxCodeReviewRounds("5")).toBe(5);
  expect(parseMaxCodeReviewRounds("12")).toBe(12);
});

test("parseMaxCodeReviewRounds: 0 means unlimited", () => {
  expect(parseMaxCodeReviewRounds("0")).toBe(0);
});

test("parseMaxCodeReviewRounds: negative → default", () => {
  expect(parseMaxCodeReviewRounds("-1")).toBe(3);
  expect(parseMaxCodeReviewRounds("-5")).toBe(3);
});

test("parseMaxCodeReviewRounds: non-integer → default (no silent floor)", () => {
  expect(parseMaxCodeReviewRounds("3.5")).toBe(3);
  expect(parseMaxCodeReviewRounds("3abc")).toBe(3);
  expect(parseMaxCodeReviewRounds("abc")).toBe(3);
  expect(parseMaxCodeReviewRounds(" ")).toBe(3);
});
