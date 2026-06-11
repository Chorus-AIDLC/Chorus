import { describe, it, expect, vi, beforeEach } from "vitest";

// ===== Prisma mock =====
const mockPrisma = vi.hoisted(() => ({
  project: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
  },
  projectMember: {
    findMany: vi.fn(),
    findUnique: vi.fn(),
  },
}));
vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));

import {
  getAccessibleProjectUuids,
  canAccessProject,
  canManageProject,
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
