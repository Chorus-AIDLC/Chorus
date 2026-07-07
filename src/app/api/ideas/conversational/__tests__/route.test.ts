// Route tests for POST /api/ideas/conversational — typed-error → status mapping and
// body validation (add-conversational-idea-root-session). Mirrors the ad-hoc route's
// test harness: the service is mocked with the SAME error classes the route imports so
// its instanceof mapping is exercised for real.

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockGetAuthContext = vi.fn();
const mockCreateConversational = vi.fn();

vi.mock("@/lib/auth", () => ({
  getAuthContext: (...args: unknown[]) => mockGetAuthContext(...args),
}));

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
  class ConnectionInstanceMissingError extends Error {
    readonly code = "connection_instance_missing";
    readonly connectionUuid: string;
    constructor(connectionUuid: string) {
      super("connection has no instance");
      this.name = "ConnectionInstanceMissingError";
      this.connectionUuid = connectionUuid;
    }
  }
  class ProjectNotVisibleError extends Error {
    readonly code = "project_not_visible";
    constructor() {
      super("Project not found");
      this.name = "ProjectNotVisibleError";
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
    createConversationalIdeaSession: (...args: unknown[]) =>
      mockCreateConversational(...args),
    ConnectionNotVisibleError,
    ConnectionOfflineError,
    ConnectionInstanceMissingError,
    ProjectNotVisibleError,
    InstructionTextError,
  };
});

import { POST } from "@/app/api/ideas/conversational/route";
import {
  ConnectionNotVisibleError,
  ConnectionOfflineError,
  ConnectionInstanceMissingError,
  ProjectNotVisibleError,
  InstructionTextError,
} from "@/services/daemon-instruction.service";

// ===== Helpers =====
const companyUuid = "company-0000-0000-0000-000000000001";
const ownerUuid = "owner-0000-0000-0000-000000000001";
const userAuth = { type: "user", companyUuid, actorUuid: ownerUuid };
const emptyCtx = { params: Promise.resolve({}) };

const validBody = {
  projectUuid: "proj-1",
  agentUuid: "agent-1",
  connectionUuid: "conn-1",
  descriptionText: "Build the thing",
};

function makeRequest(body: unknown): NextRequest {
  return new NextRequest("http://localhost/api/ideas/conversational", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

const dispatchResult = {
  idea: { uuid: "idea-1", title: "Build the thing", status: "elaborating" },
  session: { uuid: "sess-1", sessionId: "idea-1", directIdeaUuid: "idea-1" },
  turn: { uuid: "turn-1", seq: 1, trigger: "human_instruction" },
};

beforeEach(() => {
  vi.clearAllMocks();
  mockGetAuthContext.mockResolvedValue(userAuth);
  mockCreateConversational.mockResolvedValue(dispatchResult);
});

describe("POST /api/ideas/conversational", () => {
  it("401 when unauthenticated", async () => {
    mockGetAuthContext.mockResolvedValue(null);
    const res = await POST(makeRequest(validBody), emptyCtx);
    expect(res.status).toBe(401);
    expect(mockCreateConversational).not.toHaveBeenCalled();
  });

  it("400 on invalid JSON body", async () => {
    const req = new NextRequest("http://localhost/api/ideas/conversational", {
      method: "POST",
      body: "not-json{",
      headers: { "Content-Type": "application/json" },
    });
    const res = await POST(req, emptyCtx);
    expect(res.status).toBe(400);
    expect(mockCreateConversational).not.toHaveBeenCalled();
  });

  it("422 when identifier fields are missing (shared validationError convention)", async () => {
    const res = await POST(
      makeRequest({ projectUuid: "p", descriptionText: "x" }),
      emptyCtx,
    );
    expect(res.status).toBe(422);
    expect(mockCreateConversational).not.toHaveBeenCalled();
  });

  it("200 with { idea, session, turn } on success, threading auth + body through", async () => {
    const res = await POST(makeRequest(validBody), emptyCtx);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.success).toBe(true);
    expect(json.data.idea.uuid).toBe("idea-1");
    expect(json.data.session.sessionId).toBe("idea-1");
    expect(json.data.turn.uuid).toBe("turn-1");
    expect(mockCreateConversational).toHaveBeenCalledWith(userAuth, validBody);
  });

  it("404 non-disclosure for an unowned agent / foreign connection", async () => {
    mockCreateConversational.mockRejectedValue(new ConnectionNotVisibleError());
    const res = await POST(makeRequest(validBody), emptyCtx);
    expect(res.status).toBe(404);
  });

  it("404 non-disclosure for a foreign/absent project", async () => {
    mockCreateConversational.mockRejectedValue(new ProjectNotVisibleError());
    const res = await POST(makeRequest(validBody), emptyCtx);
    expect(res.status).toBe(404);
  });

  it("409 for an offline connection", async () => {
    mockCreateConversational.mockRejectedValue(new ConnectionOfflineError("conn-1"));
    const res = await POST(makeRequest(validBody), emptyCtx);
    expect(res.status).toBe(409);
  });

  it("409 for a connection with no linked instance", async () => {
    mockCreateConversational.mockRejectedValue(
      new ConnectionInstanceMissingError("conn-1"),
    );
    const res = await POST(makeRequest(validBody), emptyCtx);
    expect(res.status).toBe(409);
  });

  it("400 for empty/over-length instruction text", async () => {
    mockCreateConversational.mockRejectedValue(new InstructionTextError("empty"));
    const res = await POST(makeRequest(validBody), emptyCtx);
    expect(res.status).toBe(400);
  });

  it("unknown errors propagate to the shared 500 handler", async () => {
    mockCreateConversational.mockRejectedValue(new Error("boom"));
    const res = await POST(makeRequest(validBody), emptyCtx);
    expect(res.status).toBe(500);
  });
});
