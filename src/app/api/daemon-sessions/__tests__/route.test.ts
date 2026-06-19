import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ===== Mocks =====
const mockGetAuthContext = vi.fn();
const mockGetVisibleSessionsWithOrigin = vi.fn();

vi.mock("@/lib/auth", () => ({
  getAuthContext: (...args: unknown[]) => mockGetAuthContext(...args),
}));

vi.mock("@/services/daemon-instruction.service", () => ({
  getVisibleSessionsWithOrigin: (...args: unknown[]) => mockGetVisibleSessionsWithOrigin(...args),
}));

import { GET } from "@/app/api/daemon-sessions/route";

// ===== Helpers =====
const companyUuid = "company-0000-0000-0000-000000000001";
const agentUuid = "agent-0000-0000-0000-000000000001";
const ownerUuid = "owner-0000-0000-0000-000000000001";

const userAuth = { type: "user", companyUuid, actorUuid: ownerUuid };
const agentAuth = { type: "agent", companyUuid, actorUuid: agentUuid, permissions: [] };
const emptyCtx = { params: Promise.resolve({}) };

const sessions = [
  {
    uuid: "s1",
    agentUuid,
    sessionId: "idea-1",
    directIdeaUuid: "idea-1",
    originConnectionUuid: "conn-1",
    status: "active",
    title: null,
    lastTurnAt: "2026-06-19T03:00:00.000Z",
    createdAt: "2026-06-19T03:00:00.000Z",
    updatedAt: "2026-06-19T03:00:00.000Z",
    originOnline: true,
  },
];

function getRequest(): NextRequest {
  return new NextRequest(new URL("http://localhost:3000/api/daemon-sessions"));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetAuthContext.mockResolvedValue(userAuth);
  mockGetVisibleSessionsWithOrigin.mockResolvedValue(sessions);
});

describe("GET /api/daemon-sessions", () => {
  it("401 + no read when unauthenticated", async () => {
    mockGetAuthContext.mockResolvedValue(null);
    const res = await GET(getRequest(), emptyCtx);
    expect(res.status).toBe(401);
    expect(mockGetVisibleSessionsWithOrigin).not.toHaveBeenCalled();
  });

  it("returns the caller's owner-scoped sessions with originOnline (standard envelope, no turn bodies)", async () => {
    const res = await GET(getRequest(), emptyCtx);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body).toEqual({ success: true, data: { sessions }, meta: undefined });
    expect(body.data.sessions[0]).toHaveProperty("originOnline", true);
    expect(body.data.sessions[0]).not.toHaveProperty("turns");

    // The service receives the auth context (owner/self scope enforced there).
    expect(mockGetVisibleSessionsWithOrigin).toHaveBeenCalledTimes(1);
    expect(mockGetVisibleSessionsWithOrigin.mock.calls[0][0]).toBe(userAuth);
  });

  it("agent-key caller is passed through to the service for self-scoping", async () => {
    mockGetAuthContext.mockResolvedValue(agentAuth);
    await GET(getRequest(), emptyCtx);
    expect(mockGetVisibleSessionsWithOrigin.mock.calls[0][0]).toBe(agentAuth);
  });

  it("returns an empty list when the caller has no sessions", async () => {
    mockGetVisibleSessionsWithOrigin.mockResolvedValue([]);
    const res = await GET(getRequest(), emptyCtx);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data.sessions).toEqual([]);
  });
});
