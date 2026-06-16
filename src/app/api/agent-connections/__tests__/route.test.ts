import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ===== Mocks =====
const mockGetAuthContext = vi.fn();
const mockListConnectionsForOwner = vi.fn();
const mockListConnectionsForAgent = vi.fn();

vi.mock("@/lib/auth", () => ({
  getAuthContext: (...args: unknown[]) => mockGetAuthContext(...args),
}));

vi.mock("@/services/daemon-connection.service", () => ({
  listConnectionsForOwner: (...args: unknown[]) => mockListConnectionsForOwner(...args),
  listConnectionsForAgent: (...args: unknown[]) => mockListConnectionsForAgent(...args),
}));

import { GET } from "@/app/api/agent-connections/route";

// ===== Helpers =====
const companyUuid = "company-0000-0000-0000-000000000001";
const actorUuid = "actor-0000-0000-0000-000000000001";

const userAuth = { type: "user", companyUuid, actorUuid };
const agentAuth = { type: "agent", companyUuid, actorUuid, permissions: [] };

// A representative ConnectionView the mocked service returns; the route passes
// it through verbatim, so the exact shape only needs to round-trip. Includes
// agentName so the round-trip assertion locks in that the new field flows
// through the route untouched.
const sampleConnections = [
  {
    uuid: "conn-1",
    agentUuid: actorUuid,
    agentName: "Build Agent",
    clientType: "claude_code",
    clientVersion: "0.11.0",
    host: "laptop",
    startedAt: "2026-06-15T03:00:00.000Z",
    status: "online",
    effectiveStatus: "online",
    connectedAt: "2026-06-15T03:00:00.000Z",
    lastSeenAt: "2026-06-15T03:00:30.000Z",
    disconnectedAt: null,
  },
  // Null-agent case: a connection whose owning agent could not be resolved
  // still flows through the route with agentName: null (not omitted).
  {
    uuid: "conn-2",
    agentUuid: actorUuid,
    agentName: null,
    clientType: "openclaw",
    clientVersion: null,
    host: "",
    startedAt: null,
    status: "offline",
    effectiveStatus: "offline",
    connectedAt: "2026-06-15T03:00:00.000Z",
    lastSeenAt: "2026-06-15T03:01:00.000Z",
    disconnectedAt: "2026-06-15T03:02:00.000Z",
  },
];

function makeRequest(): NextRequest {
  return new NextRequest(new URL("http://localhost:3000/api/agent-connections"));
}

// withErrorHandler-wrapped handlers take (request, context); this route has no
// path params, so an empty params context satisfies the signature.
const emptyCtx = { params: Promise.resolve({}) };

beforeEach(() => {
  vi.clearAllMocks();
  mockListConnectionsForOwner.mockResolvedValue(sampleConnections);
  mockListConnectionsForAgent.mockResolvedValue(sampleConnections);
});

describe("GET /api/agent-connections", () => {
  it("returns 401 and calls neither list fn when unauthenticated", async () => {
    mockGetAuthContext.mockResolvedValue(null);

    const res = await GET(makeRequest(), emptyCtx);

    expect(res.status).toBe(401);
    expect(mockListConnectionsForOwner).not.toHaveBeenCalled();
    expect(mockListConnectionsForAgent).not.toHaveBeenCalled();
  });

  it("routes a user caller to listConnectionsForOwner(companyUuid, actorUuid) and surfaces agentName", async () => {
    mockGetAuthContext.mockResolvedValue(userAuth);

    const res = await GET(makeRequest(), emptyCtx);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(mockListConnectionsForOwner).toHaveBeenCalledTimes(1);
    expect(mockListConnectionsForOwner).toHaveBeenCalledWith(companyUuid, actorUuid);
    expect(mockListConnectionsForAgent).not.toHaveBeenCalled();
    // agentName flows through for both the populated and the null-agent cases.
    expect(body.data.connections.map((c: { agentName: string | null }) => c.agentName)).toEqual([
      "Build Agent",
      null,
    ]);
  });

  // Note: there is no super_admin case here. getAuthContext (the route's only
  // auth call) returns AuthContext | null and never yields a SuperAdminAuthContext
  // at runtime — every path resolves to "agent" or "user". The non-agent ("else")
  // branch is therefore exercised by the user case above.

  it("routes an agent caller to listConnectionsForAgent(companyUuid, actorUuid) and surfaces agentName", async () => {
    mockGetAuthContext.mockResolvedValue(agentAuth);

    const res = await GET(makeRequest(), emptyCtx);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(mockListConnectionsForAgent).toHaveBeenCalledTimes(1);
    expect(mockListConnectionsForAgent).toHaveBeenCalledWith(companyUuid, actorUuid);
    expect(mockListConnectionsForOwner).not.toHaveBeenCalled();
    // Same projection for the agent-self scope: populated and null-agent both
    // round-trip without the route stripping the field.
    expect(body.data.connections.map((c: { agentName: string | null }) => c.agentName)).toEqual([
      "Build Agent",
      null,
    ]);
  });

  it("returns the standard envelope { success: true, data: { connections } } passing the service result through", async () => {
    mockGetAuthContext.mockResolvedValue(userAuth);

    const res = await GET(makeRequest(), emptyCtx);
    const body = await res.json();

    expect(body).toEqual({
      success: true,
      data: { connections: sampleConnections },
      meta: undefined,
    });
  });
});
