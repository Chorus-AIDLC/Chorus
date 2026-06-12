import { describe, it, expect, vi, beforeEach } from "vitest";

// ===== Prisma mock =====
const mockPrisma = vi.hoisted(() => ({
  project: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    updateMany: vi.fn(),
  },
  projectMember: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    upsert: vi.fn(),
  },
  projectGroup: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
    updateMany: vi.fn(),
  },
  projectGroupMember: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
    upsert: vi.fn(),
  },
}));
vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));

import {
  getAccessibleProjectUuids,
  canAccessProject,
  canManageProject,
  getAccessibleGroupUuids,
  canAccessGroup,
  canManageGroup,
  claimOrCanManageProject,
  claimOrCanManageGroup,
  canManageOrClaimableProject,
  canManageOrClaimableGroup,
  applyProjectFilter,
  ALL_PROJECTS,
} from "../project-access";
import type {
  AuthContext,
  SuperAdminAuthContext,
  AgentAuthContext,
} from "@/types/auth";

const COMPANY = "company-1";

const superAdmin: SuperAdminAuthContext = {
  type: "super_admin",
  email: "root@chorus.local",
};
const ownerUser: AuthContext = {
  type: "user",
  companyUuid: COMPANY,
  actorUuid: "user-owner",
};
const memberUser: AuthContext = {
  type: "user",
  companyUuid: COMPANY,
  actorUuid: "user-member",
};
const nonMemberUser: AuthContext = {
  type: "user",
  companyUuid: COMPANY,
  actorUuid: "user-stranger",
};
const memberAgent: AuthContext = {
  type: "agent",
  companyUuid: COMPANY,
  actorUuid: "agent-member",
};
// Agent that carries project:admin but is NOT a member — must still be denied.
const adminAgentNonMember: AgentAuthContext = {
  type: "agent",
  companyUuid: COMPANY,
  actorUuid: "agent-admin",
  roles: ["admin_agent"],
  permissions: ["project:read", "project:write", "project:admin"],
  agentName: "AdminBot",
  // A private project's UUID injected via default headers must NOT grant access.
  projectUuids: ["private-proj"],
};

beforeEach(() => {
  vi.clearAllMocks();
  // Safe defaults: no group ownership/membership unless a test sets otherwise,
  // so the project-union branch is a no-op for the existing project-level tests.
  mockPrisma.projectGroup.findMany.mockResolvedValue([]);
  mockPrisma.projectGroupMember.findMany.mockResolvedValue([]);
  mockPrisma.projectGroup.findFirst.mockResolvedValue(null);
  mockPrisma.projectGroupMember.findUnique.mockResolvedValue(null);
});

describe("getAccessibleProjectUuids", () => {
  it("returns ALL sentinel for super admin without querying", async () => {
    const result = await getAccessibleProjectUuids(superAdmin);
    expect(result).toBe(ALL_PROJECTS);
    expect(mockPrisma.project.findMany).not.toHaveBeenCalled();
  });

  it("unions shared/owned projects with memberships for a user", async () => {
    mockPrisma.project.findMany.mockResolvedValue([
      { uuid: "shared-1" },
      { uuid: "owned-1" },
    ]);
    mockPrisma.projectMember.findMany.mockResolvedValue([
      { projectUuid: "private-member" },
      { projectUuid: "shared-1" }, // duplicate is de-duped
    ]);

    const result = await getAccessibleProjectUuids(memberUser);
    expect(result).not.toBe(ALL_PROJECTS);
    expect(new Set(result as string[])).toEqual(
      new Set(["shared-1", "owned-1", "private-member"]),
    );
    // Scoped by company + actor + type.
    expect(mockPrisma.project.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ companyUuid: COMPANY }),
      }),
    );
    expect(mockPrisma.projectMember.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          companyUuid: COMPANY,
          memberType: "user",
          memberUuid: "user-member",
        },
        select: { projectUuid: true },
      }),
    );
  });
});

