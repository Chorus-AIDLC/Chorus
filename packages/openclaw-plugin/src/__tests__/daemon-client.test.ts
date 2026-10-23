import { describe, it, expect, vi, beforeEach } from "vitest";
import { TEAM_ROUTING_GUIDANCE } from "../team-routing-guidance.js";
import {
  OpenClawDaemonClient,
  extractBlockReplyText,
  deriveSessionId,
  deriveSessionKey,
  entityOf,
  type WakeRunContext,
  type WakeRequest,
} from "../daemon-client.js";
import type { DaemonRestClient, DaemonPendingTurn } from "../daemon-rest-client.js";
import { createDaemonRestClient } from "../daemon-rest-client.js";
import { ChorusEventRouter } from "../event-router.js";

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

/** Flush the fire-and-forget promise chain. */
async function flush() {
  for (let i = 0; i < 4; i++) await new Promise((r) => setTimeout(r, 0));
}

/** A rest-client fake recording every call; reads are configurable. */
function makeRestClient(over: Partial<DaemonRestClient> = {}) {
  const turnAdvance = vi.fn(async ({ status }: { status: string }) => ({
    ok: true, status: 200, ...(status === "running" ? { data: { turnUuid: "turn-default" } } : {}),
  }));
  const transcript = vi.fn(async () => ({ ok: true, status: 200 }));
  const executionState = vi.fn(async () => ({ ok: true, status: 200 }));
  const reportInterrupt = vi.fn(async () => ({ ok: true, status: 200 }));
  const readPendingTurns = vi.fn(async () => ({ ok: true, status: 200, data: { turns: [] as DaemonPendingTurn[] } }));
  const client: DaemonRestClient = {
    turnAdvance,
    transcript,
    executionState,
    reportInterrupt,
    readPendingTurns,
    ...over,
  };
  return { client, turnAdvance, transcript, executionState, reportInterrupt, readPendingTurns };
}

/**
 * A runtime.agent fake whose runEmbeddedAgent invokes the streaming callbacks the
 * test supplies, then resolves/rejects per the test's directive. Records the params.
 */
function makeRunContext(opts: {
  runEmbeddedAgent: ReturnType<typeof vi.fn>;
  getSessionEntry?: ReturnType<typeof vi.fn>;
}): WakeRunContext {
  const getSessionEntry =
    opts.getSessionEntry ?? vi.fn(() => ({ sessionId: "sid-existing", sessionFile: "f.jsonl" }));
  const resolveSessionFilePath = vi.fn(() => "/ws/sessions/f.jsonl");
  return {
    agent: {
      runEmbeddedAgent: opts.runEmbeddedAgent as never,
      resolveAgentDir: vi.fn(() => "/ws/agent"),
      resolveAgentWorkspaceDir: vi.fn(() => "/ws"),
      resolveAgentTimeoutMs: vi.fn(() => 120000),
      session: { getSessionEntry: getSessionEntry as never, resolveSessionFilePath: resolveSessionFilePath as never },
    } as never,
    sessionKey: "agent:main:main",
    agentId: "main",
    config: { fake: true },
    workspaceDir: "/ws",
    agentDir: "/ws/agent",
    timeoutMs: 120000,
    modelRef: { provider: "amazon-bedrock", model: "claude-sonnet-4-6" },
  };
}

