import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// ===== Mocks =====
const mockGetAuthContext = vi.fn();
const mockGetSidebarQuickAccess = vi.fn();
const mockRecordVisit = vi.fn();
const mockPinProject = vi.fn();
const mockUnpinProject = vi.fn();

vi.mock("@/lib/auth", async () => {
  const actual = await vi.importActual<typeof import("@/lib/auth")>("@/lib/auth");
  return {
    ...actual,
    getAuthContext: (...args: unknown[]) => mockGetAuthContext(...args),
  };
});

vi.mock("@/services/project-visit.service", () => ({
  getSidebarQuickAccess: (...args: unknown[]) => mockGetSidebarQuickAccess(...args),
  recordVisit: (...args: unknown[]) => mockRecordVisit(...args),
  pinProject: (...args: unknown[]) => mockPinProject(...args),
  unpinProject: (...args: unknown[]) => mockUnpinProject(...args),
}));

import { GET } from "@/app/api/project-visits/route";
import { POST } from "@/app/api/project-visits/visit/route";
import { PUT, DELETE } from "@/app/api/project-visits/pin/route";

// ===== Helpers =====
const companyUuid = "company-0000-0000-0000-000000000001";
const userUuid = "user-0000-0000-0000-000000000001";
const agentUuid = "agent-0000-0000-0000-000000000001";
const projectUuid = "project-0000-0000-0000-000000000001";

const userAuth = { type: "user", companyUuid, actorUuid: userUuid };
const agentAuth = {
  type: "agent",
  companyUuid,
  actorUuid: agentUuid,
  roles: ["developer_agent"],
  permissions: ["project:read", "project:write"],
};

const aggregate = {
  pinned: [{ uuid: projectUuid, name: "Proj", groupUuid: null, groupName: null }],
  recent: [],
};

const emptyCtx = { params: Promise.resolve({}) };

function req(method: string, path: string, body?: unknown): NextRequest {
  return new NextRequest(new URL(`http://localhost:3000${path}`), {
    method,
    ...(body !== undefined
      ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } }
      : {}),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetAuthContext.mockResolvedValue(userAuth);
  mockGetSidebarQuickAccess.mockResolvedValue(aggregate);
  mockRecordVisit.mockResolvedValue(undefined);
  mockPinProject.mockResolvedValue(undefined);
  mockUnpinProject.mockResolvedValue(undefined);
});

describe("GET /api/project-visits", () => {
  it("returns { success, data:{ pinned, recent } } scoped by company + actor", async () => {
    const res = await GET(req("GET", "/api/project-visits"), emptyCtx);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data).toEqual(aggregate);
    expect(mockGetSidebarQuickAccess).toHaveBeenCalledWith(companyUuid, userUuid);
  });

  it("401 when unauthenticated; no service call", async () => {
    mockGetAuthContext.mockResolvedValue(null);
    const res = await GET(req("GET", "/api/project-visits"), emptyCtx);
    expect(res.status).toBe(401);
    expect(mockGetSidebarQuickAccess).not.toHaveBeenCalled();
  });

  it("403 for an agent API key (human-only surface); no service call", async () => {
    mockGetAuthContext.mockResolvedValue(agentAuth);
    const res = await GET(req("GET", "/api/project-visits"), emptyCtx);
    const body = await res.json();
    expect(res.status).toBe(403);
    expect(body.error.code).toBe("FORBIDDEN");
    expect(mockGetSidebarQuickAccess).not.toHaveBeenCalled();
  });

  it("403 for super_admin (no user context)", async () => {
    mockGetAuthContext.mockResolvedValue({ type: "super_admin", companyUuid, actorUuid: "sa" });
    const res = await GET(req("GET", "/api/project-visits"), emptyCtx);
    expect(res.status).toBe(403);
    expect(mockGetSidebarQuickAccess).not.toHaveBeenCalled();
  });
});

