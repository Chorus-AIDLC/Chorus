import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ===== Mocks =====
const mockGetAuthContext = vi.fn();
const mockHasPermission = vi.fn();
const mockResolveConnectionOwner = vi.fn();
const mockDispatchControl = vi.fn();
const mockIsConnectionLive = vi.fn();
const mockHasRunningExecution = vi.fn();
const mockAdvanceTurnForWake = vi.fn();
const mockResolveControlSessionId = vi.fn();

vi.mock("@/lib/auth", () => ({
  getAuthContext: (...args: unknown[]) => mockGetAuthContext(...args),
  hasPermission: (...args: unknown[]) => mockHasPermission(...args),
}));

// The two server-side predicates behind the phantom-turn settle gate, plus the shared
// turn-advance chokepoint the settle goes through. Mocked so the route's gate logic is the
// unit under test (the predicates keep their own service tests).
vi.mock("@/services/daemon-execution.service", () => ({
  isConnectionLive: (...args: unknown[]) => mockIsConnectionLive(...args),
  hasRunningExecution: (...args: unknown[]) => mockHasRunningExecution(...args),
}));

vi.mock("@/services/daemon-session.service", () => ({
  advanceTurnForWake: (...args: unknown[]) => mockAdvanceTurnForWake(...args),
  resolveControlSessionId: (...args: unknown[]) => mockResolveControlSessionId(...args),
}));

// Silence the route's settle logging. `createRequestLogger` must stay provided — the shared
// withErrorHandler wrapper calls it on every request.
vi.mock("@/lib/logger", () => {
  const stub = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return {
    default: stub,
    createRequestLogger: () => ({ ...stub, child: () => stub }),
  };
});