function build(over: {
  rest?: ReturnType<typeof makeRestClient>;
  runContext?: WakeRunContext | null;
  redispatch?: ReturnType<typeof vi.fn>;
  buildTurnPrompt?: (t: DaemonPendingTurn) => string;
} = {}) {
  const rest = over.rest ?? makeRestClient();
  const logger = makeLogger();
  const redispatch = over.redispatch ?? vi.fn();
  const client = new OpenClawDaemonClient({
    restClient: rest.client,
    resolveRunContext: () => (over.runContext === undefined ? makeRunContext({ runEmbeddedAgent: vi.fn(async () => ({ meta: {} })) }) : over.runContext),
    redispatch,
    buildTurnPrompt: over.buildTurnPrompt ?? ((t) => `PROMPT:${t.promptText ?? ""}`),
    logger,
  });
  return { client, rest, logger, redispatch };
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe("pure helpers", () => {
  it("deriveSessionId prefers directIdeaUuid, falls back to entityUuid", () => {
    expect(deriveSessionId({ directIdeaUuid: "idea-1", entityUuid: "task-1" })).toBe("idea-1");
    expect(deriveSessionId({ directIdeaUuid: null, entityUuid: "task-1" })).toBe("task-1");
    expect(deriveSessionId({ entityUuid: null })).toBeNull();
  });

  it("deriveSessionKey is deterministic from the business key + main session key", () => {
    expect(deriveSessionKey("idea-1", "agent:main:main")).toBe("agent:main:main:chorus:idea-1");
    // Same business key → SAME OpenClaw session key (resume continuity).
    expect(deriveSessionKey("idea-1", "agent:main:main")).toBe(deriveSessionKey("idea-1", "agent:main:main"));
    // Different business key → different lane.
    expect(deriveSessionKey("idea-2", "agent:main:main")).not.toBe(deriveSessionKey("idea-1", "agent:main:main"));
  });

  it("entityOf accepts recognized resource kinds only", () => {
    expect(entityOf({ entityType: "task", entityUuid: "t" })).toEqual({ entityType: "task", entityUuid: "t" });
    expect(entityOf({ entityType: "daemon_session", entityUuid: "s" })).toEqual({ entityType: "daemon_session", entityUuid: "s" });
    expect(entityOf({ entityType: "bogus", entityUuid: "x" })).toBeNull();
    expect(entityOf({ entityType: "task", entityUuid: "" })).toBeNull();
    expect(entityOf({ entityType: "task" })).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// AC: Transcript filtering (only finalized assistant visible text)
// ---------------------------------------------------------------------------

describe("extractBlockReplyText — transcript content filter", () => {
  it("keeps finalized assistant text", () => {
    expect(extractBlockReplyText({ text: "Hello world" })).toEqual({ role: "assistant", text: "Hello world" });
  });
  it("drops reasoning/thinking blocks (isReasoning)", () => {
    expect(extractBlockReplyText({ text: "let me think...", isReasoning: true })).toBeNull();
  });
  it("drops empty / whitespace-only text", () => {
    expect(extractBlockReplyText({ text: "   " })).toBeNull();
    expect(extractBlockReplyText({})).toBeNull();
    expect(extractBlockReplyText(null)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// AC #1: lifecycle reporting (running→ended + execution snapshot)
// ---------------------------------------------------------------------------

describe("runWake — lifecycle reporting", () => {
  it("reports turn-advance running then ended, with sessionId=directIdeaUuid", async () => {
    const rest = makeRestClient();
    const runEmbeddedAgent = vi.fn(async () => ({ meta: {} }));
    const { client } = build({ rest, runContext: makeRunContext({ runEmbeddedAgent }) });

    await client.runWake({
      prompt: "do the task",
      contextKey: "chorus:task_assigned:task-3",
      entityType: "task",
      entityUuid: "task-3",
      directIdeaUuid: "idea-9",
      rootIdeaUuid: "idea-root",
    });

    // running before the run, ended after.
    expect(rest.turnAdvance).toHaveBeenNthCalledWith(1, {
      sessionId: "idea-9",
      status: "running",
      entityType: "task",
      entityUuid: "task-3",
    });
    expect(rest.turnAdvance).toHaveBeenNthCalledWith(2, {
      sessionId: "idea-9",
      turnUuid: "turn-default",
      status: "ended",
      entityType: "task",
      entityUuid: "task-3",
    });
  });

  it("threads the running response turn UUID onto the ended report", async () => {
    const turnAdvance = vi.fn(async ({ status }: { status: string }) =>
      status === "running"
        ? { ok: true, status: 200, data: { turnUuid: "turn-7" } }
        : { ok: true, status: 200 },
    );
    const rest = makeRestClient({ turnAdvance });
    const { client } = build({ rest });

    await client.runWake({
      prompt: "do the task",
      contextKey: "chorus:task_assigned:task-3",
      entityType: "task",
      entityUuid: "task-3",
      directIdeaUuid: "idea-9",
      rootIdeaUuid: "idea-root",
    });

    expect(turnAdvance).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ status: "ended", turnUuid: "turn-7" }),
    );
  });

  it("publishes an execution snapshot with rootIdeaUuid + directIdeaUuid + startedAt while running, then empty when ended", async () => {
    const rest = makeRestClient();
    let snapshotWhileRunning: unknown;
    const runEmbeddedAgent = vi.fn(async () => {
      // capture the snapshot emitted at the running transition
      const calls = rest.executionState.mock.calls;
      snapshotWhileRunning = calls[calls.length - 1]?.[0];
      return { meta: {} };
    });
    const { client } = build({ rest, runContext: makeRunContext({ runEmbeddedAgent }) });

    await client.runWake({
      prompt: "p",
      contextKey: "ctx",
      entityType: "task",
      entityUuid: "task-3",
      directIdeaUuid: "idea-9",
      rootIdeaUuid: "idea-root",
    });

    expect(snapshotWhileRunning).toEqual({
      executions: [
        expect.objectContaining({
          entityType: "task",
          entityUuid: "task-3",
          // Child-idea case: rootIdeaUuid (parent) and directIdeaUuid (child) are
          // distinct and BOTH reach the snapshot — the UI anchors on the direct id.
          rootIdeaUuid: "idea-root",
          directIdeaUuid: "idea-9",
          status: "running",
          startedAt: expect.any(String),
        }),
      ],
    });
    const running = (snapshotWhileRunning as { executions: Array<Record<string, unknown>> }).executions[0];
    expect(running.directIdeaUuid).not.toBe(running.rootIdeaUuid);
    // Last snapshot after the run finishes is empty (absence == ended server-side).
    const last = rest.executionState.mock.calls[rest.executionState.mock.calls.length - 1][0];
    expect(last).toEqual({ executions: [] });
  });

  it("uses entityUuid as the sessionId when there is no direct idea", async () => {
    const rest = makeRestClient();
    const runEmbeddedAgent = vi.fn(async () => ({ meta: {} }));
    const { client } = build({ rest, runContext: makeRunContext({ runEmbeddedAgent }) });
    await client.runWake({ prompt: "p", contextKey: "ctx", entityType: "task", entityUuid: "task-3", directIdeaUuid: null });
    expect(rest.turnAdvance).toHaveBeenNthCalledWith(1, expect.objectContaining({ sessionId: "task-3", status: "running" }));
  });

  it("settles its exact turn when the host run-context is unavailable", async () => {
    const rest = makeRestClient();
    const { client, logger } = build({ rest, runContext: null });
    await client.runWake({ prompt: "p", contextKey: "ctx", entityType: "task", entityUuid: "task-3" });
    expect(rest.turnAdvance).toHaveBeenNthCalledWith(2, expect.objectContaining({
      turnUuid: "turn-default", status: "interrupted", interruptedReason: "crash",
      wakeError: expect.objectContaining({ source: "openclaw", kind: "startup" }),
    }));
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("no resolvable session/agent runtime"));
  });
});

// ---------------------------------------------------------------------------
// AC #2: transcript streams from inline callbacks
// ---------------------------------------------------------------------------

describe("runWake — streaming transcript", () => {
  it("posts only finalized assistant text from onBlockReply; never reasoning/tool internals", async () => {
    const rest = makeRestClient();
    const runEmbeddedAgent = vi.fn(async (params: Record<string, unknown>) => {
      const onBlockReply = params.onBlockReply as (p: unknown) => void;
      const onToolResult = params.onToolResult as ((p: unknown) => void) | undefined;
      const onReasoningStream = params.onReasoningStream as ((p: unknown) => void) | undefined;
      // visible text → posted
      onBlockReply({ text: "Here is the answer." });
      // reasoning block → dropped
      onBlockReply({ text: "thinking out loud", isReasoning: true });
      // tool result → never posted as transcript (client does not pass onToolResult,
      // so even if a host called it, nothing would be posted). Assert it's absent.
      expect(onToolResult).toBeUndefined();
      // reasoning stream callback also not wired by the client → never posted.
      expect(onReasoningStream).toBeUndefined();
      return { meta: {} };
    });
    const { client } = build({ rest, runContext: makeRunContext({ runEmbeddedAgent }) });

    await client.runWake({ prompt: "p", contextKey: "ctx", entityType: "task", entityUuid: "task-3", directIdeaUuid: "idea-9" });
    await flush();

    expect(rest.transcript).toHaveBeenCalledTimes(1);
    expect(rest.transcript).toHaveBeenCalledWith({ sessionId: "idea-9", messages: [{ role: "assistant", text: "Here is the answer." }] });
  });
});

// ---------------------------------------------------------------------------
// AC #3: abort=user vs crash + controller deregistration
// ---------------------------------------------------------------------------

describe("runWake — interrupt (user) vs crash + controller lifecycle", () => {
  it("prefers the authoritative terminal meta.error over a generic final error payload", async () => {
    const rest = makeRestClient();
    const runEmbeddedAgent = vi.fn(async () => ({
      meta: { error: { kind: "context_overflow", message: "Context window exceeded" } },
      payloads: [{ isError: true, text: "Generic failed reply" }],
    }));
    const { client } = build({ rest, runContext: makeRunContext({ runEmbeddedAgent }) });
    await client.runWake({ prompt: "p", contextKey: "ctx", entityType: "task", entityUuid: "task-3" });
    expect(rest.turnAdvance).toHaveBeenLastCalledWith(expect.objectContaining({
      interruptedReason: "crash",
      wakeError: expect.objectContaining({ message: "Context window exceeded" }),
    }));
  });

  it("classifies a final error payload as a crash even when the run resolves", async () => {
    const rest = makeRestClient();
    const runEmbeddedAgent = vi.fn(async () => ({
      meta: {}, payloads: [{ isError: true, text: "Provider request rejected" }],
    }));
    const { client } = build({ rest, runContext: makeRunContext({ runEmbeddedAgent }) });
    await client.runWake({ prompt: "p", contextKey: "ctx", entityType: "task", entityUuid: "task-3" });
    expect(rest.turnAdvance).toHaveBeenLastCalledWith(expect.objectContaining({
      turnUuid: "turn-default", status: "interrupted", interruptedReason: "crash",
      wakeError: expect.objectContaining({ source: "openclaw", message: "Provider request rejected" }),
    }));
  });

  it("a user-aborted resolved error payload carries no crash diagnostic", async () => {
    const rest = makeRestClient();
    const runEmbeddedAgent = vi.fn(async () => ({
      meta: { aborted: true }, payloads: [{ isError: true, text: "Abort error" }],
    }));
    const { client } = build({ rest, runContext: makeRunContext({ runEmbeddedAgent }) });
    await client.runWake({ prompt: "p", contextKey: "ctx", entityType: "task", entityUuid: "task-3" });
    expect(rest.turnAdvance).toHaveBeenLastCalledWith(expect.objectContaining({
      turnUuid: "turn-default", status: "interrupted", interruptedReason: "user",
    }));
    expect(rest.turnAdvance.mock.calls.at(-1)?.[0]).not.toHaveProperty("wakeError");
  });

  it.each([false, true])("skips an uncorrelated terminal report (failed admission=%s)", async (failed) => {
    const turnAdvance = vi.fn(async () => ({ ok: !failed, status: failed ? 403 : 200 }));
    const rest = makeRestClient({ turnAdvance });
    const runEmbeddedAgent = vi.fn(async () => { throw new Error("boom"); });
    const { client, logger } = build({ rest, runContext: makeRunContext({ runEmbeddedAgent }) });
    await client.runWake({ prompt: "p", contextKey: "ctx", entityType: "task", entityUuid: "task-3" });
    expect(turnAdvance).toHaveBeenCalledTimes(1);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("no admitted turn UUID"));
  });

  it("a session-setup rejection admits and fails the requested exact turn without invoking the agent", async () => {
    const rest = makeRestClient();
    const runEmbeddedAgent = vi.fn();
    const getSessionEntry = vi.fn(() => { throw new Error("Session path unavailable"); });
    const { client } = build({ rest, runContext: makeRunContext({ runEmbeddedAgent, getSessionEntry }) });
    await client.runWake({ prompt: "p", contextKey: "ctx", entityType: "task", entityUuid: "task-3", turnUuid: "requested" });
    expect(runEmbeddedAgent).not.toHaveBeenCalled();
    expect(rest.turnAdvance).toHaveBeenNthCalledWith(1, expect.objectContaining({
      status: "running", turnUuid: "requested",
    }));
    expect(rest.turnAdvance).toHaveBeenLastCalledWith(expect.objectContaining({
      status: "interrupted", turnUuid: "turn-default", interruptedReason: "crash",
      wakeError: expect.objectContaining({ kind: "startup", message: "Session path unavailable" }),
    }));
  });

  it("a failed startup admission does not send a terminal report", async () => {
    const turnAdvance = vi.fn(async () => ({ ok: false, status: 403 }));
    const rest = makeRestClient({ turnAdvance });
    const { client } = build({ rest, runContext: null });
    await client.runWake({ prompt: "p", contextKey: "ctx", entityType: "task", entityUuid: "task-3", turnUuid: "requested" });
    expect(turnAdvance).toHaveBeenCalledTimes(1);
    expect(rest.reportInterrupt).not.toHaveBeenCalled();
  });

  it("an authorized interrupt aborts the in-flight run and reports reason=user", async () => {
    const rest = makeRestClient();
    let resolveRun!: (v: unknown) => void;
    const runEmbeddedAgent = vi.fn((params: Record<string, unknown>) => {
      const signal = params.abortSignal as AbortSignal;
      return new Promise((resolve) => {
        resolveRun = resolve;
        // Simulate a cooperative abort: when the signal fires, resolve with meta.aborted.
        signal.addEventListener("abort", () => resolve({ meta: { aborted: true } }));
      });
    });
    const { client } = build({ rest, runContext: makeRunContext({ runEmbeddedAgent }) });

    const runP = client.runWake({ prompt: "p", contextKey: "ctx", entityType: "task", entityUuid: "task-3", directIdeaUuid: "idea-9" });
    await flush();

    // While running, the entity is interruptible.
    expect(client.controlHooks.isEntityRunning("task", "task-3")).toBe(true);
    // Fire the interrupt.
    client.controlHooks.onInterrupt("task", "task-3");
    await runP;

    expect(rest.reportInterrupt).toHaveBeenCalledWith({ entityType: "task", entityUuid: "task-3", reason: "user" });
    expect(rest.turnAdvance).toHaveBeenLastCalledWith(expect.objectContaining({
      turnUuid: "turn-default", status: "interrupted", interruptedReason: "user",
    }));
    expect(rest.turnAdvance.mock.calls.at(-1)?.[0]).not.toHaveProperty("wakeError");
    // Controller deregistered after the run settled.
    expect(client.controlHooks.isEntityRunning("task", "task-3")).toBe(false);
    void resolveRun; // referenced to satisfy noUnusedLocals
  });

  it("a run rejection WITHOUT an interrupt reports reason=crash", async () => {
    const rest = makeRestClient();
    const runEmbeddedAgent = vi.fn(async () => {
      throw new Error("boom");
    });
    const { client } = build({ rest, runContext: makeRunContext({ runEmbeddedAgent }) });

    await client.runWake({ prompt: "p", contextKey: "ctx", entityType: "task", entityUuid: "task-3", directIdeaUuid: "idea-9" });

    expect(rest.reportInterrupt).toHaveBeenCalledWith({ entityType: "task", entityUuid: "task-3", reason: "crash" });
    expect(rest.turnAdvance).toHaveBeenLastCalledWith(expect.objectContaining({
      turnUuid: "turn-default", status: "interrupted", interruptedReason: "crash",
      wakeError: { kind: "execution", source: "openclaw", message: "boom",
        details: "boom", exitCode: null, signal: null },
    }));
  });

  it("a clean completion reports NO interrupt", async () => {
    const rest = makeRestClient();
    const runEmbeddedAgent = vi.fn(async () => ({ meta: {} }));
    const { client } = build({ rest, runContext: makeRunContext({ runEmbeddedAgent }) });
    await client.runWake({ prompt: "p", contextKey: "ctx", entityType: "task", entityUuid: "task-3", directIdeaUuid: "idea-9" });
    expect(rest.reportInterrupt).not.toHaveBeenCalled();
  });

  it("interrupt for an entity with no in-flight run is a safe no-op (deregistered)", async () => {
    const { client, rest } = build();
    expect(client.controlHooks.isEntityRunning("task", "task-99")).toBe(false);
    client.controlHooks.onInterrupt("task", "task-99");
    expect(rest.reportInterrupt).not.toHaveBeenCalled();
  });

  it("a stale controller cannot abort a later run for the same entity", async () => {
    const rest = makeRestClient();
    // First run completes cleanly.
    const first = vi.fn(async () => ({ meta: {} }));
    const ctx1 = makeRunContext({ runEmbeddedAgent: first });
    let runContext: WakeRunContext = ctx1;
    const client = new OpenClawDaemonClient({
      restClient: rest.client,
      resolveRunContext: () => runContext,
      redispatch: vi.fn(),
      buildTurnPrompt: () => "p",
      logger: makeLogger(),
    });
    await client.runWake({ prompt: "p", contextKey: "ctx", entityType: "task", entityUuid: "task-3", directIdeaUuid: "idea-9" });
    expect(client.controlHooks.isEntityRunning("task", "task-3")).toBe(false);

    // Second run is in-flight; an interrupt now targets a FRESH controller, not the
    // settled first one.
    let resolve2!: (v: unknown) => void;
    const secondSignals: AbortSignal[] = [];
    const second = vi.fn((params: Record<string, unknown>) => {
      secondSignals.push(params.abortSignal as AbortSignal);
      return new Promise((r) => {
        resolve2 = r;
      });
    });
    runContext = makeRunContext({ runEmbeddedAgent: second });
    const run2 = client.runWake({ prompt: "p2", contextKey: "ctx2", entityType: "task", entityUuid: "task-3", directIdeaUuid: "idea-9" });
    await flush();
    expect(secondSignals[0].aborted).toBe(false);
    resolve2({ meta: {} });
    await run2;
  });
});

// ---------------------------------------------------------------------------
// AC #4: session-key continuity (resume / deliver_turn reuse the same session)
// ---------------------------------------------------------------------------

describe("session-key continuity", () => {
  it("runWake derives the same sessionKey for the same business key, resolving the existing entry", async () => {
    const rest = makeRestClient();
    const getSessionEntry = vi.fn(() => ({ sessionId: "sid-existing", sessionFile: "f.jsonl" }));
    const runEmbeddedAgent = vi.fn(async () => ({ meta: {} }));
    const ctx = makeRunContext({ runEmbeddedAgent, getSessionEntry });
    const { client } = build({ rest, runContext: ctx });

    await client.runWake({ prompt: "p", contextKey: "ctx", entityType: "idea", entityUuid: "idea-9", directIdeaUuid: "idea-9" });

    const expectedKey = deriveSessionKey("idea-9", "agent:main:main");
    expect(getSessionEntry).toHaveBeenCalledWith({ sessionKey: expectedKey, agentId: "main" });
    // The run reuses the existing sessionId returned by getSessionEntry (NOT a fresh one).
    expect(runEmbeddedAgent.mock.calls[0][0].sessionId).toBe("sid-existing");
    expect(runEmbeddedAgent.mock.calls[0][0].sessionKey).toBe(expectedKey);
  });

  it.each([
    "/workspaces/项目 alpha",
    "/workspaces/space only",
  ])("reuses the business-key session entry independently of cwd %s", async (cwd) => {
    const rest = makeRestClient();
    const getSessionEntry = vi.fn(() => ({
      sessionId: "sid-existing",
      sessionFile: "f.jsonl",
    }));
    const runEmbeddedAgent = vi.fn(async () => ({ meta: {} }));
    const ctx = makeRunContext({ runEmbeddedAgent, getSessionEntry });
    ctx.workspaceDir = cwd;
    const { client } = build({ rest, runContext: ctx });

    await client.runWake({
      prompt: "p",
      contextKey: "ctx",
      entityType: "idea",
      entityUuid: "idea-9",
      directIdeaUuid: "idea-9",
    });

    const expectedKey = deriveSessionKey("idea-9", "agent:main:main");
    expect(getSessionEntry).toHaveBeenCalledWith({
      sessionKey: expectedKey,
      agentId: "main",
    });
    expect(runEmbeddedAgent.mock.calls[0][0]).toMatchObject({
      sessionId: "sid-existing",
      sessionKey: expectedKey,
      workspaceDir: cwd,
    });
  });

  it("opens a NEW session with a SAFE session id (the business key) when getSessionEntry returns none", async () => {
    // Regression for a defect surfaced by a live OpenClaw gateway run (T5): when no
    // OpenClaw session exists yet for the derived key, the fallback session id MUST be
    // a valid OpenClaw session id. OpenClaw's resolveSessionFilePath enforces
    // SAFE_SESSION_ID_RE (`^[a-z0-9][a-z0-9._-]{0,127}$`) — NO colons. The old fallback
    // used the run id (`chorus-wake-N-chorus:deliver_turn:<uuid>`), which contains
    // colons and was rejected with "Invalid session ID", dropping every fresh wake.
    const SAFE_SESSION_ID_RE = /^[a-z0-9][a-z0-9._-]{0,127}$/i;
    const rest = makeRestClient();
    const getSessionEntry = vi.fn(() => undefined); // no existing session
    const resolveSessionFilePath = vi.fn((sessionId: string) => {
      if (!SAFE_SESSION_ID_RE.test(sessionId)) {
        throw new Error(`Invalid session ID: ${sessionId}`);
      }
      return `/ws/sessions/${sessionId}.jsonl`;
    });
    const runEmbeddedAgent = vi.fn(async () => ({ meta: {} }));
    const ctx = makeRunContext({ runEmbeddedAgent, getSessionEntry });
    (ctx.agent as { session: { resolveSessionFilePath: unknown } }).session.resolveSessionFilePath =
      resolveSessionFilePath as never;
    const { client, logger } = build({ rest, runContext: ctx });

    // A fresh ad-hoc business key (a uuid) — safe per the regex.
    const businessKey = "bc4b0a8c-2f6c-47c2-9275-27e062d704ed";
    await client.runWake({
      prompt: "p",
      contextKey: "chorus:deliver_turn:c44fd333-435d-44fa-be21-1569979e9d44",
      entityType: "daemon_session",
      entityUuid: businessKey,
      directIdeaUuid: null,
    });

    // The wake was NOT dropped (no "session resolution failed" log).
    const warnMsgs = (logger.warn as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
    expect(warnMsgs.some((w) => w.includes("session resolution failed"))).toBe(false);
    // The run opened a NEW session whose id is the business key (a SAFE id), NOT a runId.
    expect(runEmbeddedAgent).toHaveBeenCalledTimes(1);
    const usedSessionId = runEmbeddedAgent.mock.calls[0][0].sessionId as string;
    expect(usedSessionId).toBe(businessKey);
    expect(SAFE_SESSION_ID_RE.test(usedSessionId)).toBe(true);
    expect(usedSessionId).not.toContain(":");
    // The run id (which DOES embed the colon-laden contextKey) is passed separately and
    // is never used as the session id.
    expect(runEmbeddedAgent.mock.calls[0][0].runId).toContain(":");
  });

  it("onResume re-dispatches a wake for the entity (continues the same session via redispatch)", () => {
    const redispatch = vi.fn();
    const { client } = build({ redispatch });
    client.controlHooks.onResume("idea", "idea-9");
    expect(redispatch).toHaveBeenCalledWith(
      expect.objectContaining({ entityType: "idea", entityUuid: "idea-9", contextKey: "chorus:resume:idea-9", prompt: expect.stringContaining(TEAM_ROUTING_GUIDANCE) }),
    );
  });
});

// ---------------------------------------------------------------------------
// AC #5: pending-turns backfill + at-most-once (live + backfill dedup)
// ---------------------------------------------------------------------------

describe("pending-turns backfill — at-most-once", () => {
  it.each(["accepted", "denied", "missing", "mismatched"])("negotiates real recovery and fences handoff execution (%s)", async (admission) => {
    const notification = { uuid: "lead-note", action: "team_lead_handoff", entityType: "proposal", entityUuid: "proposal-original", entityTitle: "Ready", projectUuid: "project-1", message: "Submitted" };
    const requests: string[] = [];
    const runEmbeddedAgent = vi.fn(async () => ({ meta: {} }));
    const logger = makeLogger();
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = new URL(String(input));
      requests.push(url.href);
      if (url.pathname.endsWith("pending-turns")) {
        const turn = { turnUuid: "lead-turn", sessionId: "idea-1", directIdeaUuid: "idea-1", trigger: "task_assigned", promptText: null,
          ...(url.searchParams.get("wakeRecoveryProtocol") === "1" ? { wakeContext: { version: 1, notificationUuid: notification.uuid, notification } } : {}) };
        return new Response(JSON.stringify({ success: true, data: { turns: [turn] } }));
      }
      if (url.pathname.endsWith("turn-advance")) {
        return new Response(JSON.stringify({ success: admission !== "denied", data: admission === "missing" ? {} : { turn: { uuid: admission === "mismatched" ? "wrong-turn" : "lead-turn" } } }), { status: admission === "denied" ? 403 : 200 });
      }
      return new Response(JSON.stringify({ success: true }));
    }) as typeof fetch;
    const restClient = createDaemonRestClient({ url: "https://chorus.example.com", apiKey: "test", getConnectionUuid: () => "connection-1", fetchImpl });
    const executionState = vi.spyOn(restClient, "executionState");
    const redispatch = vi.fn((request: WakeRequest) => { void client.runWake(request); });
    const client = new OpenClawDaemonClient({ restClient, redispatch, resolveRunContext: () => makeRunContext({ runEmbeddedAgent }), buildTurnPrompt: () => "legacy", logger });
    const broadcastWake = vi.fn();
    const router = new ChorusEventRouter({ mcpClient: { callTool: async () => ({ notifications: [notification] }) } as never, wake: broadcastWake, logger });
    for (const event of [
      { suppressWake: true, targetConnectionUuid: null },
      { suppressWake: false, targetConnectionUuid: "different-connection", turnUuid: "lead-turn" },
      { suppressWake: false, targetConnectionUuid: "connection-1", turnUuid: "lead-turn" },
    ]) router.dispatch({ type: "new_notification", notificationUuid: notification.uuid, ...event });
    await client.deliverTurn("lead-turn");
    await flush();
    await client.onReconnect();
    await flush();
    expect(requests.filter((url) => url.includes("pending-turns"))).toEqual([
      "https://chorus.example.com/api/daemon/pending-turns?connectionUuid=connection-1&wakeRecoveryProtocol=1",
      "https://chorus.example.com/api/daemon/pending-turns?connectionUuid=connection-1&wakeRecoveryProtocol=1",
    ]);
    expect(broadcastWake).not.toHaveBeenCalled();
    expect(runEmbeddedAgent).toHaveBeenCalledTimes(admission === "accepted" ? 1 : 0);
    expect(redispatch.mock.calls[0][0]).toMatchObject({ turnUuid: "lead-turn", entityType: "proposal", entityUuid: "proposal-original" });
    expect(redispatch.mock.calls[0][0].prompt).toContain("Team lead handoff for proposal");
    expect(executionState).toHaveBeenLastCalledWith({ executions: [] });
  });

  it("retains legacy task-style recovery without a snapshot", async () => {
    const redispatch = vi.fn();
    const { client } = build({ rest: withTurns([{ ...TURN, trigger: "task_assigned", promptText: null }]), redispatch });
    await client.deliverTurn();
    expect(redispatch).toHaveBeenCalledTimes(1);
  });

  const TURN: DaemonPendingTurn = {
    turnUuid: "turn-7",
    sessionId: "idea-9",
    directIdeaUuid: "idea-9",
    trigger: "human_instruction",
    promptText: "please do X",
  };

  function withTurns(turns: DaemonPendingTurn[]) {
    return makeRestClient({ readPendingTurns: vi.fn(async () => ({ ok: true, status: 200, data: { turns } })) });
  }

  it("a delivered continuation resumes coordination for the original entity", async () => {
    const redispatch = vi.fn();
    const turn = { ...TURN, trigger: "resume", promptText: null, resume: { entityType: "proposal", entityUuid: "proposal-original" } };
    const { client } = build({ rest: withTurns([turn]), redispatch });
    await client.deliverTurn(turn.turnUuid);
    expect(redispatch).toHaveBeenCalledWith(expect.objectContaining({ entityType: "proposal", entityUuid: "proposal-original", directIdeaUuid: "idea-9", turnUuid: "turn-7" }));
    expect(redispatch.mock.calls[0][0].prompt).toContain("A resumed Team lead handoff must re-read the original entity");
    expect(redispatch.mock.calls[0][0].prompt).not.toContain("A human sent");
  });

  it("a continuation without an original entity stays pending", async () => {
    const redispatch = vi.fn();
    const { client } = build({ rest: withTurns([{ ...TURN, trigger: "resume" }]), redispatch });
    await client.deliverTurn();
    expect(redispatch).not.toHaveBeenCalled();
  });

  it.each(["live", "reconnect"])("%s recovers the exact lead handoff entity instead of a human instruction", async (delivery) => {
    const notification = { uuid: "lead-note", action: "team_lead_handoff", entityType: "proposal", entityUuid: "proposal-original", entityTitle: "Ready", projectUuid: "project-1", message: "Proposal submitted" };
    const turn = { ...TURN, trigger: "task_assigned", promptText: null, wakeContext: { version: 1, notificationUuid: notification.uuid, notification } };
    const redispatch = vi.fn();
    const { client } = build({ rest: withTurns([turn]), redispatch });
    if (delivery === "live") await client.deliverTurn(turn.turnUuid);
    else await client.onReconnect();
    await client.deliverTurn(turn.turnUuid);
    expect(redispatch).toHaveBeenCalledTimes(1);
    expect(redispatch).toHaveBeenCalledWith(expect.objectContaining({ entityType: "proposal", entityUuid: "proposal-original", directIdeaUuid: "idea-9", turnUuid: "turn-7" }));
    const prompt = redispatch.mock.calls[0][0].prompt;
    expect(prompt).toContain("Team lead handoff for proposal 'Ready'");
    expect(prompt).toContain("Proposal submitted");
    expect(prompt).toContain("Task verification belongs to the current lead");
    expect(prompt).not.toContain("A human sent");
    client.resume("proposal", "proposal-original");
    expect(redispatch.mock.calls[1][0].prompt).toContain("A resumed Team lead handoff must re-read the original entity");
  });

  it.each(["proposal_submitted", "task_submitted_for_verify", "task_status_changed", "report_created"])("does not wake generic %s from a delivered snapshot", async (action) => {
    const notification = { uuid: "generic-note", action, entityType: "task", entityUuid: "task-1", entityTitle: "T", projectUuid: "p", message: "notify only" };
    const redispatch = vi.fn();
    const { client } = build({ rest: withTurns([{ ...TURN, trigger: "task_assigned", wakeContext: { version: 1, notificationUuid: notification.uuid, notification } }]), redispatch });
    await client.deliverTurn();
    expect(redispatch).not.toHaveBeenCalled();
  });

  it("leaves malformed handoff snapshots pending for retry", async () => {
    const notification = { uuid: "lead-note", action: "team_lead_handoff", entityType: "task", entityUuid: "task-1", entityTitle: "T", projectUuid: "p", message: "submitted" };
    const turn = { ...TURN, trigger: "task_assigned", wakeContext: { version: 1, notificationUuid: "mismatch", notification } };
    const redispatch = vi.fn();
    const { client } = build({ rest: withTurns([turn]), redispatch });
    await client.deliverTurn();
    expect(redispatch).not.toHaveBeenCalled();
    turn.wakeContext.notificationUuid = notification.uuid;
    await client.deliverTurn();
    expect(redispatch).toHaveBeenCalledTimes(1);
  });

  it("deliverTurn(turnUuid) runs ONLY the named turn", async () => {
    const other: DaemonPendingTurn = { ...TURN, turnUuid: "turn-OTHER", promptText: "other" };
    const rest = withTurns([TURN, other]);
    const redispatch = vi.fn();
    const { client } = build({ rest, redispatch });

    await client.deliverTurn("turn-7");

    expect(redispatch).toHaveBeenCalledTimes(1);
    expect(redispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        turnUuid: "turn-7",
        // An idea-anchored turn reports its execution against the real idea so the
        // delivered run is visible + interruptible (entityType MUST be set).
        entityType: "idea",
        directIdeaUuid: "idea-9",
        entityUuid: "idea-9",
        contextKey: "chorus:deliver_turn:turn-7",
        prompt: `${TEAM_ROUTING_GUIDANCE}\n\nPROMPT:please do X`,
      }),
    );
  });

  it("an ad-hoc turn (no directIdeaUuid) reports against daemon_session, not entity-less", async () => {
    // Regression: deliverTurn used to omit entityType for ad-hoc turns, so entityOf()
    // returned null → no execution row + no AbortController → the delivered run was
    // invisible in the UI and uninterruptible. Mirror cli/event-router.mjs which sets
    // entityType=daemon_session, entityUuid=sessionId for a directIdeaUuid-less turn.
    const adhoc: DaemonPendingTurn = {
      turnUuid: "turn-adhoc",
      sessionId: "sess-abc",
      directIdeaUuid: null,
      trigger: "human_instruction",
      promptText: "ad-hoc work",
    };
    const rest = withTurns([adhoc]);
    const redispatch = vi.fn();
    const { client } = build({ rest, redispatch });

    await client.deliverTurn("turn-adhoc");

    expect(redispatch).toHaveBeenCalledTimes(1);
    const req = redispatch.mock.calls[0][0];
    expect(req).toEqual(
      expect.objectContaining({
        turnUuid: "turn-adhoc",
        entityType: "daemon_session",
        entityUuid: "sess-abc",
        directIdeaUuid: null,
      }),
    );
    // entityOf must now resolve a real entity (was null before the fix) so the run
    // reports an execution row and registers an interruptible AbortController.
    expect(entityOf(req)).toEqual({ entityType: "daemon_session", entityUuid: "sess-abc" });
  });

  it("onReconnect sweeps ALL pending turns", async () => {
    const t2: DaemonPendingTurn = { ...TURN, turnUuid: "turn-8" };
    const rest = withTurns([TURN, t2]);
    const redispatch = vi.fn();
    const { client } = build({ rest, redispatch });
    await client.onReconnect();
    expect(redispatch).toHaveBeenCalledTimes(2);
  });

  it("a turn delivered live is NOT re-run by a later backfill (shared seen-set)", async () => {
    const rest = withTurns([TURN]);
    const redispatch = vi.fn();
    const { client } = build({ rest, redispatch });

    await client.deliverTurn("turn-7"); // live
    await client.onReconnect(); // backfill sees the same turn

    expect(redispatch).toHaveBeenCalledTimes(1); // at most once
  });

  it("a turn swept on reconnect is NOT re-run by a later live deliver_turn (shared seen-set)", async () => {
    const rest = withTurns([TURN]);
    const redispatch = vi.fn();
    const { client } = build({ rest, redispatch });

    await client.onReconnect(); // backfill first
    await client.deliverTurn("turn-7"); // live ping for the same turn

    expect(redispatch).toHaveBeenCalledTimes(1);
  });

  it("a failed pending-turns read dispatches nothing (logged, not crashing)", async () => {
    const rest = makeRestClient({ readPendingTurns: vi.fn(async () => ({ ok: false, status: 500 })) });
    const redispatch = vi.fn();
    const { client } = build({ rest, redispatch });
    await client.onReconnect();
    expect(redispatch).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// controlHooks integration with the T3 control handler shape
// ---------------------------------------------------------------------------

describe("controlHooks shape", () => {
  let hooks: OpenClawDaemonClient["controlHooks"];
  beforeEach(() => {
    hooks = build().client.controlHooks;
  });
  it("exposes isEntityRunning / onInterrupt / onResume / onDeliverTurn", () => {
    expect(typeof hooks.isEntityRunning).toBe("function");
    expect(typeof hooks.onInterrupt).toBe("function");
    expect(typeof hooks.onResume).toBe("function");
    expect(typeof hooks.onDeliverTurn).toBe("function");
  });
});

// Keep WakeRequest import meaningful for type-coverage of the test file.
const _typecheck: WakeRequest = { prompt: "x", contextKey: "y" };
void _typecheck;
