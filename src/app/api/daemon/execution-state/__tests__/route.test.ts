import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ===== Mocks =====
const mockGetAuthContext = vi.fn();
const mockReconcileSnapshot = vi.fn();
const mockPublishExecutionChange = vi.fn();
const mockConnectionBelongsToAgent = vi.fn();
const mockConnectionVisibleToCaller = vi.fn();
const mockGetExecutionsForConnection = vi.fn();
const mockFilterValidExecutionEntities = vi.fn();

vi.mock("@/lib/auth", () => ({
  getAuthContext: (...args: unknown[]) => mockGetAuthContext(...args),
}));

// Mock the service: the route is the unit under test. ACTIVE_EXECUTION_STATUSES
// and EXECUTION_ENTITY_TYPES are re-exported for the route's zod enums, so the
// mock must provide them verbatim.
vi.mock("@/services/daemon-execution.service", () => ({
  ACTIVE_EXECUTION_STATUSES: ["running", "queued"],
  EXECUTION_ENTITY_TYPES: ["task", "idea", "proposal", "document"],
  reconcileSnapshot: (...args: unknown[]) => mockReconcileSnapshot(...args),
  publishExecutionChange: (...args: unknown[]) => mockPublishExecutionChange(...args),
  connectionBelongsToAgent: (...args: unknown[]) => mockConnectionBelongsToAgent(...args),
  connectionVisibleToCaller: (...args: unknown[]) => mockConnectionVisibleToCaller(...args),
  getExecutionsForConnection: (...args: unknown[]) => mockGetExecutionsForConnection(...args),
  filterValidExecutionEntities: (...args: unknown[]) => mockFilterValidExecutionEntities(...args),
}));

import { POST, GET } from "@/app/api/daemon/execution-state/route";

// ===== Helpers =====
const companyUuid = "company-0000-0000-0000-000000000001";
const agentUuid = "agent-0000-0000-0000-000000000001";
const ownerUuid = "owner-0000-0000-0000-000000000001";
const connectionUuid = "conn-0000-0000-0000-000000000001";
const t1 = "task-0000-0000-0000-000000000001";

const agentAuth = { type: "agent", companyUuid, actorUuid: agentUuid, permissions: [] };
const userAuth = { type: "user", companyUuid, actorUuid: ownerUuid };

const emptyCtx = { params: Promise.resolve({}) };

