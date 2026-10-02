import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  Agent,
  Prisma,
  Project,
  ProjectGroup,
  ProjectGroupMember,
  ProjectMember,
} from "@/generated/prisma/client";
import type { AuthContext } from "@/types/auth";

const mockPrisma = vi.hoisted(() => ({
  project: {
    findFirst: vi.fn<(args: Prisma.ProjectFindFirstArgs) => Promise<Project | null>>(),
    findMany: vi.fn<(args: Prisma.ProjectFindManyArgs) => Promise<Project[]>>(),
  },
  projectMember: {
    findFirst: vi.fn<(args: Prisma.ProjectMemberFindFirstArgs) => Promise<ProjectMember | null>>(),
    findUnique: vi.fn<(args: Prisma.ProjectMemberFindUniqueArgs) => Promise<ProjectMember | null>>(),
    findMany: vi.fn<(args: Prisma.ProjectMemberFindManyArgs) => Promise<ProjectMember[]>>(),
  },
  projectGroupMember: {
    findFirst: vi.fn<(args: Prisma.ProjectGroupMemberFindFirstArgs) => Promise<ProjectGroupMember | null>>(),
    findMany: vi.fn<(args: Prisma.ProjectGroupMemberFindManyArgs) => Promise<ProjectGroupMember[]>>(),
    count: vi.fn(),
  },
  user: { findFirst: vi.fn() },
  projectGroup: {
    findFirst: vi.fn<(args: Prisma.ProjectGroupFindFirstArgs) => Promise<ProjectGroup | null>>(),
  },
  agent: {
    findFirst: vi.fn<(args: Prisma.AgentFindFirstArgs) => Promise<Agent | null>>(),
    findMany: vi.fn<(args: Prisma.AgentFindManyArgs) => Promise<Agent[]>>(),
  },
}));

vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));

import {
  accessibleProjectUuids,
  accessibleProjectWhere,
  canActorAccessProject,
  computeProjectAccess,
  filterRecipientsByProjectAccess,
  getProjectAccess,
  invalidateProjectAccessCache,
  privateProjectMemberUuids,
  resolveInheritedAccessLevel,
  type ProjectAccessClient,
  type ProjectAccessLevel,
} from "@/services/project-access.service";

const uuid = (n: number) => `00000000-0000-0000-0000-${String(n).padStart(12, "0")}`;
const COMPANY = uuid(1);
const OTHER_COMPANY = uuid(2);
const GROUP = uuid(10);
const OTHER_GROUP = uuid(11);
const PROJECT = uuid(20);
const USER = uuid(30);
const DIRECT_USER = uuid(31);
const INHERITED_USER = uuid(32);
const OUTSIDER = uuid(33);
const AGENT = uuid(40);
const NOW = new Date("2026-10-01T12:00:00.000Z");

const userAuth = (actorUuid = USER, companyUuid = COMPANY): AuthContext => ({
  type: "user", companyUuid, actorUuid,
});
const agentAuth = (ownerUuid?: string): AuthContext => ({
  type: "agent", companyUuid: COMPANY, actorUuid: AGENT, ownerUuid,
});

function projectRow(overrides: Partial<Project> = {}): Project {
  return {
    id: 1, uuid: PROJECT, companyUuid: COMPANY, name: "Private child",
    description: "Only explicit grants may expose this project", groupUuid: GROUP,
    visibility: "private", createdByUuid: DIRECT_USER, createdAt: NOW, updatedAt: NOW,
    ...overrides,
  };
}

function groupRow(overrides: Partial<ProjectGroup> = {}): ProjectGroup {
  return {
    id: 1, uuid: GROUP, companyUuid: COMPANY, name: "Public group",
    description: "Public discovery does not grant private child access",
    visibility: "public", createdByUuid: DIRECT_USER, accessVersion: 1,
    createdAt: NOW, updatedAt: NOW, ...overrides,
  };
}