describe("canAccessProject", () => {
  it("super admin always true, no query", async () => {
    expect(await canAccessProject(superAdmin, "any")).toBe(true);
    expect(mockPrisma.project.findFirst).not.toHaveBeenCalled();
  });

  it("false for empty projectUuid", async () => {
    expect(await canAccessProject(ownerUser, "")).toBe(false);
  });

  it("false when project not found (or cross-company)", async () => {
    mockPrisma.project.findFirst.mockResolvedValue(null);
    expect(await canAccessProject(nonMemberUser, "missing")).toBe(false);
  });

  it("shared project: accessible to any company actor", async () => {
    mockPrisma.project.findFirst.mockResolvedValue({
      visibility: "shared",
      ownerType: null,
      ownerUuid: null,
    });
    expect(await canAccessProject(nonMemberUser, "shared-1")).toBe(true);
    expect(mockPrisma.projectMember.findUnique).not.toHaveBeenCalled();
  });

  it("private project: owner accesses without a membership row", async () => {
    mockPrisma.project.findFirst.mockResolvedValue({
      visibility: "private",
      ownerType: "user",
      ownerUuid: "user-owner",
    });
    expect(await canAccessProject(ownerUser, "private-proj")).toBe(true);
  });

  it("private project: member (user) accesses via membership row", async () => {
    mockPrisma.project.findFirst.mockResolvedValue({
      visibility: "private",
      ownerType: "user",
      ownerUuid: "user-owner",
    });
    mockPrisma.projectMember.findUnique.mockResolvedValue({ id: 1 });
    expect(await canAccessProject(memberUser, "private-proj")).toBe(true);
  });

  it("private project: member (agent) accesses via membership row", async () => {
    mockPrisma.project.findFirst.mockResolvedValue({
      visibility: "private",
      ownerType: "user",
      ownerUuid: "user-owner",
    });
    mockPrisma.projectMember.findUnique.mockResolvedValue({ id: 2 });
    expect(await canAccessProject(memberAgent, "private-proj")).toBe(true);
  });

  it("private project: non-member user denied", async () => {
    mockPrisma.project.findFirst.mockResolvedValue({
      visibility: "private",
      ownerType: "user",
      ownerUuid: "user-owner",
    });
    mockPrisma.projectMember.findUnique.mockResolvedValue(null);
    expect(await canAccessProject(nonMemberUser, "private-proj")).toBe(false);
  });

  it("private project: project:admin agent that is NOT a member is still denied (no permission bypass)", async () => {
    mockPrisma.project.findFirst.mockResolvedValue({
      visibility: "private",
      ownerType: "user",
      ownerUuid: "user-owner",
    });
    mockPrisma.projectMember.findUnique.mockResolvedValue(null);
    expect(await canAccessProject(adminAgentNonMember, "private-proj")).toBe(
      false,
    );
    // The projectUuids[] default header is ignored — access derives only from
    // visibility/ownership/membership.
    expect(mockPrisma.projectMember.findUnique).toHaveBeenCalled();
  });
});

describe("canManageProject", () => {
  it("super admin always true", async () => {
    expect(await canManageProject(superAdmin, "any")).toBe(true);
  });

  it("owner can manage", async () => {
    mockPrisma.project.findFirst.mockResolvedValue({
      ownerType: "user",
      ownerUuid: "user-owner",
    });
    expect(await canManageProject(ownerUser, "private-proj")).toBe(true);
  });

  it("plain member cannot manage", async () => {
    mockPrisma.project.findFirst.mockResolvedValue({
      ownerType: "user",
      ownerUuid: "user-owner",
    });
    expect(await canManageProject(memberUser, "private-proj")).toBe(false);
  });

  it("non-existent project cannot be managed", async () => {
    mockPrisma.project.findFirst.mockResolvedValue(null);
    expect(await canManageProject(ownerUser, "missing")).toBe(false);
  });
});

describe("applyProjectFilter", () => {
  it("returns where unchanged for ALL sentinel", () => {
    const where = { companyUuid: COMPANY };
    expect(applyProjectFilter(where, ALL_PROJECTS)).toBe(where);
  });

  it("adds projectUuid:{in:set} for a concrete set", () => {
    const where = { companyUuid: COMPANY };
    expect(applyProjectFilter(where, ["a", "b"])).toEqual({
      companyUuid: COMPANY,
      projectUuid: { in: ["a", "b"] },
    });
  });

  it("supports a custom project field (e.g. uuid on Project table)", () => {
    const where = { companyUuid: COMPANY };
    expect(applyProjectFilter(where, ["a"], "uuid")).toEqual({
      companyUuid: COMPANY,
      uuid: { in: ["a"] },
    });
  });

  it("empty accessible set yields an impossible-to-match in:[] (no leakage)", () => {
    expect(applyProjectFilter({ companyUuid: COMPANY }, [])).toEqual({
      companyUuid: COMPANY,
      projectUuid: { in: [] },
    });
  });
});

