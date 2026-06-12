import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// Mock dependencies
const mockListGroupMembers = vi.fn();
const mockAddGroupMember = vi.fn();
const mockRemoveGroupMember = vi.fn();
const mockGetAuthContext = vi.fn();
const mockCanAccessGroup = vi.fn();
const mockCanManageGroup = vi.fn();

vi.mock("@/services/project-group.service", () => ({
  listGroupMembers: (...args: unknown[]) => mockListGroupMembers(...args),
  addGroupMember: (...args: unknown[]) => mockAddGroupMember(...args),
  removeGroupMember: (...args: unknown[]) => mockRemoveGroupMember(...args),
}));

vi.mock("@/lib/authz/project-access", () => ({
  canAccessGroup: (...args: unknown[]) => mockCanAccessGroup(...args),
  canManageGroup: (...args: unknown[]) => mockCanManageGroup(...args),
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

import { GET, POST, DELETE } from "@/app/api/project-groups/[uuid]/members/route";

const companyUuid = "company-0000-0000-0000-000000000001";
const groupUuid = "group-0000-0000-0000-000000000001";
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

describe("GET /api/project-groups/[uuid]/members", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAuthContext.mockResolvedValue(ownerAuth);
    mockCanAccessGroup.mockResolvedValue(true);
    mockListGroupMembers.mockResolvedValue([]);
  });

  it("lists members for a member who can access the group", async () => {
    const members = [
      { uuid: "m1", memberType: "user", memberUuid: "owner-uuid-1", role: "owner", createdAt: "x" },
    ];
    mockGetAuthContext.mockResolvedValue(memberAuth);
    mockListGroupMembers.mockResolvedValue(members);

    const res = await GET(makeRequest(`/api/project-groups/${groupUuid}/members`), makeContext(groupUuid));
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.members).toEqual(members);
  });

  it("returns 401 when not authenticated", async () => {
    mockGetAuthContext.mockResolvedValue(null);
    const res = await GET(makeRequest(`/api/project-groups/${groupUuid}/members`), makeContext(groupUuid));
    expect(res.status).toBe(401);
  });

  it("returns 404 (not 403) for an inaccessible group — no existence leak", async () => {
    mockCanAccessGroup.mockResolvedValue(false);
    const res = await GET(makeRequest(`/api/project-groups/${groupUuid}/members`), makeContext(groupUuid));
    expect(res.status).toBe(404);
  });
});

describe("POST /api/project-groups/[uuid]/members", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAuthContext.mockResolvedValue(ownerAuth);
    mockCanAccessGroup.mockResolvedValue(true);
    mockCanManageGroup.mockResolvedValue(true);
    mockAddGroupMember.mockResolvedValue({
      uuid: "m2",
      memberType: "user",
      memberUuid: "new-user",
      role: "member",
      createdAt: "x",
    });
  });

  it("owner can add a member", async () => {
    const res = await POST(
      makeRequest(`/api/project-groups/${groupUuid}/members`, {
        method: "POST",
        body: JSON.stringify({ memberType: "user", memberUuid: "new-user" }),
      }),
      makeContext(groupUuid)
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(mockAddGroupMember).toHaveBeenCalledWith(companyUuid, groupUuid, "user", "new-user");
  });

  it("non-owner member gets 403", async () => {
    mockGetAuthContext.mockResolvedValue(memberAuth);
    mockCanManageGroup.mockResolvedValue(false);

    const res = await POST(
      makeRequest(`/api/project-groups/${groupUuid}/members`, {
        method: "POST",
        body: JSON.stringify({ memberType: "user", memberUuid: "new-user" }),
      }),
      makeContext(groupUuid)
    );

    expect(res.status).toBe(403);
    expect(mockAddGroupMember).not.toHaveBeenCalled();
  });

  it("returns 404 for an inaccessible group before checking management", async () => {
    mockCanAccessGroup.mockResolvedValue(false);

    const res = await POST(
      makeRequest(`/api/project-groups/${groupUuid}/members`, {
        method: "POST",
        body: JSON.stringify({ memberType: "user", memberUuid: "new-user" }),
      }),
      makeContext(groupUuid)
    );

    expect(res.status).toBe(404);
    expect(mockCanManageGroup).not.toHaveBeenCalled();
  });

  it("returns 422 for invalid memberType", async () => {
    const res = await POST(
      makeRequest(`/api/project-groups/${groupUuid}/members`, {
        method: "POST",
        body: JSON.stringify({ memberType: "bogus", memberUuid: "new-user" }),
      }),
      makeContext(groupUuid)
    );

    expect(res.status).toBe(422);
  });

  it("returns 422 for missing memberUuid", async () => {
    const res = await POST(
      makeRequest(`/api/project-groups/${groupUuid}/members`, {
        method: "POST",
        body: JSON.stringify({ memberType: "agent" }),
      }),
      makeContext(groupUuid)
    );

    expect(res.status).toBe(422);
  });
});

describe("DELETE /api/project-groups/[uuid]/members", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAuthContext.mockResolvedValue(ownerAuth);
    mockCanAccessGroup.mockResolvedValue(true);
    mockCanManageGroup.mockResolvedValue(true);
    mockRemoveGroupMember.mockResolvedValue(true);
  });

  it("owner can remove a member via query params", async () => {
    const res = await DELETE(
      makeRequest(
        `/api/project-groups/${groupUuid}/members?memberType=user&memberUuid=victim`,
        { method: "DELETE" }
      ),
      makeContext(groupUuid)
    );
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.success).toBe(true);
    expect(mockRemoveGroupMember).toHaveBeenCalledWith(companyUuid, groupUuid, "user", "victim");
  });

  it("non-owner member gets 403", async () => {
    mockGetAuthContext.mockResolvedValue(memberAuth);
    mockCanManageGroup.mockResolvedValue(false);

    const res = await DELETE(
      makeRequest(
        `/api/project-groups/${groupUuid}/members?memberType=user&memberUuid=victim`,
        { method: "DELETE" }
      ),
      makeContext(groupUuid)
    );

    expect(res.status).toBe(403);
    expect(mockRemoveGroupMember).not.toHaveBeenCalled();
  });

  it("returns 404 for an inaccessible group before checking management", async () => {
    mockCanAccessGroup.mockResolvedValue(false);

    const res = await DELETE(
      makeRequest(
        `/api/project-groups/${groupUuid}/members?memberType=user&memberUuid=victim`,
        { method: "DELETE" }
      ),
      makeContext(groupUuid)
    );

    expect(res.status).toBe(404);
    expect(mockCanManageGroup).not.toHaveBeenCalled();
  });

  it("returns 404 when the member does not exist", async () => {
    mockRemoveGroupMember.mockResolvedValue(false);

    const res = await DELETE(
      makeRequest(
        `/api/project-groups/${groupUuid}/members?memberType=user&memberUuid=ghost`,
        { method: "DELETE" }
      ),
      makeContext(groupUuid)
    );

    expect(res.status).toBe(404);
  });
});
