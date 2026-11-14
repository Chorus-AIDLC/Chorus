import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const mockGetAuthContext = vi.fn();
vi.mock("@/lib/auth", () => ({ getAuthContext: (...a: unknown[]) => mockGetAuthContext(...a) }));
const svc = vi.hoisted(() => {
  class CliSessionNotFoundError extends Error {}
  class CliLeaseConflictError extends Error {}
  class CliInvalidIdeaError extends Error {}
  return {
    CliSessionNotFoundError, CliLeaseConflictError, CliInvalidIdeaError,
    registerCliSession: vi.fn(), heartbeatCliSession: vi.fn(), releaseCliSession: vi.fn(),
  };
});
vi.mock("@/services/daemon-cli-session.service", () => svc);

import { POST as register } from "@/app/api/daemon-sessions/cli/route";
import { POST as heartbeat } from "@/app/api/daemon-sessions/cli/[sessionUuid]/heartbeat/route";
import { POST as release } from "@/app/api/daemon-sessions/cli/[sessionUuid]/release/route";

const agentAuth = { type: "agent", companyUuid: "company-1", actorUuid: "agent-1" };
const ctx = { params: Promise.resolve({ sessionUuid: "s-1" }) };
const emptyCtx = { params: Promise.resolve({}) };
const req = (body: unknown) => new NextRequest("http://localhost/api/daemon-sessions/cli", {
  method: "POST", body: typeof body === "string" ? body : JSON.stringify(body),
});

beforeEach(() => {
  vi.clearAllMocks();
  mockGetAuthContext.mockResolvedValue(agentAuth);
});

describe("POST /api/daemon-sessions/cli", () => {
  const body = { agentType: "claude_code", host: "box", cwd: "/repo" };
  it("registers and returns the service payload", async () => {
    svc.registerCliSession.mockResolvedValueOnce({ sessionUuid: "s-1", sessionId: "sid", leaseTtlSec: 60 });
    const res = await register(req({ ...body, ideaUuid: "i-1", continuable: false }), emptyCtx);
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ sessionUuid: "s-1", sessionId: "sid", leaseTtlSec: 60 });
    expect(svc.registerCliSession).toHaveBeenCalledWith(agentAuth, { ...body, ideaUuid: "i-1", continuable: false });
  });
  it("401 for a non-agent caller, 400 bad JSON, 422 schema, 400 invalid idea, rethrows others", async () => {
    mockGetAuthContext.mockResolvedValueOnce({ type: "user", companyUuid: "c", actorUuid: "u" });
    expect((await register(req(body), emptyCtx)).status).toBe(401);
    expect((await register(req("{"), emptyCtx)).status).toBe(400);
    expect((await register(req({ host: "box" }), emptyCtx)).status).toBe(422);
    svc.registerCliSession.mockRejectedValueOnce(new svc.CliInvalidIdeaError("bad idea"));
    expect((await register(req(body), emptyCtx)).status).toBe(400);
    svc.registerCliSession.mockRejectedValueOnce(new Error("boom"));
    expect((await register(req(body), emptyCtx)).status).toBe(500);
  });
});

describe.each([
  ["heartbeat", heartbeat, svc.heartbeatCliSession, { leaseHolder: "h", backendSessionId: "b" }],
  ["release", release, svc.releaseCliSession, { leaseHolder: "h", continuable: true, reason: "exit" }],
] as const)("POST /api/daemon-sessions/cli/:uuid/%s", (_name, handler, fn, body) => {
  it("calls the service with the session uuid", async () => {
    fn.mockResolvedValueOnce({ ok: 1 });
    const res = await handler(req(body), ctx);
    expect(res.status).toBe(200);
    expect(fn).toHaveBeenCalledWith(agentAuth, "s-1", body);
  });
  it("maps 401 / 400 / 422 / 404 / 409 / 500", async () => {
    mockGetAuthContext.mockResolvedValueOnce(null);
    expect((await handler(req(body), ctx)).status).toBe(401);
    expect((await handler(req("{"), ctx)).status).toBe(400);
    expect((await handler(req({}), ctx)).status).toBe(422);
    fn.mockRejectedValueOnce(new svc.CliSessionNotFoundError());
    expect((await handler(req(body), ctx)).status).toBe(404);
    fn.mockRejectedValueOnce(new svc.CliLeaseConflictError("stale"));
    expect((await handler(req(body), ctx)).status).toBe(409);
    fn.mockRejectedValueOnce(new Error("boom"));
    expect((await handler(req(body), ctx)).status).toBe(500);
  });
});
