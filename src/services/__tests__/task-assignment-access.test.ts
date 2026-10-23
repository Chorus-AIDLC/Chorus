// Assignment isolation for private projects (add-private-project-access, D4 "Assignment").
// Exercises claimTask / claimIdea / assignIdea against the REAL project-access
// service (only Prisma is mocked) so the full access matrix is covered:
// users by membership, agents via owner, ownerless agents, agent_instance via agent.
import { vi, describe, it, expect, beforeEach } from "vitest";
vi.mock("@/services/idea-team.service", () => ({ ideaTeamEnrollment: vi.fn(async () => ({})) }));

const COMPANY = "company-1";
const PRIVATE = "project-private";
const PUBLIC = "project-public";

// ----- in-memory fixture world -----
const projects: Record<string, { uuid: string; companyUuid: string; visibility: string; groupUuid?: string }> = {
  [PRIVATE]: { uuid: PRIVATE, companyUuid: COMPANY, visibility: "private", groupUuid: "group-private" },
  [PUBLIC]: { uuid: PUBLIC, companyUuid: COMPANY, visibility: "public" },
};
// projectUuid -> userUuid -> role
const members: Record<string, Record<string, string>> = {
  [PRIVATE]: { "user-editor": "editor", "user-viewer": "viewer", "user-admin": "admin" },
  [PUBLIC]: {},
};
const agents: Record<string, { ownerUuid: string | null }> = {
  "agent-of-editor": { ownerUuid: "user-editor" },
  "agent-of-viewer": { ownerUuid: "user-viewer" },
  "agent-of-outsider": { ownerUuid: "user-outsider" },
  "agent-ownerless": { ownerUuid: null },
};
const instances: Record<string, { agentUuid: string }> = {
  "inst-editor": { agentUuid: "agent-of-editor" },
  "inst-outsider": { agentUuid: "agent-of-outsider" },
  "inst-orphan": { agentUuid: "agent-deleted" },
};
const users = new Set(["user-editor", "user-viewer", "user-admin", "user-outsider"]);

let currentProject = PRIVATE;
let inherited: Record<string, string> = {};

const mockPrisma = vi.hoisted(() => ({
  user: { findFirst: vi.fn(async () => null) },
  projectGroup: { findFirst: vi.fn(async () => ({ uuid: "group-private", companyUuid: "company-1" })) },
  project: { findFirst: vi.fn() },
  projectMember: { findUnique: vi.fn(), findFirst: vi.fn() },
  projectGroupMember: { findFirst: vi.fn() },
  agent: { findFirst: vi.fn() },
  agentInstance: { findFirst: vi.fn() },
  task: { findFirst: vi.fn(), update: vi.fn() },
  idea: { findFirst: vi.fn(), update: vi.fn() },
}));
vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/event-bus", () => ({ eventBus: { emitChange: vi.fn() } }));
vi.mock("@/lib/uuid-resolver", () => ({
  formatAssigneeComplete: vi.fn().mockResolvedValue(null),
  formatCreatedBy: vi.fn().mockResolvedValue(null),
  formatReview: vi.fn().mockResolvedValue(null),
  buildAssigneeMatch: vi.fn().mockResolvedValue([]),
  batchGetActorNames: vi.fn().mockResolvedValue(new Map()),
  batchFormatCreatedBy: vi.fn().mockResolvedValue(new Map()),
  batchGetAssigneeInstanceInfo: vi.fn().mockResolvedValue(new Map()),
  batchResolveAssignmentActors: vi.fn().mockResolvedValue([]),
}));
vi.mock("@/services/comment.service", () => ({ batchCommentCounts: vi.fn().mockResolvedValue({}) }));
vi.mock("@/services/mention.service", () => ({ parseMentions: vi.fn().mockReturnValue([]), createMentions: vi.fn() }));
vi.mock("@/services/activity.service", () => ({ createActivity: vi.fn() }));

import { claimTask, AssigneeAccessError, resolveLiveAssignee } from "@/services/task.service";
import { claimIdea, assignIdea, collectBlockedAssignees, type MoveAssigneeRow } from "@/services/idea.service";

