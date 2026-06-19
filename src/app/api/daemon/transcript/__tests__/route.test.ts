import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ===== Mocks =====
const mockGetAuthContext = vi.fn();
const mockAppendTranscriptMessages = vi.fn();

vi.mock("@/lib/auth", () => ({
  getAuthContext: (...args: unknown[]) => mockGetAuthContext(...args),
}));

// Mock the service: the route is the unit under test. TRANSCRIPT_ROLES is re-exported
// for the route's zod enum, so the mock must provide it verbatim.
vi.mock("@/services/daemon-session.service", () => ({
  TRANSCRIPT_ROLES: ["user", "assistant"],
  appendTranscriptMessages: (...args: unknown[]) => mockAppendTranscriptMessages(...args),
}));

import { POST } from "@/app/api/daemon/transcript/route";

// ===== Helpers =====
const companyUuid = "company-0000-0000-0000-000000000001";
const agentUuid = "agent-0000-0000-0000-000000000001";
const ownerUuid = "owner-0000-0000-0000-000000000001";
const turnUuid = "turn-0000-0000-0000-000000000001";
const sessionId = "idea-0000-0000-0000-000000000001";

const agentAuth = { type: "agent", companyUuid, actorUuid: agentUuid, permissions: [] };
const userAuth = { type: "user", companyUuid, actorUuid: ownerUuid };

const emptyCtx = { params: Promise.resolve({}) };

function postRequest(body: unknown): NextRequest {
  return new NextRequest(new URL("http://localhost:3000/api/daemon/transcript"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

const validBody = {
  turnUuid,
  messages: [
    { role: "user", text: "do the thing" },
    { role: "assistant", text: "done" },
  ],
};

const okResult = {
  ok: true,
  appended: 2,
  stored: 2,
  messages: [
    { uuid: "m1", turnUuid, role: "user", text: "do the thing", seq: 1, createdAt: "2026-06-15T03:00:00.000Z" },
    { uuid: "m2", turnUuid, role: "assistant", text: "done", seq: 2, createdAt: "2026-06-15T03:00:01.000Z" },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  mockGetAuthContext.mockResolvedValue(agentAuth);
  mockAppendTranscriptMessages.mockResolvedValue(okResult);
});

describe("POST /api/daemon/transcript", () => {
  it("returns 401 and appends nothing when unauthenticated", async () => {
    mockGetAuthContext.mockResolvedValue(null);

    const res = await POST(postRequest(validBody), emptyCtx);

    expect(res.status).toBe(401);
    expect(mockAppendTranscriptMessages).not.toHaveBeenCalled();
  });

  it("appends a turn's transcript for the agent's own session: standard envelope", async () => {
    const res = await POST(postRequest(validBody), emptyCtx);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({
      success: true,
      data: { appended: 2, stored: 2, messages: okResult.messages },
      meta: undefined,
    });

    // The service is called with company/agent stamped from the authenticated context
    // (NOT trusted from the body), the turnUuid, a null sessionId, and the messages.
    expect(mockAppendTranscriptMessages).toHaveBeenCalledTimes(1);
    const arg = mockAppendTranscriptMessages.mock.calls[0][0];
    expect(arg.companyUuid).toBe(companyUuid);
    expect(arg.agentUuid).toBe(agentUuid);
    expect(arg.turnUuid).toBe(turnUuid);
    expect(arg.sessionId).toBeNull();
    expect(arg.messages).toEqual(validBody.messages);
  });

  it("accepts the sessionId (business-key) path and passes a null turnUuid", async () => {
    const res = await POST(
      postRequest({ sessionId, messages: [{ role: "user", text: "hi" }] }),
      emptyCtx,
    );

    expect(res.status).toBe(200);
    const arg = mockAppendTranscriptMessages.mock.calls[0][0];
    expect(arg.sessionId).toBe(sessionId);
    expect(arg.turnUuid).toBeNull();
  });

  it("a turn/session the agent does not own → 404 not-found (non-disclosure)", async () => {
    mockAppendTranscriptMessages.mockResolvedValue({ ok: false, reason: "not_found" });

    const res = await POST(postRequest(validBody), emptyCtx);
    const body = await res.json();

    // 404 (not 403) — does not reveal the turn/session exists.
    expect(res.status).toBe(404);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("a USER caller is passed through with its own actorUuid as the agent scope", async () => {
    // A user-key caller is scoped by the service to its own agents; the route forwards
    // the authenticated actor unchanged.
    mockGetAuthContext.mockResolvedValue(userAuth);
    await POST(postRequest(validBody), emptyCtx);
    const arg = mockAppendTranscriptMessages.mock.calls[0][0];
    expect(arg.companyUuid).toBe(companyUuid);
    expect(arg.agentUuid).toBe(ownerUuid);
  });

  it("rejects a body with NEITHER turnUuid nor sessionId (one-of refine) with 422", async () => {
    const res = await POST(postRequest({ messages: [{ role: "user", text: "x" }] }), emptyCtx);
    expect(res.status).toBe(422);
    expect(mockAppendTranscriptMessages).not.toHaveBeenCalled();
  });

  it("rejects a body with BOTH turnUuid and sessionId (one-of refine) with 422", async () => {
    const res = await POST(
      postRequest({ turnUuid, sessionId, messages: [{ role: "user", text: "x" }] }),
      emptyCtx,
    );
    expect(res.status).toBe(422);
    expect(mockAppendTranscriptMessages).not.toHaveBeenCalled();
  });

  it("rejects a message with an unrecognized role (tool/thinking) at the zod boundary", async () => {
    const res = await POST(
      postRequest({ turnUuid, messages: [{ role: "tool_result", text: "x" }] }),
      emptyCtx,
    );
    expect(res.status).toBe(422);
    expect(mockAppendTranscriptMessages).not.toHaveBeenCalled();
  });

  it("rejects a missing messages array with a validation error", async () => {
    const res = await POST(postRequest({ turnUuid }), emptyCtx);
    expect(res.status).toBe(422);
    expect(mockAppendTranscriptMessages).not.toHaveBeenCalled();
  });

  it("rejects a malformed (non-JSON) body with 400", async () => {
    const req = new NextRequest(new URL("http://localhost:3000/api/daemon/transcript"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not json",
    });
    const res = await POST(req, emptyCtx);
    expect(res.status).toBe(400);
    expect(mockAppendTranscriptMessages).not.toHaveBeenCalled();
  });

  it("accepts an empty messages array (no-op append) — service decides the outcome", async () => {
    mockAppendTranscriptMessages.mockResolvedValue({ ok: true, appended: 0, stored: 5, messages: [] });
    const res = await POST(postRequest({ turnUuid, messages: [] }), emptyCtx);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data.appended).toBe(0);
    expect(mockAppendTranscriptMessages).toHaveBeenCalledTimes(1);
  });
});