// ===========================================================================
// Two-level inheritance (ProjectGroup → Project, dynamic union)
// ===========================================================================

const groupMemberUser: AuthContext = {
  type: "user",
  companyUuid: COMPANY,
  actorUuid: "user-groupmember",
};

describe("canAccessProject — group inheritance", () => {
  it("a GROUP member accesses a PRIVATE project in that group (union)", async () => {
    // project: private, owned by someone else, no direct membership, belongs to group-1
    mockPrisma.project.findFirst.mockResolvedValue({
      visibility: "private",
      ownerType: "user",
      ownerUuid: "user-owner",
      groupUuid: "group-1",
    });
    mockPrisma.projectMember.findUnique.mockResolvedValue(null);
    // isGroupOwnerOrMember: not owner, but a member of group-1
    mockPrisma.projectGroup.findFirst.mockResolvedValue({ ownerType: "user", ownerUuid: "user-owner" });
    mockPrisma.projectGroupMember.findUnique.mockResolvedValue({ id: 1 });

    expect(await canAccessProject(groupMemberUser, "private-in-group")).toBe(true);
  });

  it("a GROUP owner accesses a private project in that group", async () => {
    mockPrisma.project.findFirst.mockResolvedValue({
      visibility: "private",
      ownerType: "user",
      ownerUuid: "someone-else",
      groupUuid: "group-1",
    });
    mockPrisma.projectMember.findUnique.mockResolvedValue(null);
    mockPrisma.projectGroup.findFirst.mockResolvedValue({ ownerType: "user", ownerUuid: "user-groupmember" });

    expect(await canAccessProject(groupMemberUser, "private-in-group")).toBe(true);
  });

  it("a NON-group-member is denied a private project in the group", async () => {
    mockPrisma.project.findFirst.mockResolvedValue({
      visibility: "private",
      ownerType: "user",
      ownerUuid: "user-owner",
      groupUuid: "group-1",
    });
    mockPrisma.projectMember.findUnique.mockResolvedValue(null);
    mockPrisma.projectGroup.findFirst.mockResolvedValue({ ownerType: "user", ownerUuid: "user-owner" });
    mockPrisma.projectGroupMember.findUnique.mockResolvedValue(null);

    expect(await canAccessProject(nonMemberUser, "private-in-group")).toBe(false);
  });

  it("INVARIANT: a SHARED project in a PRIVATE group is still company-wide (shared short-circuits)", async () => {
    mockPrisma.project.findFirst.mockResolvedValue({
      visibility: "shared",
      ownerType: "user",
      ownerUuid: "user-owner",
      groupUuid: "private-group",
    });
    // even a total stranger gets it; group membership never consulted
    expect(await canAccessProject(nonMemberUser, "shared-in-private-group")).toBe(true);
    expect(mockPrisma.projectGroupMember.findUnique).not.toHaveBeenCalled();
  });

  it("INVARIANT: a PRIVATE project in a SHARED group stays restricted (shared groups NOT in project-union)", async () => {
    // The project's group is shared, but isGroupOwnerOrMember is shared-agnostic:
    // a non-member/owner of the (shared) group must NOT inherit the private project.
    mockPrisma.project.findFirst.mockResolvedValue({
      visibility: "private",
      ownerType: "user",
      ownerUuid: "user-owner",
      groupUuid: "shared-group",
    });
    mockPrisma.projectMember.findUnique.mockResolvedValue(null);
    // The group is explicitly SHARED and owned by someone else; the stranger is
    // not its owner/member. Including visibility:"shared" here hardens the test:
    // it would FAIL if a regression made isGroupOwnerOrMember grant access just
    // because the group is shared.
    mockPrisma.projectGroup.findFirst.mockResolvedValue({ visibility: "shared", ownerType: "user", ownerUuid: "user-owner" });
    mockPrisma.projectGroupMember.findUnique.mockResolvedValue(null);

    expect(await canAccessProject(nonMemberUser, "private-in-shared-group")).toBe(false);
  });

  it("project:admin agent that is NOT a group member is still denied (no bypass)", async () => {
    mockPrisma.project.findFirst.mockResolvedValue({
      visibility: "private",
      ownerType: "user",
      ownerUuid: "user-owner",
      groupUuid: "group-1",
    });
    mockPrisma.projectMember.findUnique.mockResolvedValue(null);
    mockPrisma.projectGroup.findFirst.mockResolvedValue({ ownerType: "user", ownerUuid: "user-owner" });
    mockPrisma.projectGroupMember.findUnique.mockResolvedValue(null);

    expect(await canAccessProject(adminAgentNonMember, "private-in-group")).toBe(false);
  });
});