function row(projectUuid: string, extra: Record<string, unknown> = {}) {
  const now = new Date("2026-01-01T00:00:00Z");
  return {
    uuid: "entity-1",
    companyUuid: COMPANY,
    projectUuid,
    title: "T",
    description: null,
    content: null,
    attachments: null,
    status: "open",
    priority: "medium",
    storyPoints: null,
    acceptanceCriteria: null,
    elaborationStatus: null,
    elaborationDepth: null,
    assigneeType: null,
    assigneeUuid: null,
    assignedAt: null,
    assignedByType: null,
    assignedByUuid: null,
    proposalUuid: null,
    createdByUuid: "creator",
    createdAt: now,
    updatedAt: now,
    project: { uuid: projectUuid, name: "P" },
    ...extra,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  currentProject = PRIVATE;
  inherited = {};
  mockPrisma.projectMember.findFirst.mockImplementation(async ({ where }: { where: { companyUuid: string; projectUuid: string; role: string } }) => {
    if (where.companyUuid !== COMPANY) return null;
    const entry = Object.entries(members[where.projectUuid] ?? {}).find(([, role]) => role === where.role);
    return entry ? { userUuid: entry[0], role: entry[1] } : null;
  });
  mockPrisma.projectGroupMember.findFirst.mockImplementation(async ({ where }: { where: { userUuid?: string; role?: string } }) => {
    const entry = Object.entries(inherited).find(([userUuid, role]) =>
      (where.userUuid === undefined || where.userUuid === userUuid) && (where.role === undefined || where.role === role));
    return entry ? { userUuid: entry[0], role: entry[1] } : null;
  });
  mockPrisma.project.findFirst.mockImplementation(async ({ where }: { where: { uuid: string; companyUuid: string } }) => {
    const p = projects[where.uuid];
    return p && p.companyUuid === where.companyUuid ? p : null;
  });
  mockPrisma.projectMember.findUnique.mockImplementation(
    async ({ where }: { where: { companyUuid: string; projectUuid_userUuid: { projectUuid: string; userUuid: string } } }) => {
      if (where.companyUuid !== COMPANY) return null;
      const { projectUuid, userUuid } = where.projectUuid_userUuid;
      const role = members[projectUuid]?.[userUuid];
      return role ? { role } : null;
    },
  );
  mockPrisma.agent.findFirst.mockImplementation(async ({ where }: { where: { uuid: string } }) =>
    agents[where.uuid] ? { ...agents[where.uuid], name: `Agent ${where.uuid}` } : null);
  // By-uuid lookups resolve known users (live-assignee resolution); the
  // company-wide "first user" lookup still finds nobody (no implicit admin).
  mockPrisma.user.findFirst.mockImplementation((async ({ where }: { where: { uuid?: string } }) =>
    where.uuid && users.has(where.uuid) ? { name: `User ${where.uuid}` } : null) as never);
  mockPrisma.agentInstance.findFirst.mockImplementation(async ({ where }: { where: { uuid: string } }) =>
    instances[where.uuid] ? { uuid: where.uuid, agentUuid: instances[where.uuid].agentUuid } : null,
  );
  mockPrisma.task.findFirst.mockImplementation(async () => ({ projectUuid: currentProject }));
  mockPrisma.task.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
    row(currentProject, { ...data }),
  );
  mockPrisma.idea.findFirst.mockImplementation(async () => row(currentProject));
  mockPrisma.idea.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) =>
    row(currentProject, { ...data }),
  );
});

type Assignee = { type: string; uuid: string; instanceUuid?: string };

const ops = {
  claimTask: (a: Assignee) =>
    claimTask({ taskUuid: "entity-1", companyUuid: COMPANY, assigneeType: a.type, assigneeUuid: a.uuid, instanceUuid: a.instanceUuid }),
  claimIdea: (a: Assignee) =>
    claimIdea({ ideaUuid: "entity-1", companyUuid: COMPANY, assigneeType: a.type, assigneeUuid: a.uuid, instanceUuid: a.instanceUuid }),
  assignIdea: (a: Assignee) =>
    assignIdea({
      ideaUuid: "entity-1",
      companyUuid: COMPANY,
      assigneeType: a.type,
      assigneeUuid: a.uuid,
      instanceUuid: a.instanceUuid,
      assignedByType: "user",
      assignedByUuid: "user-admin",
    }),
};
const updateOf = { claimTask: () => mockPrisma.task.update, claimIdea: () => mockPrisma.idea.update, assignIdea: () => mockPrisma.idea.update };