describe("POST /api/project-visits/visit", () => {
  it("records a visit and returns { ok: true }", async () => {
    const res = await POST(req("POST", "/api/project-visits/visit", { projectUuid }), emptyCtx);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data).toEqual({ ok: true });
    expect(mockRecordVisit).toHaveBeenCalledWith(companyUuid, userUuid, projectUuid);
  });

  it("401 when unauthenticated; no service call", async () => {
    mockGetAuthContext.mockResolvedValue(null);
    const res = await POST(req("POST", "/api/project-visits/visit", { projectUuid }), emptyCtx);
    expect(res.status).toBe(401);
    expect(mockRecordVisit).not.toHaveBeenCalled();
  });

  it("403 for an agent API key; no service call", async () => {
    mockGetAuthContext.mockResolvedValue(agentAuth);
    const res = await POST(req("POST", "/api/project-visits/visit", { projectUuid }), emptyCtx);
    expect(res.status).toBe(403);
    expect(mockRecordVisit).not.toHaveBeenCalled();
  });

  it("422 when projectUuid is missing; no service call", async () => {
    const res = await POST(req("POST", "/api/project-visits/visit", {}), emptyCtx);
    const body = await res.json();
    expect(res.status).toBe(422);
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(mockRecordVisit).not.toHaveBeenCalled();
  });

  it("422 when projectUuid is blank; no service call", async () => {
    const res = await POST(req("POST", "/api/project-visits/visit", { projectUuid: "  " }), emptyCtx);
    expect(res.status).toBe(422);
    expect(mockRecordVisit).not.toHaveBeenCalled();
  });
});

describe("PUT /api/project-visits/pin", () => {
  it("pins and returns the fresh aggregate", async () => {
    const res = await PUT(req("PUT", "/api/project-visits/pin", { projectUuid }), emptyCtx);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data).toEqual(aggregate);
    expect(mockPinProject).toHaveBeenCalledWith(companyUuid, userUuid, projectUuid);
    expect(mockGetSidebarQuickAccess).toHaveBeenCalledWith(companyUuid, userUuid);
  });

  it("401 when unauthenticated; no pin", async () => {
    mockGetAuthContext.mockResolvedValue(null);
    const res = await PUT(req("PUT", "/api/project-visits/pin", { projectUuid }), emptyCtx);
    expect(res.status).toBe(401);
    expect(mockPinProject).not.toHaveBeenCalled();
  });

  it("403 for an agent API key; no pin", async () => {
    mockGetAuthContext.mockResolvedValue(agentAuth);
    const res = await PUT(req("PUT", "/api/project-visits/pin", { projectUuid }), emptyCtx);
    expect(res.status).toBe(403);
    expect(mockPinProject).not.toHaveBeenCalled();
  });

  it("422 when projectUuid is missing; no pin", async () => {
    const res = await PUT(req("PUT", "/api/project-visits/pin", {}), emptyCtx);
    expect(res.status).toBe(422);
    expect(mockPinProject).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/project-visits/pin", () => {
  it("unpins and returns the fresh aggregate", async () => {
    const res = await DELETE(req("DELETE", "/api/project-visits/pin", { projectUuid }), emptyCtx);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data).toEqual(aggregate);
    expect(mockUnpinProject).toHaveBeenCalledWith(companyUuid, userUuid, projectUuid);
    expect(mockGetSidebarQuickAccess).toHaveBeenCalledWith(companyUuid, userUuid);
  });

  it("401 when unauthenticated; no unpin", async () => {
    mockGetAuthContext.mockResolvedValue(null);
    const res = await DELETE(req("DELETE", "/api/project-visits/pin", { projectUuid }), emptyCtx);
    expect(res.status).toBe(401);
    expect(mockUnpinProject).not.toHaveBeenCalled();
  });

  it("403 for an agent API key; no unpin", async () => {
    mockGetAuthContext.mockResolvedValue(agentAuth);
    const res = await DELETE(req("DELETE", "/api/project-visits/pin", { projectUuid }), emptyCtx);
    expect(res.status).toBe(403);
    expect(mockUnpinProject).not.toHaveBeenCalled();
  });

  it("422 when projectUuid is missing; no unpin", async () => {
    const res = await DELETE(req("DELETE", "/api/project-visits/pin", {}), emptyCtx);
    expect(res.status).toBe(422);
    expect(mockUnpinProject).not.toHaveBeenCalled();
  });
});