describe("getAccessibleProjectUuids — group union", () => {
  it("unions in projects of groups the actor owns/belongs to", async () => {
    // shared/owned direct projects
    mockPrisma.project.findMany
      .mockResolvedValueOnce([{ uuid: "shared-1" }]) // visible projects
      .mockResolvedValueOnce([{ uuid: "groupproj-1" }, { uuid: "groupproj-2" }]); // group projects
    mockPrisma.projectMember.findMany.mockResolvedValue([]);
    // owns group-1 (union group-set)
    mockPrisma.projectGroup.findMany.mockResolvedValue([{ uuid: "group-1" }]);
    mockPrisma.projectGroupMember.findMany.mockResolvedValue([]);

    const result = await getAccessibleProjectUuids(memberUser);
    expect(new Set(result as string[])).toEqual(
      new Set(["shared-1", "groupproj-1", "groupproj-2"]),
    );
  });

  it("does NOT query group projects when the actor owns/belongs to no groups", async () => {
    mockPrisma.project.findMany.mockResolvedValueOnce([{ uuid: "shared-1" }]);
    mockPrisma.projectMember.findMany.mockResolvedValue([]);
    mockPrisma.projectGroup.findMany.mockResolvedValue([]);
    mockPrisma.projectGroupMember.findMany.mockResolvedValue([]);

    const result = await getAccessibleProjectUuids(memberUser);
    expect(result).toEqual(["shared-1"]);
    // only the first project.findMany (visible projects); no second group-projects query
    expect(mockPrisma.project.findMany).toHaveBeenCalledTimes(1);
  });
});

describe("getAccessibleGroupUuids / canAccessGroup / canManageGroup", () => {
  it("super admin => ALL, no query", async () => {
    expect(await getAccessibleGroupUuids(superAdmin)).toBe(ALL_PROJECTS);
    expect(mockPrisma.projectGroup.findMany).not.toHaveBeenCalled();
  });

  it("getAccessibleGroupUuids includes shared ∪ owned ∪ member groups", async () => {
    mockPrisma.projectGroup.findMany.mockResolvedValue([{ uuid: "shared-g" }, { uuid: "owned-g" }]);
    mockPrisma.projectGroupMember.findMany.mockResolvedValue([{ projectGroupUuid: "member-g" }]);

    const result = await getAccessibleGroupUuids(memberUser);
    expect(new Set(result as string[])).toEqual(new Set(["shared-g", "owned-g", "member-g"]));
  });

  it("canAccessGroup: shared group accessible to anyone, no membership query", async () => {
    mockPrisma.projectGroup.findFirst.mockResolvedValue({ visibility: "shared", ownerType: null, ownerUuid: null });
    expect(await canAccessGroup(nonMemberUser, "shared-g")).toBe(true);
  });

  it("canAccessGroup: private group denied to non-member", async () => {
    mockPrisma.projectGroup.findFirst
      .mockResolvedValueOnce({ visibility: "private", ownerType: "user", ownerUuid: "user-owner" }) // canAccessGroup lookup
      .mockResolvedValueOnce({ ownerType: "user", ownerUuid: "user-owner" }); // isGroupOwnerOrMember lookup
    mockPrisma.projectGroupMember.findUnique.mockResolvedValue(null);
    expect(await canAccessGroup(nonMemberUser, "private-g")).toBe(false);
  });

  it("canManageGroup: owner yes, member no, super_admin yes", async () => {
    mockPrisma.projectGroup.findFirst.mockResolvedValue({ ownerType: "user", ownerUuid: "user-owner" });
    expect(await canManageGroup(ownerUser, "g")).toBe(true);
    expect(await canManageGroup(memberUser, "g")).toBe(false);
    expect(await canManageGroup(superAdmin, "g")).toBe(true);
  });
});

