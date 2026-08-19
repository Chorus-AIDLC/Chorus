import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ===== Mocks =====
const mockGetAuthContext = vi.fn();
const mockConnectionBelongsToAgent = vi.fn();
const mockAdvanceTurnForWake = vi.fn();

vi.mock("@/lib/auth", () => ({
  getAuthContext: (...args: unknown[]) => mockGetAuthContext(...args),
}));

// daemon-execution.service: the route uses connectionBelongsToAgent (ownership fence)
// and EXECUTION_ENTITY_TYPES (zod enum). Provide both verbatim.
vi.mock("@/services/daemon-execution.service", () => ({
  EXECUTION_ENTITY_TYPES: ["task", "idea", "proposal", "document"],
  connectionBelongsToAgent: (...args: unknown[]) => mockConnectionBelongsToAgent(...args),
}));

// daemon-session.service: TURN_STATUSES + the daemon-reportable interrupt-reason
// subset, re-exported for the route's zod enums.
vi.mock("@/services/daemon-session.service", () => ({
  TURN_STATUSES: ["pending", "running", "ended", "interrupted"],
  DAEMON_REPORTABLE_INTERRUPT_REASONS: ["user", "crash", "shutdown", "invalid_path"],
  advanceTurnForWake: (...args: unknown[]) => mockAdvanceTurnForWake(...args),
}));

import { POST } from "@/app/api/daemon/turn-advance/route";

// ===== Helpers =====
const companyUuid = "company-0000-0000-0000-000000000001";
const agentUuid = "agent-0000-0000-0000-000000000001";
const connectionUuid = "conn-0000-0000-0000-000000000001";
const sessionId = "idea-0000-0000-0000-000000000001";

const agentAuth = { type: "agent", companyUuid, actorUuid: agentUuid, permissions: [] };
const emptyCtx = { params: Promise.resolve({}) };

