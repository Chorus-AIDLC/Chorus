import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ===== Mocks =====
const mockGetAuthContext = vi.fn();
const mockCreateAdHoc = vi.fn();

vi.mock("@/lib/auth", () => ({
  getAuthContext: (...args: unknown[]) => mockGetAuthContext(...args),
}));

// Typed errors defined INSIDE the factory (hoisted with the mock) so the route's
// instanceof mapping is exercised against the same class the test constructs; re-imported
// below for the test bodies.
vi.mock("@/services/daemon-instruction.service", () => {
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
    createAdHocSessionWithInstruction: (...args: unknown[]) => mockCreateAdHoc(...args),
    ConnectionNotVisibleError,
    ConnectionOfflineError,
    InstructionTextError,
  };
});

import { POST } from "@/app/api/daemon-sessions/ad-hoc/route";
import {
  ConnectionNotVisibleError,
  ConnectionOfflineError,
  InstructionTextError,
} from "@/services/daemon-instruction.service";

// ===== Helpers =====
const companyUuid = "company-0000-0000-0000-000000000001";
const ownerUuid = "owner-0000-0000-0000-000000000001";
const agentUuid = "agent-0000-0000-0000-000000000001";
const connectionUuid = "conn-0000-0000-0000-000000000001";

const userAuth = { type: "user", companyUuid, actorUuid: ownerUuid };
const emptyCtx = { params: Promise.resolve({}) };

const session = {
  uuid: "sess-1",
  agentUuid,
  sessionId: "adhoc-1",
  directIdeaUuid: null,
  originConnectionUuid: connectionUuid,
  status: "active",
  title: null,
  lastTurnAt: "2026-06-19T03:00:00.000Z",
  createdAt: "2026-06-19T03:00:00.000Z",
  updatedAt: "2026-06-19T03:00:00.000Z",
};
const turn = {
  uuid: "turn-1",
  sessionUuid: "sess-1",
  seq: 1,
  trigger: "human_instruction",
  promptText: "kick off",
  status: "pending",
  executionUuid: null,
  startedAt: null,
  endedAt: null,
  createdAt: "2026-06-19T03:00:00.000Z",
};

const validBody = { agentUuid, connectionUuid, instructionText: "kick off" };

function postRequest(body: unknown): NextRequest {
  return new NextRequest(new URL("http://localhost:3000/api/daemon-sessions/ad-hoc"), {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetAuthContext.mockResolvedValue(userAuth);
  mockCreateAdHoc.mockResolvedValue({ session, turn });
});

describe("POST /api/daemon-sessions/ad-hoc", () => {
  it("401 + no create when unauthenticated", async () => {
    mockGetAuthContext.mockResolvedValue(null);
    const res = await POST(postRequest(validBody), emptyCtx);
    expect(res.status).toBe(401);
    expect(mockCreateAdHoc).not.toHaveBeenCalled();
  });

  it("200 with { session, turn }; service called with auth + body", async () => {
    const res = await POST(postRequest(validBody), emptyCtx);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toEqual({ success: true, data: { session, turn }, meta: undefined });
    expect(mockCreateAdHoc).toHaveBeenCalledTimes(1);
    expect(mockCreateAdHoc.mock.calls[0][0]).toBe(userAuth);
    expect(mockCreateAdHoc.mock.calls[0][1]).toEqual(validBody);
  });

  it("400 when body is not valid JSON", async () => {
    const req = new NextRequest(new URL("http://localhost:3000/api/daemon-sessions/ad-hoc"), {
      method: "POST",
      body: "{nope",
      headers: { "content-type": "application/json" },
    });
    const res = await POST(req, emptyCtx);
    expect(res.status).toBe(400);
    expect(mockCreateAdHoc).not.toHaveBeenCalled();
  });

  it("422 when required fields are missing (zod), no create", async () => {
    const res = await POST(postRequest({ instructionText: "go" }), emptyCtx);
    expect(res.status).toBe(422);
    expect(mockCreateAdHoc).not.toHaveBeenCalled();
  });

  it("404 (non-disclosure) for an unowned/absent connection", async () => {
    mockCreateAdHoc.mockRejectedValue(new ConnectionNotVisibleError());
    const res = await POST(postRequest(validBody), emptyCtx);
    const body = await res.json();
    expect(res.status).toBe(404);
    expect(body.error.code).toBe("NOT_FOUND");
  });

  it("409 (conflict) for an offline connection", async () => {
    mockCreateAdHoc.mockRejectedValue(new ConnectionOfflineError("conn-offline"));
    const res = await POST(postRequest(validBody), emptyCtx);
    const body = await res.json();
    expect(res.status).toBe(409);
    expect(body.error.code).toBe("CONFLICT");
  });

  it("400 for empty/over-length instruction text (service InstructionTextError)", async () => {
    mockCreateAdHoc.mockRejectedValue(new InstructionTextError("empty"));
    const res = await POST(postRequest({ ...validBody, instructionText: "" }), emptyCtx);
    expect(res.status).toBe(400);
  });

  it("an unexpected error propagates to the 500 handler", async () => {
    mockCreateAdHoc.mockRejectedValue(new Error("db boom"));
    const res = await POST(postRequest(validBody), emptyCtx);
    expect(res.status).toBe(500);
  });
});
