import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ===== Mocks =====
const mockGetAuthContext = vi.fn();
const mockRepoint = vi.fn();

vi.mock("@/lib/auth", () => ({
  getAuthContext: (...args: unknown[]) => mockGetAuthContext(...args),
}));

// Typed errors defined INSIDE the factory (hoisted with the mock) so the route's instanceof
// mapping is exercised against the same classes the test constructs; re-imported below.
vi.mock("@/services/daemon-instruction.service", () => {
  class SessionNotVisibleError extends Error {
    readonly code = "session_not_visible";
    constructor() {
      super("Daemon session not found");
      this.name = "SessionNotVisibleError";
    }
  }
  class ConnectionNotVisibleError extends Error {
    readonly code = "connection_not_visible";
    constructor() {
      super("Connection not found");
      this.name = "ConnectionNotVisibleError";
    }
  }
  class ConnectionOfflineError extends Error {
    readonly code = "connection_offline";
    readonly connectionUuid: string;
    constructor(connectionUuid: string) {
      super("connection offline");
      this.name = "ConnectionOfflineError";
      this.connectionUuid = connectionUuid;
    }
  }
  class RepointOriginLiveError extends Error {
    readonly code = "repoint_origin_live";
    readonly originConnectionUuid: string;
    constructor(originConnectionUuid: string) {
      super("origin still online");
      this.name = "RepointOriginLiveError";
      this.originConnectionUuid = originConnectionUuid;
    }
  }
  class InstructionTextError extends Error {
    readonly code = "invalid_instruction_text";
    readonly reason: string;
    constructor(reason: string) {
      super(reason);
      this.name = "InstructionTextError";
      this.reason = reason;
    }
  }
  return {
    repointSessionOriginAndSend: (...args: unknown[]) => mockRepoint(...args),
    SessionNotVisibleError,
    ConnectionNotVisibleError,
    ConnectionOfflineError,
    RepointOriginLiveError,
    InstructionTextError,
  };
});

import { POST } from "@/app/api/daemon-sessions/[sessionUuid]/repoint/route";
import {
  SessionNotVisibleError,
  ConnectionNotVisibleError,
  ConnectionOfflineError,
  RepointOriginLiveError,
  InstructionTextError,
} from "@/services/daemon-instruction.service";

// ===== Helpers =====
const companyUuid = "company-0000-0000-0000-000000000001";
const ownerUuid = "owner-0000-0000-0000-000000000001";
const agentUuid = "agent-0000-0000-0000-000000000001";
const sessionUuid = "sess-0000-0000-0000-000000000001";
const targetConnectionUuid = "conn-0000-0000-0000-0000000000ff";

const userAuth = { type: "user", companyUuid, actorUuid: ownerUuid };
const ctx = { params: Promise.resolve({ sessionUuid }) };
// The missing-param case: the route reads `sessionUuid` off the resolved params and 400s
// when absent. Cast through the typed param shape (the runtime value is genuinely empty).
const emptyCtx = {
  params: Promise.resolve({}) as Promise<{ sessionUuid: string }>,
};

const session = {
  uuid: sessionUuid,
  agentUuid,
  sessionId: "idea-1",
  directIdeaUuid: "idea-1",
  // Re-pointed to the chosen online connection — SAME session uuid/sessionId.
  originConnectionUuid: targetConnectionUuid,
  status: "active",
  title: null,
  lastTurnAt: "2026-06-23T03:00:00.000Z",
  createdAt: "2026-06-23T03:00:00.000Z",
  updatedAt: "2026-06-23T03:00:00.000Z",
};
const turn = {
  uuid: "turn-1",
  sessionUuid,
  seq: 5,
  trigger: "human_instruction",
  promptText: "pick up where we left off",
  status: "pending",
  executionUuid: null,
  startedAt: null,
  endedAt: null,
  createdAt: "2026-06-23T03:00:00.000Z",
};

const validBody = {
  connectionUuid: targetConnectionUuid,
  instructionText: "pick up where we left off",
};

