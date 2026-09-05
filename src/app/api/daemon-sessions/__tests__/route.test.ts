import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ===== Mocks =====
const mockGetAuthContext = vi.fn();
const mockGetVisibleSessionsWithOrigin = vi.fn();
const mockGetVisibleSessionsPageWithOrigin = vi.fn();
const mockGetVisibleAgentIndex = vi.fn();

vi.mock("@/lib/auth", () => ({
  getAuthContext: (...args: unknown[]) => mockGetAuthContext(...args),
}));

vi.mock("@/services/daemon-instruction.service", () => ({
  getVisibleSessionsWithOrigin: (...args: unknown[]) => mockGetVisibleSessionsWithOrigin(...args),
  getVisibleSessionsPageWithOrigin: (...args: unknown[]) => mockGetVisibleSessionsPageWithOrigin(...args),
}));

vi.mock("@/services/daemon-session.service", () => ({
  getVisibleAgentIndex: (...args: unknown[]) => mockGetVisibleAgentIndex(...args),
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

function getRequest(query = ""): NextRequest {
  return new NextRequest(new URL(`http://localhost:3000/api/daemon-sessions${query}`));
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetAuthContext.mockResolvedValue(userAuth);
  mockGetVisibleSessionsWithOrigin.mockResolvedValue(sessions);
  mockGetVisibleSessionsPageWithOrigin.mockResolvedValue({
    sessions,
    nextCursor: "s1",
    hasMore: true,
  });
  mockGetVisibleAgentIndex.mockResolvedValue([
    { agentUuid, lastTurnAt: "2026-06-19T03:00:00.000Z", sessionCount: 1 },
  ]);
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

  it("LEGACY no-param mode does NOT touch the paginated/agent-index paths", async () => {
    await GET(getRequest(), emptyCtx);
    expect(mockGetVisibleSessionsWithOrigin).toHaveBeenCalledTimes(1);
    expect(mockGetVisibleSessionsPageWithOrigin).not.toHaveBeenCalled();
    expect(mockGetVisibleAgentIndex).not.toHaveBeenCalled();
  });

  it("?view=agents → agent-index mode (no full list, no page)", async () => {
    const res = await GET(getRequest("?view=agents"), emptyCtx);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data).toEqual({
      agents: [{ agentUuid, lastTurnAt: "2026-06-19T03:00:00.000Z", sessionCount: 1 }],
    });
    expect(mockGetVisibleAgentIndex).toHaveBeenCalledTimes(1);
    expect(mockGetVisibleAgentIndex.mock.calls[0][0]).toBe(userAuth);
    expect(mockGetVisibleSessionsWithOrigin).not.toHaveBeenCalled();
    expect(mockGetVisibleSessionsPageWithOrigin).not.toHaveBeenCalled();
  });

  it("?agentUuid=&limit=&before= → per-agent page mode with parsed opts", async () => {
    const res = await GET(
      getRequest(`?agentUuid=${agentUuid}&limit=5&before=cursor-1`),
      emptyCtx,
    );
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data).toEqual({ sessions, nextCursor: "s1", hasMore: true });
    expect(mockGetVisibleSessionsPageWithOrigin).toHaveBeenCalledTimes(1);
    const [auth, passedAgent, opts] = mockGetVisibleSessionsPageWithOrigin.mock.calls[0];
    expect(auth).toBe(userAuth);
    expect(passedAgent).toBe(agentUuid);
    expect(opts).toEqual({ limit: 5, before: "cursor-1" });
    expect(mockGetVisibleSessionsWithOrigin).not.toHaveBeenCalled();
  });

  it("per-agent page mode with no limit/before passes undefined limit + null before", async () => {
    await GET(getRequest(`?agentUuid=${agentUuid}`), emptyCtx);
    expect(mockGetVisibleSessionsPageWithOrigin.mock.calls[0][2]).toEqual({
      limit: undefined,
      before: null,
    });
  });

  it("per-agent page mode ignores a non-numeric limit (passes undefined, service clamps)", async () => {
    await GET(getRequest(`?agentUuid=${agentUuid}&limit=abc`), emptyCtx);
    expect(mockGetVisibleSessionsPageWithOrigin.mock.calls[0][2].limit).toBeUndefined();
  });
});