function localRow(role: string, overrides: Partial<ProjectMember> = {}): ProjectMember {
  return {
    id: 1, uuid: uuid(50), companyUuid: COMPANY, projectUuid: PROJECT,
    userUuid: USER, role, addedByUuid: DIRECT_USER, createdAt: NOW, updatedAt: NOW,
    ...overrides,
  };
}

function inheritedRow(role: string, overrides: Partial<ProjectGroupMember> = {}): ProjectGroupMember {
  return {
    id: 1, uuid: uuid(60), companyUuid: COMPANY, groupUuid: GROUP,
    userUuid: USER, role, addedByUuid: DIRECT_USER, createdAt: NOW, updatedAt: NOW,
    ...overrides,
  };
}

function agentRow(overrides: Partial<Agent> = {}): Agent {
  return {
    id: 1, uuid: AGENT, companyUuid: COMPANY, name: "Owner-backed agent",
    roles: ["developer_agent"], permissions: ["task:write"], persona: null,
    systemPrompt: null, ownerUuid: USER, lastActiveAt: NOW, createdAt: NOW,
    ...overrides,
  };
}

const db = {
  projects: [] as Project[],
  groups: [] as ProjectGroup[],
  locals: [] as ProjectMember[],
  inherited: [] as ProjectGroupMember[],
  agents: [] as Agent[],
};

