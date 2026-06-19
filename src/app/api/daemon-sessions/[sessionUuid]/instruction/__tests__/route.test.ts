import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ===== Mocks =====
const mockGetAuthContext = vi.fn();
const mockSendInstruction = vi.fn();

vi.mock("@/lib/auth", () => ({
  getAuthContext: (...args: unknown[]) => mockGetAuthContext(...args),
}));

// Stub the composed modules. The typed error classes are defined INSIDE each factory
// (hoisted with the mock) so the route's `instanceof` mapping is exercised against the
// same class the test constructs; the classes are re-imported below for the test bodies.
vi.mock("@/services/daemon-session.service", () => {
  class SessionReadOnlyError extends Error {
    readonly code = "session_read_only";
    readonly originConnectionUuid: string;
    constructor(originConnectionUuid: string) {
      super("read only: origin offline");
      this.name = "SessionReadOnlyError";
      this.originConnectionUuid = originConnectionUuid;
    }
  }
  return { SessionReadOnlyError };
});

vi.mock("@/services/daemon-instruction.service", () => {
  class SessionNotVisibleError extends Error {
    readonly code = "session_not_visible";
    constructor() {
      super("Daemon session not found");
      this.name = "SessionNotVisibleError";
    }
  }
  class InstructionTextError extends Error {
    readonly code = "invalid_instruction_text";
    readonly reason: string;
    constructor(reason: string) {
      super(reason === "empty" ? "empty" : "too long");
      this.name = "InstructionTextError";
      this.reason = reason;
    }
  }
  return {
    sendInstruction: (...args: unknown[]) => mockSendInstruction(...args),
    SessionNotVisibleError,
    InstructionTextError,
  };
});

import { POST } from "@/app/api/daemon-sessions/[sessionUuid]/instruction/route";
import { SessionReadOnlyError } from "@/services/daemon-session.service";
import {
  SessionNotVisibleError,
  InstructionTextError,
} from "@/services/daemon-instruction.service";

// ===== Helpers =====
const companyUuid = "company-0000-0000-0000-000000000001";
const ownerUuid = "owner-0000-0000-0000-000000000001";
const sessionUuid = "sess-0000-0000-0000-000000000001";

const userAuth = { type: "user", companyUuid, actorUuid: ownerUuid };
const ctx = { params: Promise.resolve({ sessionUuid }) };

const turn = {
  uuid: "turn-1",
  sessionUuid,
  seq: 3,
  trigger: "human_instruction",
  promptText: "do it",
  status: "pending",
  executionUuid: null,
  startedAt: null,
  endedAt: null,
  createdAt: "2026-06-19T03:00:00.000Z",
};

function postRequest(body: unknown): NextRequest {
  return new NextRequest(
    new URL(`http://localhost:3000/api/daemon-sessions/${sessionUuid}/instruction`),
    { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetAuthContext.mockResolvedValue(userAuth);
  mockSendInstruction.mockResolvedValue({ turn });
});

describe("POST /api/daemon-sessions/{sessionUuid}/instruction", () => {
  it("401 + no send when unauthenticated", async () => {
    mockGetAuthContext.mockResolvedValue(null);
    const res = await POST(postRequest({ instructionText: "go" }), ctx);
    expect(res.status).toBe(401);
    expect(mockSendInstruction).not.toHaveBeenCalled();
  });

  it("200 with the created turn; service called with auth + sessionUuid + text", async () => {
    const res = await POST(postRequest({ instructionText: "do it" }), ctx);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toEqual({ success: true, data: { turn }, meta: undefined });
    expect(mockSendInstruction).toHaveBeenCalledTimes(1);
    expect(mockSendInstruction.mock.calls[0][0]).toBe(userAuth);
    expect(mockSendInstruction.mock.calls[0][1]).toEqual({ sessionUuid, instructionText: "do it" });
  });

  it("400 when body is not valid JSON, no send", async () => {
    const req = new NextRequest(
      new URL(`http://localhost:3000/api/daemon-sessions/${sessionUuid}/instruction`),
      { method: "POST", body: "{not json", headers: { "content-type": "application/json" } },
    );
    const res = await POST(req, ctx);
    expect(res.status).toBe(400);
    expect(mockSendInstruction).not.toHaveBeenCalled();
  });

  it("400 when instructionText is missing / not a string, no send", async () => {
    const res = await POST(postRequest({ foo: "bar" }), ctx);
    expect(res.status).toBe(400);
    expect(mockSendInstruction).not.toHaveBeenCalled();
    const res2 = await POST(postRequest({ instructionText: 42 }), ctx);
    expect(res2.status).toBe(400);
  });

  it("404 (non-disclosure) when the session is not visible", async () => {
    mockSendInstruction.mockRejectedValue(new SessionNotVisibleError());
    const res = await POST(postRequest({ instructionText: "go" }), ctx);
    const body = await res.json();
    expect(res.status).toBe(404);
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("409 (read-only/conflict) when the origin connection is offline", async () => {
    mockSendInstruction.mockRejectedValue(new SessionReadOnlyError("conn-offline"));
    const res = await POST(postRequest({ instructionText: "go" }), ctx);
    const body = await res.json();
    expect(res.status).toBe(409);
    expect(body.error.code).toBe("CONFLICT");
  });

  it("400 when the instruction text is empty/over-length (service InstructionTextError)", async () => {
    mockSendInstruction.mockRejectedValue(new InstructionTextError("empty"));
    const res = await POST(postRequest({ instructionText: "" }), ctx);
    expect(res.status).toBe(400);

    mockSendInstruction.mockRejectedValue(new InstructionTextError("too_long"));
    const res2 = await POST(postRequest({ instructionText: "x" }), ctx);
    expect(res2.status).toBe(400);
  });

  it("an unexpected error is not swallowed (propagates to the 500 handler)", async () => {
    mockSendInstruction.mockRejectedValue(new Error("db boom"));
    const res = await POST(postRequest({ instructionText: "go" }), ctx);
    expect(res.status).toBe(500);
  });
});
