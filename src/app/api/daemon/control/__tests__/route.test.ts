import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ===== Mocks =====
const mockGetAuthContext = vi.fn();
const mockHasPermission = vi.fn();
const mockResolveConnectionOwner = vi.fn();
const mockDispatchControl = vi.fn();

vi.mock("@/lib/auth", () => ({
  getAuthContext: (...args: unknown[]) => mockGetAuthContext(...args),
  hasPermission: (...args: unknown[]) => mockHasPermission(...args),
}));

// Mock the control service: the route is the unit under test. CONTROL_ENTITY_TYPES feeds
// the route's zod enum for the entity-bearing commands, so the mock must provide it
// verbatim. (CONTROL_COMMANDS is no longer imported by the route — the discriminated zod
// body hard-codes the per-command literals.)
vi.mock("@/services/daemon-control.service", () => ({
  CONTROL_ENTITY_TYPES: ["task", "idea", "proposal", "document"],
  resolveConnectionOwner: (...args: unknown[]) => mockResolveConnectionOwner(...args),
  dispatchControl: (...args: unknown[]) => mockDispatchControl(...args),
}));

import { POST } from "@/app/api/daemon/control/route";

// ===== Helpers =====
const companyUuid = "company-0000-0000-0000-000000000001";
const agentUuid = "agent-0000-0000-0000-000000000001";
const ownerUuid = "owner-0000-0000-0000-000000000001";
const otherUserUuid = "user-0000-0000-0000-00000000ffff";
const connectionUuid = "conn-0000-0000-0000-000000000001";
const t1 = "task-0000-0000-0000-000000000001";

// The agent that OWNS the target connection — its human owner is ownerUuid.
const targetOwner = { agentUuid, ownerUuid };

// Auth contexts. The owner USER caller (actorUuid === connection agent's ownerUuid).
const ownerUserAuth = { type: "user", companyUuid, actorUuid: ownerUuid };
// A user who is NOT the owner and (being a user) carries no permission set.
const strangerUserAuth = { type: "user", companyUuid, actorUuid: otherUserUuid };
// An agent caller who is neither the owner nor task:admin.
const plainAgentAuth = { type: "agent", companyUuid, actorUuid: agentUuid, permissions: [] };
// An agent caller holding task:admin.
const adminAgentAuth = {
  type: "agent",
  companyUuid,
  actorUuid: "agent-other",
  permissions: ["task:admin"],
};
// A super_admin caller.
const superAdminAuth = { type: "super_admin", companyUuid, actorUuid: "sa" };

const emptyCtx = { params: Promise.resolve({}) };

const validBody = {
  command: "interrupt",
  targetConnectionUuid: connectionUuid,
  entityType: "task",
  entityUuid: t1,
};

