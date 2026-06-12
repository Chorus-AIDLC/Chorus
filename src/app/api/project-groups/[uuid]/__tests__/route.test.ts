import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// Mock dependencies
const mockGetProjectGroup = vi.fn();
const mockUpdateProjectGroup = vi.fn();
const mockDeleteProjectGroup = vi.fn();
const mockSetGroupVisibility = vi.fn();
const mockGetAuthContext = vi.fn();
const mockCanAccessGroup = vi.fn();
const mockClaimOrCanManageGroup = vi.fn();

vi.mock("@/services/project-group.service", () => ({
  getProjectGroup: (...args: unknown[]) => mockGetProjectGroup(...args),
  updateProjectGroup: (...args: unknown[]) => mockUpdateProjectGroup(...args),
  deleteProjectGroup: (...args: unknown[]) => mockDeleteProjectGroup(...args),
  setGroupVisibility: (...args: unknown[]) => mockSetGroupVisibility(...args),
}));

vi.mock("@/lib/authz/project-access", () => ({
  canAccessGroup: (...args: unknown[]) => mockCanAccessGroup(...args),
  claimOrCanManageGroup: (...args: unknown[]) => mockClaimOrCanManageGroup(...args),
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

import { GET, PATCH, DELETE } from "@/app/api/project-groups/[uuid]/route";

const companyUuid = "company-0000-0000-0000-000000000001";
const groupUuid = "group-0000-0000-0000-000000000001";
const ownerAuth = { type: "user", companyUuid, actorUuid: "owner-uuid-1" };
const memberAuth = { type: "user", companyUuid, actorUuid: "member-uuid-2" };

const groupRecord = {
  uuid: groupUuid,
  name: "Group",
  description: null,
  visibility: "private",
  ownerType: "user",
  ownerUuid: "owner-uuid-1",
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

describe("GET /api/project-groups/[uuid] — visibility leak rule", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAuthContext.mockResolvedValue(memberAuth);
  });

  it("returns 404 (not 403) when group is inaccessible — no existence leak", async () => {
    mockGetProjectGroup.mockResolvedValue(null);
    const res = await GET(makeRequest(`/api/project-groups/${groupUuid}`), makeContext(groupUuid));
    expect(res.status).toBe(404);
  });

  it("returns group when accessible", async () => {
    mockGetProjectGroup.mockResolvedValue(groupRecord);
    const res = await GET(makeRequest(`/api/project-groups/${groupUuid}`), makeContext(groupUuid));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data.uuid).toBe(groupUuid);
  });
});

describe("PATCH /api/project-groups/[uuid] — manage gating", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAuthContext.mockResolvedValue(ownerAuth);
    mockCanAccessGroup.mockResolvedValue(true);
    mockClaimOrCanManageGroup.mockResolvedValue(true);
    mockSetGroupVisibility.mockResolvedValue({ uuid: groupUuid, visibility: "shared" });
    mockUpdateProjectGroup.mockResolvedValue(groupRecord);
  });

  it("owner can change visibility", async () => {
    const res = await PATCH(
      makeRequest(`/api/project-groups/${groupUuid}`, {
        method: "PATCH",
        body: JSON.stringify({ visibility: "shared" }),
      }),
      makeContext(groupUuid)
    );
    expect(res.status).toBe(200);
    expect(mockSetGroupVisibility).toHaveBeenCalledWith(companyUuid, groupUuid, "shared");
  });

  it("non-owner member gets 403 when updating", async () => {
    mockGetAuthContext.mockResolvedValue(memberAuth);
    mockClaimOrCanManageGroup.mockResolvedValue(false);

    const res = await PATCH(
      makeRequest(`/api/project-groups/${groupUuid}`, {
        method: "PATCH",
        body: JSON.stringify({ name: "Renamed" }),
      }),
      makeContext(groupUuid)
    );
    expect(res.status).toBe(403);
    expect(mockUpdateProjectGroup).not.toHaveBeenCalled();
  });

  it("returns 404 when group is inaccessible (no leak) before manage check", async () => {
    mockCanAccessGroup.mockResolvedValue(false);
    const res = await PATCH(
      makeRequest(`/api/project-groups/${groupUuid}`, {
        method: "PATCH",
        body: JSON.stringify({ name: "Renamed" }),
      }),
      makeContext(groupUuid)
    );
    expect(res.status).toBe(404);
    expect(mockClaimOrCanManageGroup).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/project-groups/[uuid] — manage gating (newly gated)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetAuthContext.mockResolvedValue(ownerAuth);
    mockCanAccessGroup.mockResolvedValue(true);
    mockClaimOrCanManageGroup.mockResolvedValue(true);
    mockDeleteProjectGroup.mockResolvedValue(true);
  });

  it("owner (or claimer) can delete the group", async () => {
    const res = await DELETE(
      makeRequest(`/api/project-groups/${groupUuid}`, { method: "DELETE" }),
      makeContext(groupUuid)
    );
    expect(res.status).toBe(200);
    expect(mockDeleteProjectGroup).toHaveBeenCalledWith(companyUuid, groupUuid, false);
  });

  it("non-member of a private group gets 404 (no existence leak) before manage check", async () => {
    mockGetAuthContext.mockResolvedValue(memberAuth);
    mockCanAccessGroup.mockResolvedValue(false);

    const res = await DELETE(
      makeRequest(`/api/project-groups/${groupUuid}`, { method: "DELETE" }),
      makeContext(groupUuid)
    );
    expect(res.status).toBe(404);
    expect(mockClaimOrCanManageGroup).not.toHaveBeenCalled();
    expect(mockDeleteProjectGroup).not.toHaveBeenCalled();
  });

  it("accessible non-owner gets 403", async () => {
    mockGetAuthContext.mockResolvedValue(memberAuth);
    mockClaimOrCanManageGroup.mockResolvedValue(false);

    const res = await DELETE(
      makeRequest(`/api/project-groups/${groupUuid}`, { method: "DELETE" }),
      makeContext(groupUuid)
    );
    expect(res.status).toBe(403);
    expect(mockDeleteProjectGroup).not.toHaveBeenCalled();
  });

  it("returns 404 when the group does not exist (service returns false)", async () => {
    mockDeleteProjectGroup.mockResolvedValue(false);
    const res = await DELETE(
      makeRequest(`/api/project-groups/${groupUuid}`, { method: "DELETE" }),
      makeContext(groupUuid)
    );
    expect(res.status).toBe(404);
  });
});
