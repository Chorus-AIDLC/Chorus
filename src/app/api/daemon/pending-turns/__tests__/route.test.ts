import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ===== Mocks =====
const mockGetAuthContext = vi.fn();
const mockConnectionBelongsToAgent = vi.fn();
const mockGetPendingTurnsForConnection = vi.fn();

vi.mock("@/lib/auth", () => ({
  getAuthContext: (...args: unknown[]) => mockGetAuthContext(...args),
}));

vi.mock("@/services/daemon-execution.service", () => ({
  connectionBelongsToAgent: (...args: unknown[]) => mockConnectionBelongsToAgent(...args),
}));

vi.mock("@/services/daemon-session.service", () => ({
  getPendingTurnsForConnection: (...args: unknown[]) => mockGetPendingTurnsForConnection(...args),
}));

import { GET } from "@/app/api/daemon/pending-turns/route";

// ===== Helpers =====
const companyUuid = "company-0000-0000-0000-000000000001";
const agentUuid = "agent-0000-0000-0000-000000000001";
const connectionUuid = "conn-0000-0000-0000-000000000001";

const agentAuth = { type: "agent", companyUuid, actorUuid: agentUuid, permissions: [] };
const emptyCtx = { params: Promise.resolve({}) };

function getRequest(query: string): NextRequest {
  return new NextRequest(new URL(`http://localhost:3000/api/daemon/pending-turns${query}`));
}

const pendingTurns = [
  { turnUuid: "t1", sessionUuid: "s1", sessionId: "idea-1", directIdeaUuid: "idea-1", seq: 1, trigger: "human_instruction", promptText: "do X" },
  { turnUuid: "t2", sessionUuid: "s1", sessionId: "idea-1", directIdeaUuid: "idea-1", seq: 2, trigger: "human_instruction", promptText: "do Y" },
];

beforeEach(() => {
  vi.clearAllMocks();
  mockGetAuthContext.mockResolvedValue(agentAuth);
  mockConnectionBelongsToAgent.mockResolvedValue(true);
  mockGetPendingTurnsForConnection.mockResolvedValue(pendingTurns);
});

describe("GET /api/daemon/pending-turns", () => {
  it("401 + no read when unauthenticated", async () => {
    mockGetAuthContext.mockResolvedValue(null);
    const res = await GET(getRequest(`?connectionUuid=${connectionUuid}`), emptyCtx);
    expect(res.status).toBe(401);
    expect(mockGetPendingTurnsForConnection).not.toHaveBeenCalled();
  });

  it("returns this connection's pending turns: standard envelope, service stamped from auth", async () => {
    const res = await GET(getRequest(`?connectionUuid=${connectionUuid}`), emptyCtx);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toEqual({ success: true, data: { turns: pendingTurns }, meta: undefined });

    expect(mockGetPendingTurnsForConnection).toHaveBeenCalledTimes(1);
    const arg = mockGetPendingTurnsForConnection.mock.calls[0][0];
    expect(arg.companyUuid).toBe(companyUuid);
    expect(arg.agentUuid).toBe(agentUuid);
    expect(arg.connectionUuid).toBe(connectionUuid);
  });

  it("400 when connectionUuid is missing", async () => {
    const res = await GET(getRequest(""), emptyCtx);
    expect(res.status).toBe(400);
    expect(mockGetPendingTurnsForConnection).not.toHaveBeenCalled();
  });

  it("a connection the agent does not own → 404 (non-disclosure), service not called", async () => {
    mockConnectionBelongsToAgent.mockResolvedValue(false);
    const res = await GET(getRequest(`?connectionUuid=${connectionUuid}`), emptyCtx);
    const body = await res.json();
    expect(res.status).toBe(404);
    expect(body.error.code).toBe("NOT_FOUND");
    expect(mockGetPendingTurnsForConnection).not.toHaveBeenCalled();
  });

  it("returns an empty list when there are no pending turns", async () => {
    mockGetPendingTurnsForConnection.mockResolvedValue([]);
    const res = await GET(getRequest(`?connectionUuid=${connectionUuid}`), emptyCtx);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data.turns).toEqual([]);
  });
});
