import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ===== Mocks =====
const mockGetAuthContext = vi.fn();
const mockGetVisibleExecutions = vi.fn();

vi.mock("@/lib/auth", () => ({
  getAuthContext: (...args: unknown[]) => mockGetAuthContext(...args),
}));

// Mock the service: the route is the unit under test. The route's entire job is
// to fence on auth and delegate to `getVisibleExecutions(auth)` — the owner/self
// + companyUuid scoping itself lives in the service (tested there). So these tests
// assert the route (a) rejects no-auth, (b) passes the EXACT auth context through,
// and (c) returns whatever the (scoped) service yields under the standard envelope.
vi.mock("@/services/daemon-execution.service", () => ({
  getVisibleExecutions: (...args: unknown[]) => mockGetVisibleExecutions(...args),
}));

import { GET } from "@/app/api/daemon/executions/route";

// ===== Helpers =====
const companyA = "company-0000-0000-0000-00000000000a";
const companyB = "company-0000-0000-0000-00000000000b";
const ownerU = "owner-0000-0000-0000-0000000000000u";
const ownerV = "owner-0000-0000-0000-0000000000000v";
const agentKey = "agent-0000-0000-0000-000000000001";
const connA = "conn-0000-0000-0000-00000000000a1";
const connB = "conn-0000-0000-0000-00000000000b1";

const userAuthA = { type: "user", companyUuid: companyA, actorUuid: ownerU };
const userAuthV = { type: "user", companyUuid: companyA, actorUuid: ownerV };
const agentAuth = { type: "agent", companyUuid: companyA, actorUuid: agentKey, permissions: [] };
const userAuthCompanyB = { type: "user", companyUuid: companyB, actorUuid: ownerU };

const emptyCtx = { params: Promise.resolve({}) };

function getRequest(): NextRequest {
  return new NextRequest(new URL("http://localhost:3000/api/daemon/executions"));
}

// A minimal ExecutionView-ish row. The route never inspects the shape — it returns
// verbatim what the service yields — so partial rows are sufficient for the route
// test (the full projection is covered by the service test).
function execRow(uuid: string, connectionUuid: string, agentUuid: string) {
  return { uuid, connectionUuid, agentUuid, entityType: "task", status: "running" };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetAuthContext.mockResolvedValue(userAuthA);
  mockGetVisibleExecutions.mockResolvedValue([]);
});

describe("GET /api/daemon/executions (aggregate read)", () => {
  it("returns 401 and reads nothing when unauthenticated", async () => {
    mockGetAuthContext.mockResolvedValue(null);

    const res = await GET(getRequest(), emptyCtx);
    const body = await res.json();

    expect(res.status).toBe(401);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe("UNAUTHORIZED");
    expect(body).not.toHaveProperty("data.executions");
    expect(mockGetVisibleExecutions).not.toHaveBeenCalled();
  });

  it("owner-scoped aggregate: returns the user's executions across multiple connections in one envelope", async () => {
    // User U owns two online connections, each running a task — the aggregate
    // returns both connections' active executions in a single response.
    const rows = [
      execRow("exec-a", connA, "agent-a"),
      execRow("exec-b", connB, "agent-b"),
    ];
    mockGetVisibleExecutions.mockResolvedValue(rows);

    const res = await GET(getRequest(), emptyCtx);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ success: true, data: { executions: rows }, meta: undefined });
    // The route delegates scoping to the service, passing the EXACT auth context.
    expect(mockGetVisibleExecutions).toHaveBeenCalledTimes(1);
    expect(mockGetVisibleExecutions).toHaveBeenCalledWith(userAuthA);
    // Both connections' executions are present in the single aggregate response.
    expect(body.data.executions.map((e: { connectionUuid: string }) => e.connectionUuid)).toEqual([
      connA,
      connB,
    ]);
  });

  it("owner scope is honored: user V's auth is forwarded so the service returns only V's executions, never U's", async () => {
    // The owner/self scoping is enforced inside getVisibleExecutions(auth). The
    // route's contribution to "owner-scoped" is forwarding the caller's identity
    // unchanged — so a different owner (V) gets the service invoked with V's auth,
    // and the route surfaces exactly what that scoped query yields (V's rows only).
    mockGetAuthContext.mockResolvedValue(userAuthV);
    const vRows = [execRow("exec-v", connB, "agent-b")];
    mockGetVisibleExecutions.mockResolvedValue(vRows);

    const res = await GET(getRequest(), emptyCtx);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(mockGetVisibleExecutions).toHaveBeenCalledWith(userAuthV);
    expect(body.data.executions).toEqual(vRows);
  });

  it("agent-key self-scope: an agent API key's auth is forwarded so the service self-scopes to its own executions", async () => {
    mockGetAuthContext.mockResolvedValue(agentAuth);
    const ownRows = [execRow("exec-self", connA, agentKey)];
    mockGetVisibleExecutions.mockResolvedValue(ownRows);

    const res = await GET(getRequest(), emptyCtx);
    const body = await res.json();

    expect(res.status).toBe(200);
    // The full agent auth (type "agent" + actorUuid) is passed through so the
    // service applies its self-scope branch.
    expect(mockGetVisibleExecutions).toHaveBeenCalledWith(agentAuth);
    expect(body.data.executions).toEqual(ownRows);
  });

  it("cross-company isolation: the caller's companyUuid is forwarded so the service never crosses company boundaries", async () => {
    // Same owner identity but in company B: the route forwards the companyB auth
    // context verbatim, so the companyUuid-scoped service query cannot return
    // company A's executions.
    mockGetAuthContext.mockResolvedValue(userAuthCompanyB);
    mockGetVisibleExecutions.mockResolvedValue([]);

    const res = await GET(getRequest(), emptyCtx);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(mockGetVisibleExecutions).toHaveBeenCalledWith(userAuthCompanyB);
    // The forwarded auth carries companyB — the (mocked) scoped query yields none
    // of company A's rows.
    const [passedAuth] = mockGetVisibleExecutions.mock.calls[0];
    expect(passedAuth.companyUuid).toBe(companyB);
    expect(body.data.executions).toEqual([]);
  });
});
