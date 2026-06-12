import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// Mock dependencies
const mockGetProject = vi.fn();
const mockUpdateProject = vi.fn();
const mockDeleteProject = vi.fn();
const mockSetProjectVisibility = vi.fn();
const mockGetAuthContext = vi.fn();
const mockClaimOrCanManageProject = vi.fn();

vi.mock("@/services/project.service", () => ({
  getProject: (...args: unknown[]) => mockGetProject(...args),
  updateProject: (...args: unknown[]) => mockUpdateProject(...args),
  deleteProject: (...args: unknown[]) => mockDeleteProject(...args),
  setProjectVisibility: (...args: unknown[]) => mockSetProjectVisibility(...args),
}));

vi.mock("@/lib/authz/project-access", () => ({
  claimOrCanManageProject: (...args: unknown[]) => mockClaimOrCanManageProject(...args),
}));

vi.mock("@/lib/auth", () => ({
  getAuthContext: (...args: unknown[]) => mockGetAuthContext(...args),
  isUser: (auth: { type: string }) => auth.type === "user",
  isAgent: (auth: { type: string }) => auth.type === "agent",
  hasPermission: (auth: { permissions?: string[] }, perm: string) =>
    auth.permissions?.includes(perm) ?? false,
  checkAgentPermission: (auth: { type: string; permissions?: string[] }, perm: string) => {
    if (auth.type === "agent" && !(auth.permissions?.includes(perm) ?? false)) {
      return new Response(
        JSON.stringify({ success: false, error: { message: `Missing permission: ${perm}` } }),
        { status: 403 }
      );
    }
    return null;
  },
}));

import { GET, PATCH, DELETE } from "@/app/api/projects/[uuid]/route";

const companyUuid = "company-0000-0000-0000-000000000001";
const projectUuid = "project-0000-0000-0000-000000000001";
const ownerAuth = { type: "user", companyUuid, actorUuid: "owner-uuid-1" };
const memberAuth = { type: "user", companyUuid, actorUuid: "member-uuid-2" };

const projectRecord = {
  uuid: projectUuid,
  name: "Proj",
  description: null,
  groupUuid: null,
  visibility: "private",
  ownerType: "user",
  ownerUuid: "owner-uuid-1",
  createdAt: new Date("2026-01-01T00:00:00Z"),
  updatedAt: new Date("2026-01-02T00:00:00Z"),
  _count: { ideas: 0, documents: 0, tasks: 0, proposals: 0, activities: 0 },
};

function makeRequest(
  url: string,
  init?: ConstructorParameters<typeof NextRequest>[1]
): NextRequest {
  return new NextRequest(new URL(url, "http://localhost:3000"), init);
}

function makeContext(uuid: string) {
  return { params: Promise.resolve({ uuid }) };
}

describe("GET /api/projects/[uuid] — visibility leak rule", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAuthContext.mockResolvedValue(memberAuth);
  });

  it("returns 404 (not 403) when project is inaccessible — no existence leak", async () => {
    mockGetProject.mockResolvedValue(null);
    const res = await GET(makeRequest(`/api/projects/${projectUuid}`), makeContext(projectUuid));
    expect(res.status).toBe(404);
  });

  it("returns project with visibility when accessible", async () => {
    mockGetProject.mockResolvedValue(projectRecord);
    const res = await GET(makeRequest(`/api/projects/${projectUuid}`), makeContext(projectUuid));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data.visibility).toBe("private");
  });
});

describe("PATCH /api/projects/[uuid] — manage gating", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAuthContext.mockResolvedValue(ownerAuth);
    mockGetProject.mockResolvedValue(projectRecord);
    mockClaimOrCanManageProject.mockResolvedValue(true);
    mockSetProjectVisibility.mockResolvedValue({ uuid: projectUuid, visibility: "shared" });
    mockUpdateProject.mockResolvedValue({
      uuid: projectUuid,
      name: "Renamed",
      description: null,
      createdAt: projectRecord.createdAt,
      updatedAt: projectRecord.updatedAt,
    });
  });

  it("owner can change visibility", async () => {
    const res = await PATCH(
      makeRequest(`/api/projects/${projectUuid}`, {
        method: "PATCH",
        body: JSON.stringify({ visibility: "shared" }),
      }),
      makeContext(projectUuid)
    );
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(mockSetProjectVisibility).toHaveBeenCalledWith(companyUuid, projectUuid, "shared");
    expect(body.data.visibility).toBe("shared");
  });

  it("non-owner member gets 403 when changing visibility", async () => {
    mockGetAuthContext.mockResolvedValue(memberAuth);
    mockClaimOrCanManageProject.mockResolvedValue(false);

    const res = await PATCH(
      makeRequest(`/api/projects/${projectUuid}`, {
        method: "PATCH",
        body: JSON.stringify({ visibility: "shared" }),
      }),
      makeContext(projectUuid)
    );
    expect(res.status).toBe(403);
    expect(mockSetProjectVisibility).not.toHaveBeenCalled();
  });

  it("returns 404 when project is inaccessible (no leak) before manage check", async () => {
    mockGetProject.mockResolvedValue(null);
    const res = await PATCH(
      makeRequest(`/api/projects/${projectUuid}`, {
        method: "PATCH",
        body: JSON.stringify({ visibility: "shared" }),
      }),
      makeContext(projectUuid)
    );
    expect(res.status).toBe(404);
    expect(mockClaimOrCanManageProject).not.toHaveBeenCalled();
  });

  it("rejects invalid visibility value with 422", async () => {
    const res = await PATCH(
      makeRequest(`/api/projects/${projectUuid}`, {
        method: "PATCH",
        body: JSON.stringify({ visibility: "bogus" }),
      }),
      makeContext(projectUuid)
    );
    expect(res.status).toBe(422);
  });
});

describe("DELETE /api/projects/[uuid] — manage gating", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAuthContext.mockResolvedValue(ownerAuth);
    mockGetProject.mockResolvedValue(projectRecord);
    mockClaimOrCanManageProject.mockResolvedValue(true);
    mockDeleteProject.mockResolvedValue(true);
  });

  it("owner can delete the project", async () => {
    const res = await DELETE(
      makeRequest(`/api/projects/${projectUuid}`, { method: "DELETE" }),
      makeContext(projectUuid)
    );
    expect(res.status).toBe(200);
    expect(mockDeleteProject).toHaveBeenCalledWith(companyUuid, projectUuid);
  });

  it("non-owner member gets 403", async () => {
    mockGetAuthContext.mockResolvedValue(memberAuth);
    mockClaimOrCanManageProject.mockResolvedValue(false);

    const res = await DELETE(
      makeRequest(`/api/projects/${projectUuid}`, { method: "DELETE" }),
      makeContext(projectUuid)
    );
    expect(res.status).toBe(403);
    expect(mockDeleteProject).not.toHaveBeenCalled();
  });

  it("returns 404 when project is inaccessible (no leak)", async () => {
    mockGetProject.mockResolvedValue(null);
    const res = await DELETE(
      makeRequest(`/api/projects/${projectUuid}`, { method: "DELETE" }),
      makeContext(projectUuid)
    );
    expect(res.status).toBe(404);
    expect(mockClaimOrCanManageProject).not.toHaveBeenCalled();
  });
});