// Interpret only scalar equality/in/not filters used by these mocked delegates.
// Project relation filters are asserted against the query sent to Prisma below.
function matchesScalars(row: object, where: object = {}): boolean {
  return Object.entries(where).every(([key, filter]) => {
    const value = (row as Record<string, unknown>)[key];
    if (filter === undefined) return true;
    if (filter !== null && typeof filter === "object") {
      const scalar = filter as { in?: unknown[]; not?: unknown };
      if (scalar.in) return scalar.in.includes(value);
      if ("not" in scalar) return value !== scalar.not;
      throw new Error(`Unsupported fixture filter: ${key}`);
    }
    return value === filter;
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  db.projects = [projectRow()];
  db.groups = [groupRow()];
  db.locals = [];
  db.inherited = [];
  db.agents = [agentRow()];
  mockPrisma.user.findFirst.mockResolvedValue(null);
  mockPrisma.projectGroupMember.count.mockImplementation(async ({ where }) =>
    db.inherited.filter((row) => matchesScalars(row, where)).length);

  mockPrisma.project.findFirst.mockImplementation(async ({ where }) =>
    db.projects.find((row) => matchesScalars(row, where)) ?? null);
  mockPrisma.project.findMany.mockResolvedValue([]);
  mockPrisma.projectMember.findUnique.mockImplementation(async ({ where }) => {
    const key = where.projectUuid_userUuid;
    if (!key) throw new Error("Expected the project/user unique membership key");
    return db.locals.find((row) => matchesScalars(row, key) && matchesScalars(row, { companyUuid: where.companyUuid })) ?? null;
  });
  mockPrisma.projectMember.findMany.mockImplementation(async ({ where }) =>
    db.locals.filter((row) => matchesScalars(row, where)));
  mockPrisma.projectMember.findFirst.mockImplementation(async ({ where }) =>
    db.locals.find((row) => matchesScalars(row, where)) ?? null);
  mockPrisma.projectGroupMember.findFirst.mockImplementation(async ({ where }) =>
    db.inherited.find((row) => matchesScalars(row, where)) ?? null);
  mockPrisma.projectGroupMember.findMany.mockImplementation(async ({ where }) =>
    db.inherited.filter((row) => matchesScalars(row, where)));
  mockPrisma.projectGroup.findFirst.mockImplementation(async ({ where }) =>
    db.groups.find((row) => matchesScalars(row, where)) ?? null);
  mockPrisma.agent.findFirst.mockImplementation(async ({ where }) =>
    db.agents.find((row) => matchesScalars(row, where)) ?? null);
  mockPrisma.agent.findMany.mockImplementation(async ({ where }) =>
    db.agents.filter((row) => matchesScalars(row, where)));
});

const ROLES = [null, "viewer", "editor", "admin"] as const;
const PRIVATE_EXPECTATIONS: ProjectAccessLevel[][] = [
  ["none", "viewer", "editor", "admin"],
  ["viewer", "viewer", "editor", "admin"],
  ["editor", "editor", "editor", "admin"],
  ["admin", "admin", "admin", "admin"],
];
const ROLE_CASES = ROLES.flatMap((localRole, localIndex) =>
  ROLES.map((groupRole, groupIndex) => ({
    localRole,
    groupRole,
    privateLevel: PRIVATE_EXPECTATIONS[localIndex][groupIndex],
  })));

describe("explicit inherited role matrix", () => {
  it.each(ROLE_CASES)(
    "private: local=$localRole group=$groupRole => $privateLevel",
    ({ localRole, groupRole, privateLevel }) => {
      expect(resolveInheritedAccessLevel("private", localRole, groupRole)).toBe(privateLevel);
    },
  );

  it.each(ROLE_CASES)(
    "public: local=$localRole group=$groupRole retains at least Editor",
    ({ localRole, groupRole, privateLevel }) => {
      const expected = privateLevel === "admin" ? "admin" : "editor";
      expect(resolveInheritedAccessLevel("public", localRole, groupRole)).toBe(expected);
    },
  );

  it.each([
    ["owner", null, "none"],
    [null, "owner", "none"],
    ["none", "invalid", "none"],
    ["admin", "invalid", "admin"],
    ["invalid", "viewer", "viewer"],
  ] as const)("ignores unsupported grants: local=%s group=%s", (local, inherited, expected) => {
    expect(resolveInheritedAccessLevel("private", local, inherited)).toBe(expected);
  });
});

describe.each(["public", "private"] as const)("private child in a %s group", (visibility) => {
  it.each(ROLE_CASES)(
    "resolves local=$localRole group=$groupRole to $privateLevel",
    async ({ localRole, groupRole, privateLevel }) => {
      db.groups = [groupRow({ visibility })];
      if (localRole) db.locals = [localRow(localRole)];
      if (groupRole) db.inherited = [inheritedRow(groupRole)];

      expect(await computeProjectAccess(userAuth(), PROJECT)).toEqual({
        project: privateLevel === "none" ? null : db.projects[0],
        level: privateLevel,
      });
      expect(mockPrisma.project.findFirst).toHaveBeenCalledWith({
        where: { uuid: PROJECT, companyUuid: COMPANY },
      });
      expect(mockPrisma.projectMember.findUnique).toHaveBeenCalledWith({
        where: { companyUuid: COMPANY, projectUuid_userUuid: { projectUuid: PROJECT, userUuid: USER } },
        select: { role: true },
      });
      expect(mockPrisma.projectGroupMember.findFirst).toHaveBeenCalledWith({
        where: { companyUuid: COMPANY, groupUuid: GROUP, userUuid: USER },
        select: { role: true },
      });
    },
  );
});

describe("live inheritance and request caching", () => {
  it("keeps a public-group outsider out of private children while public children remain Editor", async () => {
    db.projects.push(projectRow({ id: 2, uuid: uuid(21), visibility: "public" }));
    expect(await getProjectAccess(userAuth(OUTSIDER), PROJECT)).toEqual({ project: null, level: "none" });
    expect((await getProjectAccess(userAuth(OUTSIDER), uuid(21))).level).toBe("editor");
    expect(await privateProjectMemberUuids(COMPANY, PROJECT)).toEqual([]);
    expect(await filterRecipientsByProjectAccess(COMPANY, PROJECT, [
      { type: "user", uuid: OUTSIDER },
    ])).toEqual([]);
  });

  it("observes group upgrades, demotions and removal on fresh requests", async () => {
    db.inherited = [inheritedRow("viewer")];
    expect((await getProjectAccess(userAuth(), PROJECT)).level).toBe("viewer");
    db.inherited[0] = inheritedRow("admin");
    expect((await getProjectAccess(userAuth(), PROJECT)).level).toBe("admin");
    db.inherited[0] = inheritedRow("editor");
    expect((await getProjectAccess(userAuth(), PROJECT)).level).toBe("editor");
    db.inherited = [];
    expect(await getProjectAccess(userAuth(), PROJECT)).toEqual({ project: null, level: "none" });
  });

  it("preserves a local Viewer grant when group Admin is removed", async () => {
    const local = localRow("viewer");
    db.locals = [local];
    db.inherited = [inheritedRow("admin")];
    expect((await getProjectAccess(userAuth(), PROJECT)).level).toBe("admin");
    db.inherited = [];
    expect(await getProjectAccess(userAuth(), PROJECT)).toEqual({ project: db.projects[0], level: "viewer" });
    expect(db.locals).toEqual([local]);
  });

  it("removing a local grant cannot lower the inherited floor", async () => {
    db.locals = [localRow("viewer")];
    db.inherited = [inheritedRow("editor")];
    expect((await getProjectAccess(userAuth(), PROJECT)).level).toBe("editor");
    db.locals = [];
    expect((await getProjectAccess(userAuth(), PROJECT)).level).toBe("editor");
  });

  it("inherits only the project's current group on the next request", async () => {
    db.inherited = [
      inheritedRow("admin"),
      inheritedRow("viewer", { id: 2, uuid: uuid(61), groupUuid: OTHER_GROUP }),
    ];
    expect((await getProjectAccess(userAuth(), PROJECT)).level).toBe("admin");
    db.projects[0] = projectRow({ groupUuid: OTHER_GROUP });
    expect((await getProjectAccess(userAuth(), PROJECT)).level).toBe("viewer");
  });

  it("shares pending lookups within a request and refreshes after explicit invalidation", async () => {
    const auth = userAuth();
    db.inherited = [inheritedRow("admin")];
    const results = await Promise.all([
      getProjectAccess(auth, PROJECT),
      getProjectAccess(auth, PROJECT),
    ]);
    expect(results[0]).toEqual(results[1]);
    expect(mockPrisma.project.findFirst).toHaveBeenCalledTimes(1);
    expect(mockPrisma.projectMember.findUnique).toHaveBeenCalledTimes(1);
    expect(mockPrisma.projectGroupMember.findFirst).toHaveBeenCalledTimes(2);

    db.inherited = [];
    invalidateProjectAccessCache(auth, PROJECT);
    expect(await getProjectAccess(auth, PROJECT)).toEqual({ project: null, level: "none" });
    expect(mockPrisma.projectGroupMember.findFirst).toHaveBeenCalledTimes(4);
  });

  it("does not reuse a request cache for direct transaction-compatible computation", async () => {
    const auth = userAuth();
    db.inherited = [inheritedRow("admin")];
    expect((await getProjectAccess(auth, PROJECT)).level).toBe("admin");
    db.inherited = [];
    expect(await computeProjectAccess(auth, PROJECT)).toEqual({ project: null, level: "none" });
  });

  it("retries a rejected inherited lookup instead of caching the failure", async () => {
    const auth = userAuth();
    db.inherited = [inheritedRow("viewer")];
    mockPrisma.projectGroupMember.findFirst.mockRejectedValueOnce(new Error("temporary lookup failure"));
    await expect(getProjectAccess(auth, PROJECT)).rejects.toThrow("temporary lookup failure");
    expect((await getProjectAccess(auth, PROJECT)).level).toBe("viewer");
    expect(mockPrisma.projectGroupMember.findFirst).toHaveBeenCalledTimes(3);
  });
});

describe("principal, transaction and company boundaries", () => {
  it.each(ROLE_CASES)(
    "agent inherits owner's local=$localRole group=$groupRole => $privateLevel",
    async ({ localRole, groupRole, privateLevel }) => {
      if (localRole) db.locals = [localRow(localRole)];
      if (groupRole) db.inherited = [inheritedRow(groupRole)];
      expect((await computeProjectAccess(agentAuth(USER), PROJECT)).level).toBe(privateLevel);
      expect(mockPrisma.projectMember.findUnique).toHaveBeenCalledWith(expect.objectContaining({
        where: { companyUuid: COMPANY, projectUuid_userUuid: { projectUuid: PROJECT, userUuid: USER } },
      }));
      expect(mockPrisma.projectGroupMember.findFirst).toHaveBeenCalledWith(expect.objectContaining({
        where: { companyUuid: COMPANY, groupUuid: GROUP, userUuid: USER },
      }));
    },
  );

  it("an agent's own UUID grants no membership, including for an ownerless agent", async () => {
    db.locals = [localRow("admin", { userUuid: AGENT })];
    db.inherited = [inheritedRow("admin", { userUuid: AGENT })];
    expect(await computeProjectAccess(agentAuth(OUTSIDER), PROJECT)).toEqual({ project: null, level: "none" });
    vi.clearAllMocks();
    expect(await computeProjectAccess(agentAuth(), PROJECT)).toEqual({ project: null, level: "none" });
    expect(mockPrisma.projectMember.findUnique).not.toHaveBeenCalled();
    expect(mockPrisma.projectGroupMember.findFirst).not.toHaveBeenCalled();
    db.projects[0] = projectRow({ visibility: "public" });
    expect((await computeProjectAccess(agentAuth(), PROJECT)).level).toBe("editor");
  });

  it("does not query group grants for an ungrouped project", async () => {
    db.projects[0] = projectRow({ groupUuid: null });
    db.locals = [localRow("viewer")];
    db.inherited = [inheritedRow("admin")];
    expect((await computeProjectAccess(userAuth(), PROJECT)).level).toBe("viewer");
    expect(mockPrisma.projectGroupMember.findFirst).not.toHaveBeenCalled();
  });

  it.each(["missing", PROJECT])("returns no access before any grant lookup for foreign/missing project %s", async (projectUuid) => {
    db.inherited = [inheritedRow("admin")];
    expect(await computeProjectAccess(userAuth(USER, OTHER_COMPANY), projectUuid)).toEqual({
      project: null, level: "none",
    });
    expect(mockPrisma.project.findFirst).toHaveBeenCalledWith({
      where: { uuid: projectUuid, companyUuid: OTHER_COMPANY },
    });
    expect(mockPrisma.projectMember.findUnique).not.toHaveBeenCalled();
    expect(mockPrisma.projectGroupMember.findFirst).not.toHaveBeenCalled();
  });

  it("rejects foreign-company and unrelated-group rows for the same principal", async () => {
    db.inherited = [
      inheritedRow("admin", { companyUuid: OTHER_COMPANY }),
      inheritedRow("admin", { id: 2, uuid: uuid(61), groupUuid: OTHER_GROUP }),
    ];
    expect(await computeProjectAccess(userAuth(), PROJECT)).toEqual({ project: null, level: "none" });
  });

  it("uses every supplied client delegate rather than global Prisma or cached access", async () => {
    const auth = userAuth();
    db.inherited = [inheritedRow("admin")];
    await getProjectAccess(auth, PROJECT);
    const transactionProject = projectRow({ description: "Transaction snapshot" });
    const client = {
      project: { findFirst: vi.fn().mockResolvedValue(transactionProject) },
      projectMember: { findUnique: vi.fn().mockResolvedValue(localRow("viewer")), findFirst: vi.fn().mockResolvedValue(null) },
      projectGroupMember: { findFirst: vi.fn().mockResolvedValue(inheritedRow("editor")) },
      projectGroup: { findFirst: vi.fn().mockResolvedValue(groupRow()) },
      user: { findFirst: vi.fn().mockResolvedValue(null) },
    };
    vi.clearAllMocks();

    expect(await computeProjectAccess(auth, PROJECT, client as unknown as ProjectAccessClient)).toEqual({
      project: transactionProject, level: "editor",
    });
    expect(client.project.findFirst).toHaveBeenCalledWith({
      where: { uuid: PROJECT, companyUuid: COMPANY },
    });
    expect(client.projectMember.findUnique).toHaveBeenCalledTimes(1);
    expect(client.projectGroupMember.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { companyUuid: COMPANY, groupUuid: GROUP, userUuid: USER },
    }));
    expect(mockPrisma.project.findFirst).not.toHaveBeenCalled();
    expect(mockPrisma.projectMember.findUnique).not.toHaveBeenCalled();
    expect(mockPrisma.projectGroupMember.findFirst).not.toHaveBeenCalled();
  });
});