function postRequest(body: unknown): NextRequest {
  return new NextRequest(new URL("http://localhost:3000/api/daemon/control"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetAuthContext.mockResolvedValue(ownerUserAuth);
  mockResolveConnectionOwner.mockResolvedValue(targetOwner);
  // hasPermission default: deny unless a test opts in. The route only calls it for
  // agent/super_admin callers.
  mockHasPermission.mockReturnValue(false);
});

describe("POST /api/daemon/control — auth + validation envelope", () => {
  it("returns 401 and publishes nothing when unauthenticated", async () => {
    mockGetAuthContext.mockResolvedValue(null);

    const res = await POST(postRequest(validBody), emptyCtx);

    expect(res.status).toBe(401);
    expect(mockResolveConnectionOwner).not.toHaveBeenCalled();
    expect(mockDispatchControl).not.toHaveBeenCalled();
  });

  it("rejects an unknown command with a validation error and publishes nothing", async () => {
    // `interrupt` and `resume` are the accepted verbs; anything else is rejected at
    // the zod boundary before any resolve/publish.
    const res = await POST(
      postRequest({ ...validBody, command: "pause" }),
      emptyCtx,
    );

    expect(res.status).toBe(422);
    // Rejected at the zod boundary — never resolves the connection or publishes.
    expect(mockResolveConnectionOwner).not.toHaveBeenCalled();
    expect(mockDispatchControl).not.toHaveBeenCalled();
  });

  it("rejects a malformed body (missing targetConnectionUuid) with a validation error", async () => {
    const { targetConnectionUuid: _omit, ...rest } = validBody;
    void _omit;
    const res = await POST(postRequest(rest), emptyCtx);

    expect(res.status).toBe(422);
    expect(mockDispatchControl).not.toHaveBeenCalled();
  });

  it("rejects an entityType outside the recognized set", async () => {
    const res = await POST(
      postRequest({ ...validBody, entityType: "comment" }),
      emptyCtx,
    );
    expect(res.status).toBe(422);
    expect(mockDispatchControl).not.toHaveBeenCalled();
  });

  it("rejects invalid JSON with a 400 bad request", async () => {
    const req = new NextRequest(new URL("http://localhost:3000/api/daemon/control"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{ not json",
    });
    const res = await POST(req, emptyCtx);
    expect(res.status).toBe(400);
    expect(mockDispatchControl).not.toHaveBeenCalled();
  });
});

describe("POST /api/daemon/control — authz matrix (q2=a)", () => {
  it("OWNER is allowed: publishes once via dispatchControl, standard success envelope", async () => {
    const res = await POST(postRequest(validBody), emptyCtx);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body).toEqual({ success: true, data: { dispatched: true }, meta: undefined });

    // Owner resolution was company-scoped to the authenticated company.
    expect(mockResolveConnectionOwner).toHaveBeenCalledWith(companyUuid, connectionUuid);

    // Exactly-once publish through the dispatch seam, with the authenticated
    // company + validated command/entity (never trusted from a different field).
    expect(mockDispatchControl).toHaveBeenCalledTimes(1);
    expect(mockDispatchControl).toHaveBeenCalledWith({
      companyUuid,
      targetConnectionUuid: connectionUuid,
      command: "interrupt",
      entityType: "task",
      entityUuid: t1,
    });
  });

  it("task:admin AGENT is allowed even when not the owner", async () => {
    mockGetAuthContext.mockResolvedValue(adminAgentAuth);
    mockHasPermission.mockReturnValue(true);

    const res = await POST(postRequest(validBody), emptyCtx);

    expect(res.status).toBe(200);
    expect(mockHasPermission).toHaveBeenCalledWith(adminAgentAuth, "task:admin");
    expect(mockDispatchControl).toHaveBeenCalledTimes(1);
  });

  it("super_admin is allowed (passes hasPermission)", async () => {
    mockGetAuthContext.mockResolvedValue(superAdminAuth);
    mockHasPermission.mockReturnValue(true);

    const res = await POST(postRequest(validBody), emptyCtx);

    expect(res.status).toBe(200);
    expect(mockDispatchControl).toHaveBeenCalledTimes(1);
  });

  it("non-owner USER without task:admin → 403, nothing published", async () => {
    mockGetAuthContext.mockResolvedValue(strangerUserAuth);

    const res = await POST(postRequest(validBody), emptyCtx);
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.error.code).toBe("FORBIDDEN");
    // A user caller never even consults hasPermission (users carry no perms).
    expect(mockHasPermission).not.toHaveBeenCalled();
    expect(mockDispatchControl).not.toHaveBeenCalled();
  });

  it("plain AGENT (not owner, no task:admin) → 403, nothing published", async () => {
    mockGetAuthContext.mockResolvedValue(plainAgentAuth);
    mockHasPermission.mockReturnValue(false);

    const res = await POST(postRequest(validBody), emptyCtx);

    expect(res.status).toBe(403);
    expect(mockDispatchControl).not.toHaveBeenCalled();
  });

  it("cross-company / absent connection → 404 non-disclosure, nothing published", async () => {
    // resolveConnectionOwner returns null for a connection absent within the
    // caller's company — the route must 404 (not 403) so it never confirms
    // another company's / owner's connection exists.
    mockResolveConnectionOwner.mockResolvedValue(null);

    const res = await POST(postRequest(validBody), emptyCtx);
    const body = await res.json();

    expect(res.status).toBe(404);
    expect(body.error.code).toBe("NOT_FOUND");
    expect(mockDispatchControl).not.toHaveBeenCalled();
  });

  it("owner check fails when the connection's agent is unowned (ownerUuid=null) and caller lacks task:admin → 403", async () => {
    // An unowned/system agent: no owner can match. A user caller can never be
    // authorized (no perms); only task:admin would pass.
    mockResolveConnectionOwner.mockResolvedValue({ agentUuid, ownerUuid: null });
    mockGetAuthContext.mockResolvedValue(strangerUserAuth);

    const res = await POST(postRequest(validBody), emptyCtx);

    expect(res.status).toBe(403);
    expect(mockDispatchControl).not.toHaveBeenCalled();
  });
});

// The deliver_turn body (子2 — origin-only live delivery): connection-only, NO entity.
const deliverTurnBody = {
  command: "deliver_turn",
  targetConnectionUuid: connectionUuid,
};

describe("POST /api/daemon/control — deliver_turn is NOT a public verb (子2, service-internal)", () => {
  it("rejects a bare deliver_turn POST at the schema boundary (422, nothing published)", async () => {
    const res = await POST(postRequest(deliverTurnBody), emptyCtx);
    const body = await res.json();

    // deliver_turn is now SERVICE-INTERNAL: the send path emits it directly via
    // dispatchControl with the precise turnUuid it just created; an external HTTP caller
    // has no turnUuid to supply, so the public endpoint no longer accepts the verb — it is
    // rejected at the schema boundary (422), nothing published.
    expect(res.status).toBe(422);
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(mockDispatchControl).not.toHaveBeenCalled();
  });

  it("rejects deliver_turn even WITH entityType/entityUuid (still not a public verb — 422)", async () => {
    const res = await POST(
      postRequest({ ...deliverTurnBody, entityType: "task", entityUuid: t1 }),
      emptyCtx,
    );
    // Even with entity fields it is not a public verb — rejected at the boundary.
    expect(res.status).toBe(422);
    expect(mockDispatchControl).not.toHaveBeenCalled();
  });

  it("rejects deliver_turn even WITH a turnUuid (still not a public verb — 422, nothing published)", async () => {
    const res = await POST(
      postRequest({ ...deliverTurnBody, turnUuid: "turn-0000-0000-0000-00000000dead" }),
      emptyCtx,
    );
    expect(res.status).toBe(422);
    expect(mockDispatchControl).not.toHaveBeenCalled();
  });

  it("entity-bearing commands STILL require entityType/entityUuid (interrupt missing entity → 422)", async () => {
    const res = await POST(
      postRequest({ command: "interrupt", targetConnectionUuid: connectionUuid }),
      emptyCtx,
    );
    expect(res.status).toBe(422);
    expect(mockDispatchControl).not.toHaveBeenCalled();
  });
});