function postRequest(body: unknown): NextRequest {
  return new NextRequest(new URL("http://localhost:3000/api/daemon/execution-state"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function getRequest(query = ""): NextRequest {
  const url = `http://localhost:3000/api/daemon/execution-state${query ? `?${query}` : ""}`;
  return new NextRequest(new URL(url));
}

const validEntry = {
  entityType: "task",
  entityUuid: t1,
  rootIdeaUuid: null,
  status: "running",
  startedAt: "2026-06-15T03:00:00.000Z",
};
const validBody = { connectionUuid, executions: [validEntry] };

beforeEach(() => {
  vi.clearAllMocks();
  mockGetAuthContext.mockResolvedValue(agentAuth);
  mockConnectionBelongsToAgent.mockResolvedValue(true);
  mockConnectionVisibleToCaller.mockResolvedValue(true);
  // Default: the best-effort filter keeps whatever it was given (entries valid).
  mockFilterValidExecutionEntities.mockImplementation(async (_c: unknown, execs: unknown) => execs);
  mockReconcileSnapshot.mockResolvedValue(1);
  mockPublishExecutionChange.mockResolvedValue(undefined);
  mockGetExecutionsForConnection.mockResolvedValue([]);
});

describe("POST /api/daemon/execution-state", () => {
  it("returns 401 and reconciles nothing when unauthenticated", async () => {
    mockGetAuthContext.mockResolvedValue(null);

    const res = await POST(postRequest(validBody), emptyCtx);

    expect(res.status).toBe(401);
    expect(mockConnectionBelongsToAgent).not.toHaveBeenCalled();
    expect(mockReconcileSnapshot).not.toHaveBeenCalled();
    expect(mockPublishExecutionChange).not.toHaveBeenCalled();
  });

  it("accepts a snapshot for the agent's own connection: reconciles, publishes, standard envelope", async () => {
    mockReconcileSnapshot.mockResolvedValue(3);

    const res = await POST(postRequest(validBody), emptyCtx);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ success: true, data: { reconciled: 3 }, meta: undefined });

    // Ownership fence consulted with the authenticated company/agent.
    expect(mockConnectionBelongsToAgent).toHaveBeenCalledWith(companyUuid, agentUuid, connectionUuid);

    // reconcileSnapshot stamped with authenticated company/agent (NOT from body).
    expect(mockReconcileSnapshot).toHaveBeenCalledTimes(1);
    const [c, a, conn, execs] = mockReconcileSnapshot.mock.calls[0];
    expect(c).toBe(companyUuid);
    expect(a).toBe(agentUuid);
    expect(conn).toBe(connectionUuid);
    expect(execs).toHaveLength(1);
    expect(execs[0].entityType).toBe("task");
    expect(execs[0].entityUuid).toBe(t1);
    // startedAt was coerced from the ISO string to a Date by the zod schema.
    expect(execs[0].startedAt).toBeInstanceOf(Date);

    // Event published after a successful reconcile.
    expect(mockPublishExecutionChange).toHaveBeenCalledTimes(1);
    expect(mockPublishExecutionChange).toHaveBeenCalledWith(companyUuid, connectionUuid);
  });

  it("foreign connection → 404 not-found, no rows reconciled, no event published", async () => {
    mockConnectionBelongsToAgent.mockResolvedValue(false);

    const res = await POST(postRequest(validBody), emptyCtx);
    const body = await res.json();

    // 404 (not 403) — does not reveal the connection exists.
    expect(res.status).toBe(404);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe("NOT_FOUND");
    // The negative path touches no execution rows and publishes nothing.
    expect(mockFilterValidExecutionEntities).not.toHaveBeenCalled();
    expect(mockReconcileSnapshot).not.toHaveBeenCalled();
    expect(mockPublishExecutionChange).not.toHaveBeenCalled();
  });

  it("event is published on a successful change (publish called exactly once after reconcile)", async () => {
    await POST(postRequest(validBody), emptyCtx);

    // reconcile precedes publish (publish reads the post-reconcile active set).
    const reconcileOrder = mockReconcileSnapshot.mock.invocationCallOrder[0];
    const publishOrder = mockPublishExecutionChange.mock.invocationCallOrder[0];
    expect(reconcileOrder).toBeLessThan(publishOrder);
    expect(mockPublishExecutionChange).toHaveBeenCalledWith(companyUuid, connectionUuid);
  });

  it("best-effort: a dead/unknown entity is DROPPED by the filter, the rest still reconcile (no 400)", async () => {
    // The filter drops the dead reference and returns only the surviving entries;
    // the route reconciles whatever the filter kept rather than rejecting the
    // whole snapshot — so one deleted resource can't wedge the connection.
    const kept = [{ entityType: "task", entityUuid: t1, rootIdeaUuid: null, status: "running" }];
    mockFilterValidExecutionEntities.mockResolvedValue(kept);

    const res = await POST(postRequest(validBody), emptyCtx);

    expect(res.status).toBe(200);
    // reconcile receives the FILTERED list, not the raw body.
    const [, , , execs] = mockReconcileSnapshot.mock.calls[0];
    expect(execs).toEqual(kept);
    expect(mockPublishExecutionChange).toHaveBeenCalledTimes(1);
  });

  it("an all-dead snapshot filters to [] and still reconciles (ends prior rows for those entities)", async () => {
    mockFilterValidExecutionEntities.mockResolvedValue([]);
    mockReconcileSnapshot.mockResolvedValue(1);
    const res = await POST(postRequest(validBody), emptyCtx);
    expect(res.status).toBe(200);
    expect(mockReconcileSnapshot).toHaveBeenCalledWith(companyUuid, agentUuid, connectionUuid, []);
  });

  it("rejects a malformed body (missing connectionUuid) with a validation error", async () => {
    const res = await POST(postRequest({ executions: [] }), emptyCtx);
    expect(res.status).toBe(422);
    expect(mockConnectionBelongsToAgent).not.toHaveBeenCalled();
  });

  it("rejects a body whose status is the server-only 'ended' value", async () => {
    const res = await POST(
      postRequest({ connectionUuid, executions: [{ entityType: "task", entityUuid: t1, status: "ended" }] }),
      emptyCtx,
    );
    expect(res.status).toBe(422);
    expect(mockReconcileSnapshot).not.toHaveBeenCalled();
  });

  it("rejects a body whose entityType is outside the recognized set", async () => {
    const res = await POST(
      postRequest({ connectionUuid, executions: [{ entityType: "comment", entityUuid: t1, status: "running" }] }),
      emptyCtx,
    );
    expect(res.status).toBe(422);
    expect(mockReconcileSnapshot).not.toHaveBeenCalled();
  });

  it("accepts an empty snapshot (ends all active rows) — connection still fenced", async () => {
    mockReconcileSnapshot.mockResolvedValue(2);
    const res = await POST(postRequest({ connectionUuid, executions: [] }), emptyCtx);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data.reconciled).toBe(2);
    expect(mockReconcileSnapshot).toHaveBeenCalledWith(companyUuid, agentUuid, connectionUuid, []);
    expect(mockPublishExecutionChange).toHaveBeenCalledTimes(1);
  });
});