// Mock the control service: the route is the unit under test. CONTROL_ENTITY_TYPES feeds
// the route's zod enum for the entity-bearing commands, so the mock must provide it
// verbatim. (CONTROL_COMMANDS is no longer imported by the route — the discriminated zod
// body hard-codes the per-command literals.)
vi.mock("@/services/daemon-control.service", () => ({
  CONTROL_ENTITY_TYPES: ["task", "idea", "proposal", "document", "daemon_session"],
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
  // Default: a healthy live run (online connection + a `running` execution row) so the
  // settle gate is CLOSED — the pre-existing envelope/authz expectations below are about
  // dispatch only and must stay byte-identical apart from `settled: false`.
  mockIsConnectionLive.mockResolvedValue(true);
  mockHasRunningExecution.mockResolvedValue(true);
  mockAdvanceTurnForWake.mockResolvedValue({ ok: true, turn: { uuid: "turn-1" } });
  // Default: the entity key resolves to itself (the modern idea-anchored / ad-hoc shape).
  mockResolveControlSessionId.mockImplementation(async (p: { entityUuid: string }) => ({
    sessionId: p.entityUuid,
    ambiguous: false,
  }));
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
    expect(body).toEqual({
      success: true,
      // `settled` is false here: the connection is online AND has a live `running`
      // execution row, so the daemon keeps sole authority over the outcome.
      data: { dispatched: true, settled: false },
      meta: undefined,
    });

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

// ===== Phantom-turn convergence (fix-phantom-running-turn C3) =====
//
// The endpoint always dispatches. On top of that, for `interrupt` ONLY, it settles the
// session's `running` turn as `interrupted(user)` exactly when the server's own state shows
// no live run can act on the command: the connection is not effectively online, OR it
// reports no `running` execution for the entity (the zombie-SSE case). The four-way matrix
// below pins that gate, plus resume-never-settles and the "settle failure cannot fail the
// dispatch" contract.
const ideaUuid = "idea-0000-0000-0000-000000000001";
const interruptIdeaBody = {
  command: "interrupt",
  targetConnectionUuid: connectionUuid,
  entityType: "idea",
  entityUuid: ideaUuid,
};

describe("POST /api/daemon/control — settles a phantom running turn", () => {
  it("OFFLINE connection ⇒ settles interrupted/user and reports settled: true", async () => {
    mockIsConnectionLive.mockResolvedValue(false);

    const res = await POST(postRequest(interruptIdeaBody), emptyCtx);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toEqual({ dispatched: true, settled: true });
    // The control event is still published unconditionally.
    expect(mockDispatchControl).toHaveBeenCalledTimes(1);
    expect(mockAdvanceTurnForWake).toHaveBeenCalledTimes(1);
    expect(mockAdvanceTurnForWake).toHaveBeenCalledWith({
      companyUuid,
      agentUuid,
      connectionUuid,
      // `sessionId = entityUuid` — an identity for `idea` / `daemon_session` only.
      sessionId: ideaUuid,
      status: "interrupted",
      interruptedReason: "user",
      entityType: "idea",
      entityUuid: ideaUuid,
    });
  });

  it("ONLINE connection WITH a running execution row ⇒ does not settle (daemon owns it)", async () => {
    mockIsConnectionLive.mockResolvedValue(true);
    mockHasRunningExecution.mockResolvedValue(true);

    const res = await POST(postRequest(interruptIdeaBody), emptyCtx);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toEqual({ dispatched: true, settled: false });
    expect(mockDispatchControl).toHaveBeenCalledTimes(1);
    expect(mockAdvanceTurnForWake).not.toHaveBeenCalled();
    expect(mockHasRunningExecution).toHaveBeenCalledWith(
      companyUuid,
      connectionUuid,
      "idea",
      ideaUuid,
    );
  });

  it("ONLINE connection with NO running execution row (zombie SSE) ⇒ settles", async () => {
    // The reverse channel is silently dead while REST heartbeats keep `lastSeenAt` fresh,
    // so liveness alone reads as online. The execution snapshot is the direct evidence.
    mockIsConnectionLive.mockResolvedValue(true);
    mockHasRunningExecution.mockResolvedValue(false);

    const res = await POST(postRequest(interruptIdeaBody), emptyCtx);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toEqual({ dispatched: true, settled: true });
    expect(mockAdvanceTurnForWake).toHaveBeenCalledTimes(1);
    expect(mockAdvanceTurnForWake).toHaveBeenCalledWith(
      expect.objectContaining({ status: "interrupted", interruptedReason: "user" }),
    );
  });

  it("no running turn to settle ⇒ still succeeds, reports settled: false", async () => {
    mockIsConnectionLive.mockResolvedValue(false);
    mockAdvanceTurnForWake.mockResolvedValue({ ok: false, reason: "not_found" });

    const res = await POST(postRequest(interruptIdeaBody), emptyCtx);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toEqual({ dispatched: true, settled: false });
    expect(mockAdvanceTurnForWake).toHaveBeenCalledTimes(1);
  });

  it("an ad-hoc daemon_session interrupt settles on its own session business key", async () => {
    mockIsConnectionLive.mockResolvedValue(false);
    const sessionId = "sess-abc";

    const res = await POST(
      postRequest({
        command: "interrupt",
        targetConnectionUuid: connectionUuid,
        entityType: "daemon_session",
        entityUuid: sessionId,
      }),
      emptyCtx,
    );

    expect(res.status).toBe(200);
    expect(mockAdvanceTurnForWake).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId, entityType: "daemon_session" }),
    );
  });

  it("a failed settle NEVER fails the dispatch (reported as settled: false)", async () => {
    mockIsConnectionLive.mockResolvedValue(false);
    mockAdvanceTurnForWake.mockRejectedValue(new Error("db down"));

    const res = await POST(postRequest(interruptIdeaBody), emptyCtx);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toEqual({ dispatched: true, settled: false });
    expect(mockDispatchControl).toHaveBeenCalledTimes(1);
  });

  it("a THROWING gate query never fails the dispatch either (reported as settled: false)", async () => {
    // The control event is published BEFORE the gate is evaluated, so a transient failure
    // while deciding whether to settle must degrade to `settled: false`, not a 500 that
    // hides the fact that the interrupt was already dispatched.
    mockIsConnectionLive.mockRejectedValue(new Error("db down"));

    const res = await POST(postRequest(interruptIdeaBody), emptyCtx);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toEqual({ dispatched: true, settled: false });
    expect(mockDispatchControl).toHaveBeenCalledTimes(1);
    expect(mockAdvanceTurnForWake).not.toHaveBeenCalled();
  });

  it("settles the session the resolver picks, NOT the raw entityUuid (legacy `::` session)", async () => {
    mockIsConnectionLive.mockResolvedValue(false);
    const legacyKey = `${interruptIdeaBody.entityUuid}::${connectionUuid}`;
    mockResolveControlSessionId.mockResolvedValue({ sessionId: legacyKey, ambiguous: false });

    const res = await POST(postRequest(interruptIdeaBody), emptyCtx);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toEqual({ dispatched: true, settled: true });
    expect(mockAdvanceTurnForWake).toHaveBeenCalledWith(
      expect.objectContaining({ sessionId: legacyKey, interruptedReason: "user" }),
    );
  });

  it("settles NOTHING when the session cannot be resolved", async () => {
    mockIsConnectionLive.mockResolvedValue(false);
    mockResolveControlSessionId.mockResolvedValue({ sessionId: null, ambiguous: false });

    const res = await POST(postRequest(interruptIdeaBody), emptyCtx);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toEqual({ dispatched: true, settled: false });
    expect(mockAdvanceTurnForWake).not.toHaveBeenCalled();
    expect(mockDispatchControl).toHaveBeenCalledTimes(1);
  });

  it("settles NOTHING when two candidate sessions are ambiguous (never guesses)", async () => {
    mockIsConnectionLive.mockResolvedValue(false);
    mockResolveControlSessionId.mockResolvedValue({ sessionId: null, ambiguous: true });

    const res = await POST(postRequest(interruptIdeaBody), emptyCtx);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toEqual({ dispatched: true, settled: false });
    expect(mockAdvanceTurnForWake).not.toHaveBeenCalled();
  });

  it("RESUME never settles — offline", async () => {
    mockIsConnectionLive.mockResolvedValue(false);

    const res = await POST(
      postRequest({ ...interruptIdeaBody, command: "resume" }),
      emptyCtx,
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toEqual({ dispatched: true, settled: false });
    expect(mockAdvanceTurnForWake).not.toHaveBeenCalled();
    // The gate is not even evaluated for a non-interrupt command.
    expect(mockIsConnectionLive).not.toHaveBeenCalled();
  });

  it("RESUME never settles — online", async () => {
    mockIsConnectionLive.mockResolvedValue(true);
    mockHasRunningExecution.mockResolvedValue(false);

    const res = await POST(
      postRequest({ ...interruptIdeaBody, command: "resume" }),
      emptyCtx,
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data).toEqual({ dispatched: true, settled: false });
    expect(mockAdvanceTurnForWake).not.toHaveBeenCalled();
  });

  it("an unauthorized caller settles nothing (403 before the gate)", async () => {
    mockGetAuthContext.mockResolvedValue(strangerUserAuth);
    mockIsConnectionLive.mockResolvedValue(false);

    const res = await POST(postRequest(interruptIdeaBody), emptyCtx);

    expect(res.status).toBe(403);
    expect(mockAdvanceTurnForWake).not.toHaveBeenCalled();
    expect(mockDispatchControl).not.toHaveBeenCalled();
  });
});