const privateRejected: Array<[string, Assignee]> = [
  ["user non-member", { type: "user", uuid: "user-outsider" }],
  ["viewer member", { type: "user", uuid: "user-viewer" }],
  ["agent whose owner is a viewer", { type: "agent", uuid: "agent-of-viewer" }],
  ["agent whose owner is a non-member", { type: "agent", uuid: "agent-of-outsider" }],
  ["ownerless agent", { type: "agent", uuid: "agent-ownerless" }],
  ["unknown agent", { type: "agent", uuid: "agent-missing" }],
  ["instance pin of an agent whose owner is a non-member", { type: "agent", uuid: "agent-of-editor", instanceUuid: "inst-outsider" }],
];
const privateAllowed: Array<[string, Assignee]> = [
  ["editor member", { type: "user", uuid: "user-editor" }],
  ["admin member", { type: "user", uuid: "user-admin" }],
  ["agent whose owner is an editor", { type: "agent", uuid: "agent-of-editor" }],
  ["instance pin of an agent whose owner is an editor", { type: "agent", uuid: "agent-of-editor", instanceUuid: "inst-editor" }],
];
const publicAllowed: Array<[string, Assignee]> = [
  ["user non-member", { type: "user", uuid: "user-outsider" }],
  ["agent whose owner is a non-member", { type: "agent", uuid: "agent-of-outsider" }],
  ["ownerless agent", { type: "agent", uuid: "agent-ownerless" }],
  ["instance pin of an outsider's agent", { type: "agent", uuid: "agent-of-outsider", instanceUuid: "inst-outsider" }],
];

describe.each(Object.keys(ops) as Array<keyof typeof ops>)("%s assignment access", (op) => {
  it.each([PRIVATE, PUBLIC])("rejects an ineligible user before the %s membership/public floor can authorize them", async projectUuid => {
    currentProject = projectUuid;
    // DB's active/undeleted company-scoped lookup finds no eligible principal,
    // even when the old UUID still has an editor membership.
    mockPrisma.user.findFirst.mockResolvedValueOnce(null);
    await expect(ops[op]({ type: "user", uuid: "user-editor" })).rejects.toBeInstanceOf(AssigneeAccessError);
    expect(mockPrisma.user.findFirst).toHaveBeenCalledWith({
      where: { uuid: "user-editor", companyUuid: COMPANY, status: "active", deletedAt: null },
      select: { uuid: true },
    });
    expect(updateOf[op]()).not.toHaveBeenCalled();
  });
  describe("private project", () => {
    it.each(["user", "agent"])("allows a group Editor with a lower local Viewer role as %s", async (type) => {
      inherited["user-viewer"] = "editor";
      const assignee = { type, uuid: type === "user" ? "user-viewer" : "agent-of-viewer" };
      await expect(ops[op](assignee)).resolves.toBeDefined();
      expect(updateOf[op]()).toHaveBeenCalledOnce();
    });

    it("rejects an inherited Viewer and keeps a local Editor after group removal", async () => {
      inherited["user-outsider"] = "viewer";
      await expect(ops[op]({ type: "user", uuid: "user-outsider" })).rejects.toBeInstanceOf(AssigneeAccessError);
      inherited = {};
      await expect(ops[op]({ type: "user", uuid: "user-editor" })).resolves.toBeDefined();
      expect(updateOf[op]()).toHaveBeenCalledOnce();
    });
    it.each(privateRejected)("rejects %s", async (_label, assignee) => {
      const err = await ops[op](assignee).catch((e) => e);
      expect(err).toBeInstanceOf(AssigneeAccessError);
      expect(err.message).toBe("Assignee does not have access to this project");
      expect(err.status).toBe(403);
      expect(updateOf[op]()).not.toHaveBeenCalled();
    });

    it.each(privateAllowed)("allows %s", async (_label, assignee) => {
      await expect(ops[op](assignee)).resolves.toBeDefined();
      expect(updateOf[op]()).toHaveBeenCalledTimes(1);
      const data = updateOf[op]().mock.calls[0][0].data;
      expect(data.assigneeType).toBe(assignee.instanceUuid ? "agent_instance" : assignee.type);
      expect(data.assigneeUuid).toBe(assignee.instanceUuid ?? assignee.uuid);
    });
  });

  describe("public project (unchanged: every company actor is editor)", () => {
    beforeEach(() => {
      currentProject = PUBLIC;
    });

    it.each(publicAllowed)("allows %s", async (_label, assignee) => {
      await expect(ops[op](assignee)).resolves.toBeDefined();
      expect(updateOf[op]()).toHaveBeenCalledTimes(1);
    });
  });
});

// ===== Cascade-move assignee resolution (fix-idea-move-dangling-assignee D1/D2) =====