describe("accessible project query", () => {
  it.each([
    ["user", () => userAuth()],
    ["owner-backed agent", () => agentAuth(USER)],
  ] as const)("includes direct and inherited grants for a %s without project-by-project resolution", async (_label, auth) => {
    db.locals = [localRow("viewer")];
    const where = await accessibleProjectWhere(auth());
    expect(where.companyUuid).toBe(COMPANY);
    expect(where.OR).toEqual(expect.arrayContaining([
      { visibility: { not: "private" } },
      { uuid: { in: [PROJECT] } },
      {
        group: {
          companyUuid: COMPANY,
          members: {
            some: {
              companyUuid: COMPANY, userUuid: USER,
              role: { in: ["viewer", "editor", "admin"] },
            },
          },
        },
      },
    ]));
    expect(mockPrisma.projectMember.findMany).toHaveBeenCalledWith({
      where: { companyUuid: COMPANY, userUuid: USER }, select: { projectUuid: true },
    });
    expect(mockPrisma.project.findFirst).not.toHaveBeenCalled();
    expect(mockPrisma.projectGroupMember.findFirst).not.toHaveBeenCalled();
  });

  it("uses explicit membership in the group clause even when there is no local membership", async () => {
    const where = await accessibleProjectWhere(userAuth(OUTSIDER));
    expect(where.OR).toHaveLength(2);
    expect(where.OR).toContainEqual({
      group: {
        companyUuid: COMPANY,
        members: {
          some: {
            companyUuid: COMPANY, userUuid: OUTSIDER,
            role: { in: ["viewer", "editor", "admin"] },
          },
        },
      },
    });
  });

  it("limits ownerless agents to company public projects without membership queries", async () => {
    expect(await accessibleProjectWhere(agentAuth())).toEqual({
      companyUuid: COMPANY, OR: [{ visibility: { not: "private" } }],
    });
    expect(mockPrisma.projectMember.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.projectGroupMember.findMany).not.toHaveBeenCalled();
  });

  it("passes the inherited filter to the project list query", async () => {
    db.locals = [localRow("viewer")];
    mockPrisma.project.findMany.mockResolvedValue([projectRow(), projectRow({ uuid: uuid(21) })]);
    const auth = userAuth();
    const where = await accessibleProjectWhere(auth);
    expect(await accessibleProjectUuids(auth)).toEqual([PROJECT, uuid(21)]);
    expect(mockPrisma.project.findMany).toHaveBeenCalledWith({
      where, select: { uuid: true },
    });
  });
});

