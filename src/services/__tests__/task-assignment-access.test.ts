// Assignment isolation for private projects (add-private-project-access, D4 "Assignment").
// Exercises claimTask / claimIdea / assignIdea against the REAL project-access
// service (only Prisma is mocked) so the full access matrix is covered:
// users by membership, agents via owner, ownerless agents, agent_instance via agent.
import { vi, describe, it, expect, beforeEach } from "vitest";

const COMPANY = "company-1";
const PRIVATE = "project-private";
const PUBLIC = "project-public";

// ----- in-memory fixture world -----
const projects: Record<string, { uuid: string; companyUuid: string; visibility: string }> = {
  [PRIVATE]: { uuid: PRIVATE, companyUuid: COMPANY, visibility: "private" },
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
};

let currentProject = PRIVATE;

const mockPrisma = vi.hoisted(() => ({
  project: { findFirst: vi.fn() },
  projectMember: { findUnique: vi.fn() },
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

import { claimTask, AssigneeAccessError } from "@/services/task.service";
import { claimIdea, assignIdea } from "@/services/idea.service";

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
  mockPrisma.project.findFirst.mockImplementation(async ({ where }: { where: { uuid: string; companyUuid: string } }) => {
    const p = projects[where.uuid];
    return p && p.companyUuid === where.companyUuid ? p : null;
  });
  mockPrisma.projectMember.findUnique.mockImplementation(
    async ({ where }: { where: { projectUuid_userUuid: { projectUuid: string; userUuid: string } } }) => {
      const { projectUuid, userUuid } = where.projectUuid_userUuid;
      const role = members[projectUuid]?.[userUuid];
      return role ? { role } : null;
    },
  );
  mockPrisma.agent.findFirst.mockImplementation(async ({ where }: { where: { uuid: string } }) => agents[where.uuid] ?? null);
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
  describe("private project", () => {
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