describe("group helpers — guard branches", () => {
  it("canAccessGroup: empty groupUuid => false", async () => {
    expect(await canAccessGroup(memberUser, "")).toBe(false);
  });
  it("canAccessGroup: group not found => false", async () => {
    mockPrisma.projectGroup.findFirst.mockResolvedValue(null);
    expect(await canAccessGroup(memberUser, "missing")).toBe(false);
  });
  it("canAccessGroup: private group, owner allowed", async () => {
    mockPrisma.projectGroup.findFirst.mockResolvedValue({ visibility: "private", ownerType: "user", ownerUuid: "user-owner" });
    expect(await canAccessGroup(ownerUser, "g")).toBe(true);
  });
  it("canAccessGroup: private group, member allowed via membership row", async () => {
    // first findFirst (canAccessGroup) + second (isGroupOwnerOrMember) both private/other-owner
    mockPrisma.projectGroup.findFirst.mockResolvedValue({ visibility: "private", ownerType: "user", ownerUuid: "user-owner" });
    mockPrisma.projectGroupMember.findUnique.mockResolvedValue({ id: 7 });
    expect(await canAccessGroup(memberUser, "g")).toBe(true);
  });
  it("canManageGroup: empty groupUuid => false", async () => {
    expect(await canManageGroup(memberUser, "")).toBe(false);
  });
  it("canManageGroup: group not found => false", async () => {
    mockPrisma.projectGroup.findFirst.mockResolvedValue(null);
    expect(await canManageGroup(ownerUser, "missing")).toBe(false);
  });
  it("getAccessibleGroupUuids: member-only group (not owned/shared) is included", async () => {
    mockPrisma.projectGroup.findMany.mockResolvedValue([]); // no shared/owned
    mockPrisma.projectGroupMember.findMany.mockResolvedValue([{ projectGroupUuid: "g-mem" }]);
    const result = await getAccessibleGroupUuids(memberUser);
    expect(result as string[]).toEqual(["g-mem"]);
  });
});

describe("canAccessProject — group fallthrough when group missing/unowned", () => {
  it("project in a group the actor neither owns nor belongs to => denied (isGroupOwnerOrMember group lookup null)", async () => {
    mockPrisma.project.findFirst.mockResolvedValue({
      visibility: "private", ownerType: "user", ownerUuid: "user-owner", groupUuid: "ghost-group",
    });
    mockPrisma.projectMember.findUnique.mockResolvedValue(null);
    mockPrisma.projectGroup.findFirst.mockResolvedValue(null); // group not found => isGroupOwnerOrMember false (line 84)
    expect(await canAccessProject(nonMemberUser, "p-ghost")).toBe(false);
  });
});

// ===========================================================================
// Claim-on-manage (access-gated)
// ===========================================================================
describe("claimOrCanManageProject", () => {
  it("super_admin => true, no claim", async () => {
    expect(await claimOrCanManageProject(superAdmin, "p")).toBe(true);
    expect(mockPrisma.project.updateMany).not.toHaveBeenCalled();
  });

  it("BLOCKER guard: non-member of a PRIVATE null-owner project => false, NO claim", async () => {
    // canAccessProject: private, owner null, no membership, no group → false
    mockPrisma.project.findFirst.mockResolvedValue({
      visibility: "private", ownerType: null, ownerUuid: null, groupUuid: null,
    });
    mockPrisma.projectMember.findUnique.mockResolvedValue(null);
    expect(await claimOrCanManageProject(nonMemberUser, "p-priv")).toBe(false);
    expect(mockPrisma.project.updateMany).not.toHaveBeenCalled();
  });

  it("accessible (shared) null-owner project => claims + seeds owner member + true", async () => {
    // 1st findFirst: canAccessProject (shared → accessible). 2nd: owner lookup (null).
    mockPrisma.project.findFirst
      .mockResolvedValueOnce({ visibility: "shared", ownerType: null, ownerUuid: null, groupUuid: null })
      .mockResolvedValueOnce({ ownerType: null, ownerUuid: null });
    mockPrisma.project.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.projectMember.upsert.mockResolvedValue({});

    expect(await claimOrCanManageProject(nonMemberUser, "p-shared")).toBe(true);
    expect(mockPrisma.project.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ ownerType: null, ownerUuid: null }),
        data: { ownerType: "user", ownerUuid: "user-stranger" },
      }),
    );
    expect(mockPrisma.projectMember.upsert).toHaveBeenCalled();
  });

  it("already-owned by someone else => false, never reassigns", async () => {
    mockPrisma.project.findFirst
      .mockResolvedValueOnce({ visibility: "shared", ownerType: null, ownerUuid: null, groupUuid: null }) // canAccess (shared)
      .mockResolvedValueOnce({ ownerType: "user", ownerUuid: "other" }); // owner lookup
    expect(await claimOrCanManageProject(nonMemberUser, "p-owned")).toBe(false);
    expect(mockPrisma.project.updateMany).not.toHaveBeenCalled();
  });

  it("already-owned by the actor => true, no claim", async () => {
    mockPrisma.project.findFirst
      .mockResolvedValueOnce({ visibility: "private", ownerType: "user", ownerUuid: "user-owner", groupUuid: null }) // canAccess (owner)
      .mockResolvedValueOnce({ ownerType: "user", ownerUuid: "user-owner" });
    expect(await claimOrCanManageProject(ownerUser, "p")).toBe(true);
    expect(mockPrisma.project.updateMany).not.toHaveBeenCalled();
  });

  it("lost race: updateMany 0 rows + re-read shows different owner => false", async () => {
    mockPrisma.project.findFirst
      .mockResolvedValueOnce({ visibility: "shared", ownerType: null, ownerUuid: null, groupUuid: null }) // canAccess
      .mockResolvedValueOnce({ ownerType: null, ownerUuid: null }) // owner lookup
      .mockResolvedValueOnce({ ownerType: "user", ownerUuid: "winner" }); // re-read after lost race
    mockPrisma.project.updateMany.mockResolvedValue({ count: 0 });
    expect(await claimOrCanManageProject(nonMemberUser, "p")).toBe(false);
  });
});