describe("effective recipient and private member union", () => {
  const recipients = () => [
    { type: "user", uuid: INHERITED_USER, label: "inherited" },
    { type: "agent", uuid: AGENT, label: "inherited owner's agent" },
    { type: "user", uuid: DIRECT_USER, label: "direct" },
    { type: "user", uuid: USER, label: "both" },
    { type: "user", uuid: OUTSIDER, label: "outsider" },
    { type: "agent", uuid: uuid(41), label: "ownerless" },
    { type: "agent", uuid: uuid(42), label: "foreign company" },
    { type: "agent", uuid: uuid(43), label: "missing agent" },
    { type: "agent_instance", uuid: USER, label: "unsupported recipient type" },
  ];

  function seedRecipients() {
    db.locals = [
      localRow("viewer", { userUuid: DIRECT_USER }),
      localRow("admin", { id: 2, uuid: uuid(51), userUuid: USER }),
    ];
    db.inherited = [
      inheritedRow("viewer", { userUuid: INHERITED_USER }),
      inheritedRow("editor", { id: 2, uuid: uuid(61), userUuid: USER }),
      inheritedRow("admin", { id: 3, uuid: uuid(62), userUuid: OUTSIDER, companyUuid: OTHER_COMPANY }),
      inheritedRow("admin", { id: 4, uuid: uuid(63), userUuid: OUTSIDER, groupUuid: OTHER_GROUP }),
    ];
    db.agents = [
      agentRow({ ownerUuid: INHERITED_USER }),
      agentRow({ id: 2, uuid: uuid(41), ownerUuid: null }),
      agentRow({ id: 3, uuid: uuid(42), companyUuid: OTHER_COMPANY, ownerUuid: USER }),
    ];
  }

  it("retains direct/inherited users and owner-backed agents in input order with metadata", async () => {
    seedRecipients();
    const input = recipients();
    expect(await filterRecipientsByProjectAccess(COMPANY, PROJECT, input)).toEqual(input.slice(0, 4));
    expect(mockPrisma.project.findFirst).toHaveBeenCalledWith({
      where: { uuid: PROJECT, companyUuid: COMPANY },
      select: { visibility: true, groupUuid: true },
    });
    expect(mockPrisma.projectGroupMember.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        companyUuid: COMPANY, groupUuid: GROUP,
        userUuid: { in: expect.arrayContaining([INHERITED_USER, DIRECT_USER, USER, OUTSIDER]) },
        role: { in: ["viewer", "editor", "admin"] },
      },
      select: { userUuid: true },
    }));
    expect(mockPrisma.agent.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        companyUuid: COMPANY,
        uuid: { in: [AGENT, uuid(41), uuid(42), uuid(43)] },
      },
    }));
    expect(mockPrisma.project.findFirst).toHaveBeenCalledTimes(2);
    expect(mockPrisma.projectMember.findMany).toHaveBeenCalledTimes(1);
    expect(mockPrisma.projectGroupMember.findMany).toHaveBeenCalledTimes(1);
    expect(mockPrisma.agent.findMany).toHaveBeenCalledTimes(1);
  });

  it.each(["viewer", "editor", "admin"] as const)("includes a group-only %s and their agent", async (role) => {
    db.inherited = [inheritedRow(role)];
    const input = [{ type: "user", uuid: USER }, { type: "agent", uuid: AGENT }];
    expect(await filterRecipientsByProjectAccess(COMPANY, PROJECT, input)).toEqual(input);
    expect(await privateProjectMemberUuids(COMPANY, PROJECT)).toEqual([USER]);
  });

  it("deduplicates principals with both grant layers and scopes inherited enumeration", async () => {
    seedRecipients();
    const members = await privateProjectMemberUuids(COMPANY, PROJECT);
    expect(members).toHaveLength(3);
    expect(members).toEqual(expect.arrayContaining([DIRECT_USER, USER, INHERITED_USER]));
    expect(mockPrisma.projectMember.findMany).toHaveBeenCalledWith({
      where: { projectUuid: PROJECT, companyUuid: COMPANY }, select: { userUuid: true },
    });
    expect(mockPrisma.projectGroupMember.findMany).toHaveBeenCalledWith({
      where: {
        companyUuid: COMPANY, groupUuid: GROUP,
        role: { in: ["viewer", "editor", "admin"] },
      },
      select: { userUuid: true },
    });
  });

  it("immediately drops inherited recipients on revocation while keeping local grants", async () => {
    seedRecipients();
    const input = recipients();
    await filterRecipientsByProjectAccess(COMPANY, PROJECT, input);
    db.inherited = [];
    expect(await filterRecipientsByProjectAccess(COMPANY, PROJECT, input)).toEqual([input[2], input[3]]);
    expect(await privateProjectMemberUuids(COMPANY, PROJECT)).toEqual([DIRECT_USER, USER]);
  });

  it("does not enumerate group members for an ungrouped private project", async () => {
    seedRecipients();
    db.projects[0] = projectRow({ groupUuid: null });
    const input = recipients();
    expect(await filterRecipientsByProjectAccess(COMPANY, PROJECT, input)).toEqual([input[2], input[3]]);
    expect(await privateProjectMemberUuids(COMPANY, PROJECT)).toEqual([DIRECT_USER, USER]);
    expect(mockPrisma.projectGroupMember.findMany).not.toHaveBeenCalled();
  });

  it("ignores malformed inherited roles rather than treating them as grants", async () => {
    db.inherited = [inheritedRow("owner")];
    expect(await privateProjectMemberUuids(COMPANY, PROJECT)).toEqual([]);
    expect(await filterRecipientsByProjectAccess(COMPANY, PROJECT, [{ type: "user", uuid: USER }])).toEqual([]);
  });

  it("cannot enumerate members or deliver recipients for a project in another company", async () => {
    seedRecipients();
    expect(await privateProjectMemberUuids(OTHER_COMPANY, PROJECT)).toBeNull();
    expect(await filterRecipientsByProjectAccess(OTHER_COMPANY, PROJECT, recipients())).toEqual([]);
    expect(mockPrisma.projectMember.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.projectGroupMember.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.agent.findMany).not.toHaveBeenCalled();
  });

  it("keeps public recipient behavior without consulting either grant layer", async () => {
    db.projects[0] = projectRow({ visibility: "public" });
    const input = [{ type: "user", uuid: OUTSIDER }, { type: "agent", uuid: AGENT }];
    expect(await privateProjectMemberUuids(COMPANY, PROJECT)).toBeNull();
    expect(await filterRecipientsByProjectAccess(COMPANY, PROJECT, input)).toEqual(input);
    expect(mockPrisma.projectMember.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.projectGroupMember.findMany).not.toHaveBeenCalled();
  });

  it("does no database work for an empty recipient list", async () => {
    expect(await filterRecipientsByProjectAccess(COMPANY, PROJECT, [])).toEqual([]);
    expect(mockPrisma.project.findFirst).not.toHaveBeenCalled();
  });
});