function postRequest(body: unknown): NextRequest {
  return new NextRequest(new URL("http://localhost:3000/api/daemon/turn-advance"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const turnView = {
  uuid: "turn-1",
  sessionUuid: "sess-1",
  seq: 3,
  trigger: "human_instruction",
  promptText: "do X",
  status: "running",
  executionUuid: "exec-1",
  startedAt: "2026-06-19T06:00:00.000Z",
  endedAt: null,
  createdAt: "2026-06-19T05:59:00.000Z",
};

const runningBody = { connectionUuid, sessionId, status: "running", entityType: "task", entityUuid: "task-9" };

beforeEach(() => {
  vi.clearAllMocks();
  mockGetAuthContext.mockResolvedValue(agentAuth);
  mockConnectionBelongsToAgent.mockResolvedValue(true);
  mockAdvanceTurnForWake.mockResolvedValue({ ok: true, turn: turnView });
});

describe("POST /api/daemon/turn-advance", () => {
  it("401 + no advance when unauthenticated", async () => {
    mockGetAuthContext.mockResolvedValue(null);
    const res = await POST(postRequest(runningBody), emptyCtx);
    expect(res.status).toBe(401);
    expect(mockAdvanceTurnForWake).not.toHaveBeenCalled();
  });

  it("advances the turn for the agent's own connection: standard envelope, service stamped from auth", async () => {
    const res = await POST(postRequest(runningBody), emptyCtx);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toEqual({ success: true, data: { turn: turnView }, meta: undefined });

    expect(mockAdvanceTurnForWake).toHaveBeenCalledTimes(1);
    const arg = mockAdvanceTurnForWake.mock.calls[0][0];
    expect(arg.companyUuid).toBe(companyUuid); // stamped from auth, not the body
    expect(arg.agentUuid).toBe(agentUuid);
    expect(arg.connectionUuid).toBe(connectionUuid);
    expect(arg.sessionId).toBe(sessionId);
    expect(arg.status).toBe("running");
    expect(arg.entityType).toBe("task");
    expect(arg.entityUuid).toBe("task-9");
  });

  it("accepts a body WITHOUT the optional entity (null entityType/entityUuid to the service)", async () => {
    const res = await POST(postRequest({ connectionUuid, sessionId, status: "ended" }), emptyCtx);
    expect(res.status).toBe(200);
    const arg = mockAdvanceTurnForWake.mock.calls[0][0];
    expect(arg.entityType).toBeNull();
    expect(arg.entityUuid).toBeNull();
    expect(arg.status).toBe("ended");
  });

  it("passes a bounded backendSessionId to the agent-scoped service", async () => {
    const res = await POST(
      postRequest({ connectionUuid, sessionId, status: "ended", backendSessionId: " thread-1 " }),
      emptyCtx,
    );
    expect(res.status).toBe(200);
    expect(mockAdvanceTurnForWake.mock.calls[0][0].backendSessionId).toBe("thread-1");
  });

  it("passes optional turnUuid correlation to the agent-scoped service", async () => {
    const res = await POST(
      postRequest({ connectionUuid, sessionId, turnUuid: "turn-1", status: "ended" }),
      emptyCtx,
    );
    expect(res.status).toBe(200);
    expect(mockAdvanceTurnForWake.mock.calls[0][0].turnUuid).toBe("turn-1");
  });

  it("rejects an empty backendSessionId", async () => {
    const res = await POST(
      postRequest({ connectionUuid, sessionId, status: "ended", backendSessionId: "   " }),
      emptyCtx,
    );
    expect(res.status).toBe(422);
    expect(mockAdvanceTurnForWake).not.toHaveBeenCalled();
  });

  it("a connection the agent does not own → 404 (non-disclosure), service not called", async () => {
    mockConnectionBelongsToAgent.mockResolvedValue(false);
    const res = await POST(postRequest(runningBody), emptyCtx);
    const body = await res.json();
    expect(res.status).toBe(404);
    expect(body.error.code).toBe("NOT_FOUND");
    expect(mockAdvanceTurnForWake).not.toHaveBeenCalled();
  });

  it("a session/turn the agent does not own → 404 (service not_found)", async () => {
    mockAdvanceTurnForWake.mockResolvedValue({ ok: false, reason: "not_found" });
    const res = await POST(postRequest(runningBody), emptyCtx);
    const body = await res.json();
    expect(res.status).toBe(404);
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("an illegal transition → 409 conflict (surfaced, not swallowed)", async () => {
    mockAdvanceTurnForWake.mockResolvedValue({
      ok: false,
      reason: "invalid_transition",
      from: "ended",
      to: "running",
    });
    const res = await POST(postRequest(runningBody), emptyCtx);
    const body = await res.json();
    expect(res.status).toBe(409);
    expect(body.error.code).toBe("CONFLICT");
    expect(body.error.message).toMatch(/ended → running/);
  });

  it("a conflicting backend session ID → 409 conflict", async () => {
    mockAdvanceTurnForWake.mockResolvedValue({ ok: false, reason: "backend_session_conflict" });
    const res = await POST(
      postRequest({ connectionUuid, sessionId, status: "ended", backendSessionId: "thread-2" }),
      emptyCtx,
    );
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("CONFLICT");
  });

  it("accepts status=interrupted with a daemon-reportable reason and passes it through", async () => {
    const res = await POST(
      postRequest({ connectionUuid, sessionId, status: "interrupted", interruptedReason: "shutdown" }),
      emptyCtx,
    );
    expect(res.status).toBe(200);
    const arg = mockAdvanceTurnForWake.mock.calls[0][0];
    expect(arg.status).toBe("interrupted");
    expect(arg.interruptedReason).toBe("shutdown");
  });

  it("passes transcriptRelayError through as relayError on a terminal edge (fix #444 follow-up)", async () => {
    const res = await POST(
      postRequest({
        connectionUuid,
        sessionId,
        status: "ended",
        transcriptRelayError: "transcript upload returned 502",
      }),
      emptyCtx,
    );
    expect(res.status).toBe(200);
    const arg = mockAdvanceTurnForWake.mock.calls[0][0];
    expect(arg.status).toBe("ended");
    expect(arg.relayError).toBe("transcript upload returned 502");
  });

  it("omits relayError (undefined) when the body carries no transcriptRelayError", async () => {
    await POST(postRequest({ connectionUuid, sessionId, status: "ended" }), emptyCtx);
    const arg = mockAdvanceTurnForWake.mock.calls[0][0];
    expect(arg.relayError).toBeUndefined();
  });

  it("rejects a transcriptRelayError over the length bound (422)", async () => {
    const res = await POST(
      postRequest({
        connectionUuid,
        sessionId,
        status: "ended",
        transcriptRelayError: "x".repeat(501),
      }),
      emptyCtx,
    );
    expect(res.status).toBe(422);
    expect(mockAdvanceTurnForWake).not.toHaveBeenCalled();
  });

  it("passes a valid usage object through to the service, normalized to number|null (daemon-token-usage)", async () => {
    const res = await POST(
      postRequest({
        connectionUuid,
        sessionId,
        status: "ended",
        usage: {
          inputTokens: 10,
          outputTokens: 214,
          cacheCreationTokens: 24701,
          cacheReadTokens: 0,
          model: "claude-haiku-4-5",
          source: "claude_code",
        },
      }),
      emptyCtx,
    );
    expect(res.status).toBe(200);
    const arg = mockAdvanceTurnForWake.mock.calls[0][0];
    expect(arg.usage).toEqual({
      inputTokens: 10,
      outputTokens: 214,
      cacheCreationTokens: 24701,
      cacheReadTokens: 0,
      model: "claude-haiku-4-5",
      source: "claude_code",
    });
  });

  it("normalizes omitted usage fields to null (partial usage still passes)", async () => {
    await POST(
      postRequest({
        connectionUuid,
        sessionId,
        status: "ended",
        usage: { inputTokens: 5, outputTokens: 7, source: "claude_code" },
      }),
      emptyCtx,
    );
    const arg = mockAdvanceTurnForWake.mock.calls[0][0];
    expect(arg.usage).toEqual({
      inputTokens: 5,
      outputTokens: 7,
      cacheCreationTokens: null,
      cacheReadTokens: null,
      model: null,
      source: "claude_code",
    });
  });

  it("omits usage (undefined) when the body carries none — behaves exactly as before", async () => {
    await POST(postRequest({ connectionUuid, sessionId, status: "ended" }), emptyCtx);
    const arg = mockAdvanceTurnForWake.mock.calls[0][0];
    expect(arg.usage).toBeUndefined();
  });

  it("rejects a usage with a negative token count (422)", async () => {
    const res = await POST(
      postRequest({
        connectionUuid,
        sessionId,
        status: "ended",
        usage: { inputTokens: -1, source: "claude_code" },
      }),
      emptyCtx,
    );
    expect(res.status).toBe(422);
    expect(mockAdvanceTurnForWake).not.toHaveBeenCalled();
  });

  it("rejects a usage missing the required source (422)", async () => {
    const res = await POST(
      postRequest({
        connectionUuid,
        sessionId,
        status: "ended",
        usage: { inputTokens: 10, outputTokens: 20 },
      }),
      emptyCtx,
    );
    expect(res.status).toBe(422);
    expect(mockAdvanceTurnForWake).not.toHaveBeenCalled();
  });

  it("rejects interruptedReason=offline (server-reconcile verdict, not daemon-reportable) at the zod boundary", async () => {
    const res = await POST(
      postRequest({ connectionUuid, sessionId, status: "interrupted", interruptedReason: "offline" }),
      emptyCtx,
    );
    expect(res.status).toBe(422);
    expect(mockAdvanceTurnForWake).not.toHaveBeenCalled();
  });

  it("rejects an interruptedReason accompanying a non-interrupted status (422)", async () => {
    const res = await POST(
      postRequest({ connectionUuid, sessionId, status: "ended", interruptedReason: "crash" }),
      emptyCtx,
    );
    expect(res.status).toBe(422);
    expect(mockAdvanceTurnForWake).not.toHaveBeenCalled();
  });

  it("rejects status=interrupted WITHOUT a reason (non-null-iff-interrupted enforced at the boundary)", async () => {
    const res = await POST(
      postRequest({ connectionUuid, sessionId, status: "interrupted" }),
      emptyCtx,
    );
    expect(res.status).toBe(422);
    expect(mockAdvanceTurnForWake).not.toHaveBeenCalled();
  });

  it("threads an explicit coalescedCount through to the service (daemon-wake-coalescing)", async () => {
    const res = await POST(
      postRequest({ connectionUuid, sessionId, status: "running", coalescedCount: 4 }),
      emptyCtx,
    );
    expect(res.status).toBe(200);
    expect(mockAdvanceTurnForWake.mock.calls[0][0].coalescedCount).toBe(4);
  });

  it("defaults coalescedCount to 1 when the body omits it (single-wake, byte-identical)", async () => {
    await POST(postRequest({ connectionUuid, sessionId, status: "running" }), emptyCtx);
    expect(mockAdvanceTurnForWake.mock.calls[0][0].coalescedCount).toBe(1);
  });

  it("rejects coalescedCount < 1 at the zod boundary (422, service not called)", async () => {
    const res = await POST(
      postRequest({ connectionUuid, sessionId, status: "running", coalescedCount: 0 }),
      emptyCtx,
    );
    expect(res.status).toBe(422);
    expect(mockAdvanceTurnForWake).not.toHaveBeenCalled();
  });

  it("rejects a non-integer coalescedCount (422)", async () => {
    const res = await POST(
      postRequest({ connectionUuid, sessionId, status: "running", coalescedCount: 2.5 }),
      emptyCtx,
    );
    expect(res.status).toBe(422);
    expect(mockAdvanceTurnForWake).not.toHaveBeenCalled();
  });

  it("rejects a bad status at the zod boundary (422)", async () => {
    const res = await POST(postRequest({ connectionUuid, sessionId, status: "weird" }), emptyCtx);
    expect(res.status).toBe(422);
    expect(mockAdvanceTurnForWake).not.toHaveBeenCalled();
  });

  it("rejects a missing connectionUuid / sessionId (422)", async () => {
    expect((await POST(postRequest({ sessionId, status: "running" }), emptyCtx)).status).toBe(422);
    expect((await POST(postRequest({ connectionUuid, status: "running" }), emptyCtx)).status).toBe(422);
    expect(mockAdvanceTurnForWake).not.toHaveBeenCalled();
  });

  it("rejects invalid JSON (400)", async () => {
    const req = new NextRequest(new URL("http://localhost:3000/api/daemon/turn-advance"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });
    const res = await POST(req, emptyCtx);
    expect(res.status).toBe(400);
  });
});