describe("claimOrCanManageGroup", () => {
  it("BLOCKER guard: non-member of a PRIVATE null-owner group => false, NO claim", async () => {
    // canAccessGroup: private, not owner, not member → false
    mockPrisma.projectGroup.findFirst.mockResolvedValue({ visibility: "private", ownerType: null, ownerUuid: null });
    mockPrisma.projectGroupMember.findUnique.mockResolvedValue(null);
    expect(await claimOrCanManageGroup(nonMemberUser, "g-priv")).toBe(false);
    expect(mockPrisma.projectGroup.updateMany).not.toHaveBeenCalled();
  });

  it("accessible (shared) null-owner group => claims + true", async () => {
    mockPrisma.projectGroup.findFirst
      .mockResolvedValueOnce({ visibility: "shared", ownerType: null, ownerUuid: null }) // canAccessGroup (shared)
      .mockResolvedValueOnce({ ownerType: null, ownerUuid: null }); // owner lookup
    mockPrisma.projectGroup.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.projectGroupMember.upsert.mockResolvedValue({});
    expect(await claimOrCanManageGroup(nonMemberUser, "g-shared")).toBe(true);
    expect(mockPrisma.projectGroup.updateMany).toHaveBeenCalled();
    expect(mockPrisma.projectGroupMember.upsert).toHaveBeenCalled();
  });
});

describe("canManageOrClaimable* (pure — no writes)", () => {
  it("project: claimable null-owner accessible => true, performs NO update", async () => {
    mockPrisma.project.findFirst
      .mockResolvedValueOnce({ ownerType: null, ownerUuid: null }) // predicate owner lookup
      .mockResolvedValueOnce({ visibility: "shared", ownerType: null, ownerUuid: null, groupUuid: null }); // canAccess
    expect(await canManageOrClaimableProject(nonMemberUser, "p")).toBe(true);
    expect(mockPrisma.project.updateMany).not.toHaveBeenCalled();
  });

  it("project: private null-owner inaccessible => false", async () => {
    mockPrisma.project.findFirst
      .mockResolvedValueOnce({ ownerType: null, ownerUuid: null }) // predicate
      .mockResolvedValueOnce({ visibility: "private", ownerType: null, ownerUuid: null, groupUuid: null }); // canAccess
    mockPrisma.projectMember.findUnique.mockResolvedValue(null);
    expect(await canManageOrClaimableProject(nonMemberUser, "p")).toBe(false);
    expect(mockPrisma.project.updateMany).not.toHaveBeenCalled();
  });

  it("group: owner => true", async () => {
    mockPrisma.projectGroup.findFirst.mockResolvedValue({ ownerType: "user", ownerUuid: "user-owner" });
    expect(await canManageOrClaimableGroup(ownerUser, "g")).toBe(true);
  });
});