describe("third-party inherited access", () => {
  it.each([
    ["viewer", "viewer", true],
    ["viewer", "editor", false],
    ["editor", "editor", true],
    ["editor", "admin", false],
    ["admin", "admin", true],
  ] as const)("checks an inherited %s against required %s", async (role, minimum, allowed) => {
    db.inherited = [inheritedRow(role)];
    expect(await canActorAccessProject(COMPANY, { type: "user", uuid: USER }, PROJECT, minimum)).toBe(allowed);
    expect(await canActorAccessProject(COMPANY, { type: "agent", uuid: AGENT }, PROJECT, minimum)).toBe(allowed);
  });

  it("resolves agent ownership in the company and rejects ownerless/unknown actors", async () => {
    db.inherited = [inheritedRow("admin")];
    db.agents = [agentRow({ ownerUuid: null })];
    expect(await canActorAccessProject(COMPANY, { type: "agent", uuid: AGENT }, PROJECT, "viewer")).toBe(false);
    expect(await canActorAccessProject(COMPANY, { type: "agent", uuid: uuid(99) }, PROJECT, "viewer")).toBe(false);
    expect(await canActorAccessProject(COMPANY, { type: "agent_instance", uuid: USER }, PROJECT, "viewer")).toBe(false);
    expect(mockPrisma.agent.findFirst).toHaveBeenCalledWith({
      where: { uuid: AGENT, companyUuid: COMPANY }, select: { ownerUuid: true },
    });
  });
});