describe("resolveLiveAssignee", () => {
  it.each([
    ["user", "user-editor", { type: "user", uuid: "user-editor", name: "User user-editor" }],
    ["agent", "agent-of-editor", { type: "agent", uuid: "agent-of-editor", name: "Agent agent-of-editor" }],
    ["agent_instance", "inst-editor", { type: "agent", uuid: "agent-of-editor", name: "Agent agent-of-editor" }],
  ])("resolves a live %s assignee to its access actor", async (type, uuid, expected) => {
    await expect(resolveLiveAssignee(COMPANY, { type, uuid })).resolves.toEqual(expected);
  });

  it.each([
    ["deleted user", "user", "user-deleted"],
    ["deleted agent", "agent", "agent-deleted"],
    ["deleted agent instance", "agent_instance", "inst-deleted"],
    ["instance whose agent was deleted", "agent_instance", "inst-orphan"],
    ["unknown assignee type", "robot", "r-1"],
  ])("returns null for a %s", async (_label, type, uuid) => {
    await expect(resolveLiveAssignee(COMPANY, { type, uuid })).resolves.toBeNull();
  });

  it("is company-scoped", async () => {
    await resolveLiveAssignee(COMPANY, { type: "agent", uuid: "agent-of-editor" });
    expect(mockPrisma.agent.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: { uuid: "agent-of-editor", companyUuid: COMPANY },
    }));
  });
});

describe("collectBlockedAssignees (real project-access)", () => {
  const r = (entityType: "idea" | "task", uuid: string, assigneeType: string | null, assigneeUuid: string | null): MoveAssigneeRow =>
    ({ entityType, uuid, title: `${entityType} ${uuid}`, assigneeType, assigneeUuid });

  it("skips dangling assignees and passes agents whose owner is an editor", async () => {
    const blocked = await collectBlockedAssignees(COMPANY, [
      r("idea", "i-root", "agent", "agent-deleted"),
      r("idea", "i-child", "agent_instance", "inst-deleted"),
      r("idea", "i-orphan", "agent_instance", "inst-orphan"),
      r("task", "t-1", "user", "user-deleted"),
      r("task", "t-2", "agent", "agent-of-editor"),
      r("task", "t-3", "agent_instance", "inst-editor"),
      r("task", "t-4", null, null),
    ], PRIVATE);
    expect(blocked).toEqual([]);
  });

  it("passes an agent whose owner inherits Editor from the project group", async () => {
    inherited["user-viewer"] = "editor";
    const blocked = await collectBlockedAssignees(COMPANY, [r("task", "t-1", "agent", "agent-of-viewer")], PRIVATE);
    expect(blocked).toEqual([]);
  });

  it("reports every blocked live assignee once with all their entities", async () => {
    const blocked = await collectBlockedAssignees(COMPANY, [
      r("task", "t-1", "agent", "agent-of-outsider"),
      r("idea", "i-1", "user", "user-viewer"),
      r("task", "t-2", "agent", "agent-of-outsider"),
      r("task", "t-3", "agent", "agent-of-editor"),
      r("task", "t-4", "agent_instance", "inst-outsider"),
      r("task", "t-5", "agent", "agent-ownerless"),
    ], PRIVATE);
    expect(blocked).toEqual([
      {
        assigneeType: "agent", assigneeUuid: "agent-of-outsider", name: "Agent agent-of-outsider",
        entities: [{ type: "task", uuid: "t-1", title: "task t-1" }, { type: "task", uuid: "t-2", title: "task t-2" }],
      },
      {
        assigneeType: "user", assigneeUuid: "user-viewer", name: "User user-viewer",
        entities: [{ type: "idea", uuid: "i-1", title: "idea i-1" }],
      },
      {
        assigneeType: "agent_instance", assigneeUuid: "inst-outsider", name: "Agent agent-of-outsider",
        entities: [{ type: "task", uuid: "t-4", title: "task t-4" }],
      },
      {
        assigneeType: "agent", assigneeUuid: "agent-ownerless", name: "Agent agent-ownerless",
        entities: [{ type: "task", uuid: "t-5", title: "task t-5" }],
      },
    ]);
  });

  it("blocks nobody on a public target", async () => {
    const blocked = await collectBlockedAssignees(COMPANY, [
      r("task", "t-1", "agent", "agent-of-outsider"),
      r("task", "t-2", "agent", "agent-ownerless"),
      r("idea", "i-1", "user", "user-outsider"),
    ], PUBLIC);
    expect(blocked).toEqual([]);
  });
});