function postRequest(body: unknown): NextRequest {
  return new NextRequest(
    new URL(`http://localhost:3000/api/daemon-sessions/${sessionUuid}/repoint`),
    {
      method: "POST",
      body: JSON.stringify(body),
      headers: { "content-type": "application/json" },
    },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetAuthContext.mockResolvedValue(userAuth);
  mockRepoint.mockResolvedValue({ session, turn });
});

describe("POST /api/daemon-sessions/[sessionUuid]/repoint", () => {
  it("401 + no re-point when unauthenticated", async () => {
    mockGetAuthContext.mockResolvedValue(null);
    const res = await POST(postRequest(validBody), ctx);
    expect(res.status).toBe(401);
    expect(mockRepoint).not.toHaveBeenCalled();
  });

  it("400 when sessionUuid param is missing", async () => {
    const res = await POST(postRequest(validBody), emptyCtx);
    expect(res.status).toBe(400);
    expect(mockRepoint).not.toHaveBeenCalled();
  });

  it("200 with the SAME (re-pointed) session + turn; service called with auth + {sessionUuid, body}", async () => {
    const res = await POST(postRequest(validBody), ctx);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toEqual({ success: true, data: { session, turn }, meta: undefined });
    expect(mockRepoint).toHaveBeenCalledTimes(1);
    expect(mockRepoint.mock.calls[0][0]).toBe(userAuth);
    expect(mockRepoint.mock.calls[0][1]).toEqual({
      sessionUuid,
      connectionUuid: targetConnectionUuid,
      instructionText: "pick up where we left off",
    });
    // The returned session keeps its identity — the same uuid + sessionId.
    expect(body.data.session.uuid).toBe(sessionUuid);
    expect(body.data.session.sessionId).toBe("idea-1");
  });

  it("400 when body is not valid JSON", async () => {
    const req = new NextRequest(
      new URL(`http://localhost:3000/api/daemon-sessions/${sessionUuid}/repoint`),
      { method: "POST", body: "{nope", headers: { "content-type": "application/json" } },
    );
    const res = await POST(req, ctx);
    expect(res.status).toBe(400);
    expect(mockRepoint).not.toHaveBeenCalled();
  });

  it("422 when required fields are missing (zod), no re-point", async () => {
    const res = await POST(postRequest({ instructionText: "go" }), ctx);
    expect(res.status).toBe(422);
    expect(mockRepoint).not.toHaveBeenCalled();
  });

  it("404 (non-disclosure) for a not-visible session", async () => {
    mockRepoint.mockRejectedValue(new SessionNotVisibleError());
    const res = await POST(postRequest(validBody), ctx);
    const body = await res.json();
    expect(res.status).toBe(404);
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("404 (non-disclosure) for a target connection not of the same agent", async () => {
    mockRepoint.mockRejectedValue(new ConnectionNotVisibleError());
    const res = await POST(postRequest(validBody), ctx);
    const body = await res.json();
    expect(res.status).toBe(404);
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("409 (conflict) when the current origin is still online (live session)", async () => {
    mockRepoint.mockRejectedValue(new RepointOriginLiveError("conn-live"));
    const res = await POST(postRequest(validBody), ctx);
    const body = await res.json();
    expect(res.status).toBe(409);
    expect(body.error.code).toBe("CONFLICT");
  });

  it("409 (conflict) for an offline target connection", async () => {
    mockRepoint.mockRejectedValue(new ConnectionOfflineError("conn-offline"));
    const res = await POST(postRequest(validBody), ctx);
    const body = await res.json();
    expect(res.status).toBe(409);
    expect(body.error.code).toBe("CONFLICT");
  });

  it("400 for empty/over-length instruction text (service InstructionTextError)", async () => {
    mockRepoint.mockRejectedValue(new InstructionTextError("empty"));
    const res = await POST(postRequest({ ...validBody, instructionText: "" }), ctx);
    expect(res.status).toBe(400);
  });

  it("an unexpected error propagates to the 500 handler", async () => {
    mockRepoint.mockRejectedValue(new Error("db boom"));
    const res = await POST(postRequest(validBody), ctx);
    expect(res.status).toBe(500);
  });
});