describe("GET /api/daemon/execution-state (first-paint read)", () => {
  it("returns 401 when unauthenticated", async () => {
    mockGetAuthContext.mockResolvedValue(null);
    const res = await GET(getRequest(`connectionUuid=${connectionUuid}`), emptyCtx);
    expect(res.status).toBe(401);
    expect(mockGetExecutionsForConnection).not.toHaveBeenCalled();
  });

  it("400 when connectionUuid is missing", async () => {
    const res = await GET(getRequest(), emptyCtx);
    expect(res.status).toBe(400);
    expect(mockConnectionVisibleToCaller).not.toHaveBeenCalled();
  });

  it("returns the connection's active execution set, owner/self scoped", async () => {
    const rows = [{ uuid: "exec-1", entityType: "task", entityUuid: t1, status: "running" }];
    mockGetExecutionsForConnection.mockResolvedValue(rows);

    const res = await GET(getRequest(`connectionUuid=${connectionUuid}`), emptyCtx);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ success: true, data: { executions: rows }, meta: undefined });
    expect(mockConnectionVisibleToCaller).toHaveBeenCalledWith(agentAuth, connectionUuid);
    expect(mockGetExecutionsForConnection).toHaveBeenCalledWith(companyUuid, connectionUuid);
  });

  it("a connection not visible to the caller → 404 (not 403), no read performed", async () => {
    mockConnectionVisibleToCaller.mockResolvedValue(false);
    const res = await GET(getRequest(`connectionUuid=${connectionUuid}`), emptyCtx);
    const body = await res.json();
    expect(res.status).toBe(404);
    expect(body.error.code).toBe("NOT_FOUND");
    expect(mockGetExecutionsForConnection).not.toHaveBeenCalled();
  });

  it("a USER caller is passed through to the visibility fence (owner scope)", async () => {
    mockGetAuthContext.mockResolvedValue(userAuth);
    await GET(getRequest(`connectionUuid=${connectionUuid}`), emptyCtx);
    expect(mockConnectionVisibleToCaller).toHaveBeenCalledWith(userAuth, connectionUuid);
  });
});
