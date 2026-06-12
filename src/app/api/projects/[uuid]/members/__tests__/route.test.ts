import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// Mock dependencies
const mockListProjectMembers = vi.fn();
const mockAddProjectMember = vi.fn();
const mockRemoveProjectMember = vi.fn();
const mockGetAuthContext = vi.fn();
const mockCanAccessProject = vi.fn();
const mockClaimOrCanManageProject = vi.fn();

vi.mock("@/services/project.service", () => ({
  listProjectMembers: (...args: unknown[]) => mockListProjectMembers(...args),
  addProjectMember: (...args: unknown[]) => mockAddProjectMember(...args),
  removeProjectMember: (...args: unknown[]) => mockRemoveProjectMember(...args),
}));

vi.mock("@/lib/authz/project-access", () => ({
  canAccessProject: (...args: unknown[]) => mockCanAccessProject(...args),
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

import { GET, POST, DELETE } from "@/app/api/projects/[uuid]/members/route";

const companyUuid = "company-0000-0000-0000-000000000001";
const projectUuid = "project-0000-0000-0000-000000000001";
const ownerAuth = { type: "user", companyUuid, actorUuid: "owner-uuid-1" };
const memberAuth = { type: "user", companyUuid, actorUuid: "member-uuid-2" };

function makeRequest(
  url: string,
  init?: ConstructorParameters<typeof NextRequest>[1]
): NextRequest {
  return new NextRequest(new URL(url, "http://localhost:3000"), init);
}

function makeContext(uuid: string) {
  return { params: Promise.resolve({ uuid }) };
}

describe("GET /api/projects/[uuid]/members", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAuthContext.mockResolvedValue(ownerAuth);
    mockCanAccessProject.mockResolvedValue(true);
    mockListProjectMembers.mockResolvedValue([]);
  });

  it("lists members for a member who can access the project", async () => {
    const members = [
      { uuid: "m1", memberType: "user", memberUuid: "owner-uuid-1", role: "owner", createdAt: "x" },
    ];
    mockGetAuthContext.mockResolvedValue(memberAuth);
    mockListProjectMembers.mockResolvedValue(members);

    const res = await GET(makeRequest(`/api/projects/${projectUuid}/members`), makeContext(projectUuid));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.members).toEqual(members);
  });

  it("returns 401 when not authenticated", async () => {
    mockGetAuthContext.mockResolvedValue(null);
    const res = await GET(makeRequest(`/api/projects/${projectUuid}/members`), makeContext(projectUuid));
    expect(res.status).toBe(401);
  });

  it("returns 404 (not 403) for an inaccessible project — no existence leak", async () => {
    mockCanAccessProject.mockResolvedValue(false);
    const res = await GET(makeRequest(`/api/projects/${projectUuid}/members`), makeContext(projectUuid));
    expect(res.status).toBe(404);
  });
});

describe("POST /api/projects/[uuid]/members", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAuthContext.mockResolvedValue(ownerAuth);
    mockCanAccessProject.mockResolvedValue(true);
    mockClaimOrCanManageProject.mockResolvedValue(true);
    mockAddProjectMember.mockResolvedValue({
      uuid: "m2",
      memberType: "user",
      memberUuid: "new-user",
      role: "member",
      createdAt: "x",
    });
  });

  it("owner can add a member", async () => {
    const res = await POST(
      makeRequest(`/api/projects/${projectUuid}/members`, {
        method: "POST",
        body: JSON.stringify({ memberType: "user", memberUuid: "new-user" }),
      }),
      makeContext(projectUuid)
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(mockAddProjectMember).toHaveBeenCalledWith(companyUuid, projectUuid, "user", "new-user");
  });

  it("non-owner member gets 403", async () => {
    mockGetAuthContext.mockResolvedValue(memberAuth);
    mockClaimOrCanManageProject.mockResolvedValue(false);

    const res = await POST(
      makeRequest(`/api/projects/${projectUuid}/members`, {
        method: "POST",
        body: JSON.stringify({ memberType: "user", memberUuid: "new-user" }),
      }),
      makeContext(projectUuid)
    );

    expect(res.status).toBe(403);
    expect(mockAddProjectMember).not.toHaveBeenCalled();
  });

  it("returns 404 for an inaccessible project before checking management", async () => {
    mockCanAccessProject.mockResolvedValue(false);

    const res = await POST(
      makeRequest(`/api/projects/${projectUuid}/members`, {
        method: "POST",
        body: JSON.stringify({ memberType: "user", memberUuid: "new-user" }),
      }),
      makeContext(projectUuid)
    );

    expect(res.status).toBe(404);
    expect(mockClaimOrCanManageProject).not.toHaveBeenCalled();
  });

  it("returns 422 for invalid memberType", async () => {
    const res = await POST(
      makeRequest(`/api/projects/${projectUuid}/members`, {
        method: "POST",
        body: JSON.stringify({ memberType: "bogus", memberUuid: "new-user" }),
      }),
      makeContext(projectUuid)
    );

    expect(res.status).toBe(422);
  });

  it("returns 422 for missing memberUuid", async () => {
    const res = await POST(
      makeRequest(`/api/projects/${projectUuid}/members`, {
        method: "POST",
        body: JSON.stringify({ memberType: "agent" }),
      }),
      makeContext(projectUuid)
    );

    expect(res.status).toBe(422);
  });
});

describe("DELETE /api/projects/[uuid]/members", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAuthContext.mockResolvedValue(ownerAuth);
    mockCanAccessProject.mockResolvedValue(true);
    mockClaimOrCanManageProject.mockResolvedValue(true);
    mockRemoveProjectMember.mockResolvedValue(true);
  });

  it("owner can remove a member via query params", async () => {
    const res = await DELETE(
      makeRequest(
        `/api/projects/${projectUuid}/members?memberType=user&memberUuid=victim`,
        { method: "DELETE" }
      ),
      makeContext(projectUuid)
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(mockRemoveProjectMember).toHaveBeenCalledWith(companyUuid, projectUuid, "user", "victim");
  });

  it("non-owner member gets 403", async () => {
    mockGetAuthContext.mockResolvedValue(memberAuth);
    mockClaimOrCanManageProject.mockResolvedValue(false);

    const res = await DELETE(
      makeRequest(
        `/api/projects/${projectUuid}/members?memberType=user&memberUuid=victim`,
        { method: "DELETE" }
      ),
      makeContext(projectUuid)
    );

    expect(res.status).toBe(403);
    expect(mockRemoveProjectMember).not.toHaveBeenCalled();
  });

  it("returns 404 for an inaccessible project", async () => {
    mockCanAccessProject.mockResolvedValue(false);

    const res = await DELETE(
      makeRequest(
        `/api/projects/${projectUuid}/members?memberType=user&memberUuid=victim`,
        { method: "DELETE" }
      ),
      makeContext(projectUuid)
    );

    expect(res.status).toBe(404);
  });

  it("returns 404 when the member does not exist", async () => {
    mockRemoveProjectMember.mockResolvedValue(false);

    const res = await DELETE(
      makeRequest(
        `/api/projects/${projectUuid}/members?memberType=user&memberUuid=ghost`,
        { method: "DELETE" }
      ),
      makeContext(projectUuid)
    );

    expect(res.status).toBe(404);
  });
});
