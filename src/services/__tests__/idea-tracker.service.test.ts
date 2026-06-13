import { describe, it, expect, vi, beforeEach } from "vitest";

// ===== Prisma mock (hoisted) =====
const { mockPrisma } = vi.hoisted(() => ({
  mockPrisma: {
    idea: { findMany: vi.fn() },
    proposal: { findMany: vi.fn() },
    task: { findMany: vi.fn() },
    project: { findMany: vi.fn() },
  },
}));

vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));

import { buildIdeaTracker, buildTaskTracker } from "@/services/idea-tracker.service";
import type { AuthContext } from "@/types/auth";

// ===== Fixtures =====
const COMPANY_UUID = "company-1111-1111-1111-111111111111";
const AGENT_UUID = "agent-2222-2222-2222-222222222222";
const OWNER_UUID = "owner-3333-3333-3333-333333333333";
const OTHER_USER_UUID = "user-9999-9999-9999-999999999999";
const PROJECT_A = "project-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
const PROJECT_B = "project-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
const now = new Date("2026-05-01T10:00:00Z");

const agentAuth: AuthContext = {
  type: "agent",
  companyUuid: COMPANY_UUID,
  actorUuid: AGENT_UUID,
  ownerUuid: OWNER_UUID,
  roles: ["developer_agent"],
};

const userAuth: AuthContext = {
  type: "user",
  companyUuid: COMPANY_UUID,
  actorUuid: OTHER_USER_UUID,
};

function makeIdea(
  uuid: string,
  projectUuid: string,
  status: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    uuid,
    title: `Idea ${uuid}`,
    status,
    elaborationStatus: null,
    parentUuid: null,
    projectUuid,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeProposal(
  uuid: string,
  projectUuid: string,
  status: string,
  inputUuids: string[],
  overrides: Record<string, unknown> = {},
) {
  return {
    uuid,
    projectUuid,
    status,
    inputType: "idea",
    inputUuids,
    createdAt: now,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.idea.findMany.mockResolvedValue([]);
  mockPrisma.proposal.findMany.mockResolvedValue([]);
  mockPrisma.task.findMany.mockResolvedValue([]);
  mockPrisma.project.findMany.mockResolvedValue([]);
});

// ============================================================
// buildIdeaTracker
// ============================================================

describe("buildIdeaTracker — assignee conditions", () => {
  it("agent without owner: only matches agent.actorUuid", async () => {
    const noOwnerAuth: AuthContext = {
      type: "agent",
      companyUuid: COMPANY_UUID,
      actorUuid: AGENT_UUID,
      roles: ["developer_agent"],
    };

    await buildIdeaTracker(noOwnerAuth);

    expect(mockPrisma.idea.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [{ assigneeType: "agent", assigneeUuid: AGENT_UUID }],
        }),
      }),
    );
  });

  it("agent with owner: matches both agent and owner-as-user", async () => {
    await buildIdeaTracker(agentAuth);

    expect(mockPrisma.idea.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [
            { assigneeType: "agent", assigneeUuid: AGENT_UUID },
            { assigneeType: "user", assigneeUuid: OWNER_UUID },
          ],
        }),
      }),
    );
  });

  it("user auth: only matches user.actorUuid", async () => {
    await buildIdeaTracker(userAuth);

    expect(mockPrisma.idea.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [{ assigneeType: "user", assigneeUuid: OTHER_USER_UUID }],
        }),
      }),
    );
  });
});

describe("buildIdeaTracker — filters", () => {
  it("excludes status=closed at the DB layer", async () => {
    await buildIdeaTracker(agentAuth);

    expect(mockPrisma.idea.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: { not: "closed" },
        }),
      }),
    );
  });

  it("filters out ideas whose derivedStatus === done (all tasks done)", async () => {
    const proposalUuid = "proposal-done";
    mockPrisma.idea.findMany.mockResolvedValue([
      makeIdea("i1", PROJECT_A, "elaborated"),
    ]);
    mockPrisma.proposal.findMany.mockResolvedValue([
      makeProposal(proposalUuid, PROJECT_A, "approved", ["i1"]),
    ]);
    mockPrisma.task.findMany.mockResolvedValue([
      { proposalUuid, status: "done" },
      { proposalUuid, status: "closed" },
    ]);
    mockPrisma.project.findMany.mockResolvedValue([{ uuid: PROJECT_A, name: "A" }]);

    const tracker = await buildIdeaTracker(agentAuth);
    expect(tracker).toEqual({});
  });

  it("returns empty object when there are no ideas at all", async () => {
    mockPrisma.idea.findMany.mockResolvedValue([]);
    const tracker = await buildIdeaTracker(agentAuth);
    expect(tracker).toEqual({});
    expect(mockPrisma.proposal.findMany).not.toHaveBeenCalled();
  });
});

describe("buildIdeaTracker — derivedStatus mapping", () => {
  it("status=open maps to derivedStatus=todo", async () => {
    mockPrisma.idea.findMany.mockResolvedValue([
      makeIdea("i1", PROJECT_A, "open"),
    ]);
    mockPrisma.project.findMany.mockResolvedValue([{ uuid: PROJECT_A, name: "A" }]);

    const tracker = await buildIdeaTracker(agentAuth);
    expect(tracker[PROJECT_A].ideas[0].status).toBe("todo");
  });

  it("status=elaborating + pending_answers maps to human_conduct_required", async () => {
    mockPrisma.idea.findMany.mockResolvedValue([
      makeIdea("i1", PROJECT_A, "elaborating", { elaborationStatus: "pending_answers" }),
    ]);
    mockPrisma.project.findMany.mockResolvedValue([{ uuid: PROJECT_A, name: "A" }]);

    const tracker = await buildIdeaTracker(agentAuth);
    expect(tracker[PROJECT_A].ideas[0].status).toBe("human_conduct_required");
  });

  it("status=elaborated + pending proposal maps to human_conduct_required", async () => {
    mockPrisma.idea.findMany.mockResolvedValue([
      makeIdea("i1", PROJECT_A, "elaborated"),
    ]);
    mockPrisma.proposal.findMany.mockResolvedValue([
      makeProposal("p1", PROJECT_A, "pending", ["i1"]),
    ]);
    mockPrisma.project.findMany.mockResolvedValue([{ uuid: PROJECT_A, name: "A" }]);

    const tracker = await buildIdeaTracker(agentAuth);
    expect(tracker[PROJECT_A].ideas[0].status).toBe("human_conduct_required");
  });

  it("status=elaborated + approved proposal + tasks in progress maps to in_progress", async () => {
    mockPrisma.idea.findMany.mockResolvedValue([
      makeIdea("i1", PROJECT_A, "elaborated"),
    ]);
    mockPrisma.proposal.findMany.mockResolvedValue([
      makeProposal("p1", PROJECT_A, "approved", ["i1"]),
    ]);
    mockPrisma.task.findMany.mockResolvedValue([
      { proposalUuid: "p1", status: "in_progress" },
      { proposalUuid: "p1", status: "open" },
    ]);
    mockPrisma.project.findMany.mockResolvedValue([{ uuid: PROJECT_A, name: "A" }]);

    const tracker = await buildIdeaTracker(agentAuth);
    expect(tracker[PROJECT_A].ideas[0].status).toBe("in_progress");
  });

  it("status=elaborated + approved proposal + a task in to_verify -> human_conduct_required", async () => {
    mockPrisma.idea.findMany.mockResolvedValue([
      makeIdea("i1", PROJECT_A, "elaborated"),
    ]);
    mockPrisma.proposal.findMany.mockResolvedValue([
      makeProposal("p1", PROJECT_A, "approved", ["i1"]),
    ]);
    mockPrisma.task.findMany.mockResolvedValue([
      { proposalUuid: "p1", status: "to_verify" },
      { proposalUuid: "p1", status: "done" },
    ]);
    mockPrisma.project.findMany.mockResolvedValue([{ uuid: PROJECT_A, name: "A" }]);

    const tracker = await buildIdeaTracker(agentAuth);
    expect(tracker[PROJECT_A].ideas[0].status).toBe("human_conduct_required");
  });
});

describe("buildIdeaTracker — proposal/task counts", () => {
  it("proposals counts both pending and approved attached to the idea", async () => {
    mockPrisma.idea.findMany.mockResolvedValue([
      makeIdea("i1", PROJECT_A, "elaborated"),
    ]);
    mockPrisma.proposal.findMany.mockResolvedValue([
      makeProposal("p1", PROJECT_A, "pending", ["i1"]),
      makeProposal("p2", PROJECT_A, "approved", ["i1"]),
    ]);
    mockPrisma.task.findMany.mockResolvedValue([
      { proposalUuid: "p2", status: "in_progress" },
    ]);
    mockPrisma.project.findMany.mockResolvedValue([{ uuid: PROJECT_A, name: "A" }]);

    const tracker = await buildIdeaTracker(agentAuth);
    expect(tracker[PROJECT_A].ideas[0].proposals).toBe(2);
    expect(tracker[PROJECT_A].ideas[0].tasks).toBe(1);
  });

  it("tasks count is based on the most-recently-approved proposal only", async () => {
    const old = new Date("2026-04-01T00:00:00Z");
    const recent = new Date("2026-04-15T00:00:00Z");
    mockPrisma.idea.findMany.mockResolvedValue([
      makeIdea("i1", PROJECT_A, "elaborated"),
    ]);
    mockPrisma.proposal.findMany.mockResolvedValue([
      makeProposal("p_old", PROJECT_A, "approved", ["i1"], { createdAt: old }),
      makeProposal("p_recent", PROJECT_A, "approved", ["i1"], { createdAt: recent }),
    ]);
    mockPrisma.task.findMany.mockResolvedValue([
      // p_old has 5 tasks (irrelevant)
      { proposalUuid: "p_old", status: "in_progress" },
      { proposalUuid: "p_old", status: "in_progress" },
      { proposalUuid: "p_old", status: "in_progress" },
      { proposalUuid: "p_old", status: "in_progress" },
      { proposalUuid: "p_old", status: "in_progress" },
      // p_recent has 2 tasks (counted)
      { proposalUuid: "p_recent", status: "in_progress" },
      { proposalUuid: "p_recent", status: "open" },
    ]);
    mockPrisma.project.findMany.mockResolvedValue([{ uuid: PROJECT_A, name: "A" }]);

    const tracker = await buildIdeaTracker(agentAuth);
    // task query is filtered by approvedProposalUuids — implementation will fetch
    // tasks for both p_old and p_recent, but only p_recent's count is reported.
    expect(tracker[PROJECT_A].ideas[0].tasks).toBe(2);
  });

  it("ignores proposals with non-array inputUuids gracefully", async () => {
    mockPrisma.idea.findMany.mockResolvedValue([
      makeIdea("i1", PROJECT_A, "elaborated"),
    ]);
    mockPrisma.proposal.findMany.mockResolvedValue([
      // malformed inputUuids — should be skipped
      { ...makeProposal("p1", PROJECT_A, "approved", []), inputUuids: null },
    ]);
    mockPrisma.project.findMany.mockResolvedValue([{ uuid: PROJECT_A, name: "A" }]);

    const tracker = await buildIdeaTracker(agentAuth);
    expect(tracker[PROJECT_A].ideas[0].proposals).toBe(0);
    expect(tracker[PROJECT_A].ideas[0].tasks).toBe(0);
  });

  it("ignores proposal entries that don't reference any of the agent's ideas", async () => {
    mockPrisma.idea.findMany.mockResolvedValue([
      makeIdea("i1", PROJECT_A, "elaborated"),
    ]);
    mockPrisma.proposal.findMany.mockResolvedValue([
      makeProposal("p1", PROJECT_A, "approved", ["unrelated-idea-uuid"]),
    ]);
    mockPrisma.project.findMany.mockResolvedValue([{ uuid: PROJECT_A, name: "A" }]);

    const tracker = await buildIdeaTracker(agentAuth);
    expect(tracker[PROJECT_A].ideas[0].proposals).toBe(0);
  });
});

describe("buildIdeaTracker — parentUuid pass-through", () => {
  it("requests parentUuid in the idea select projection (no extra query)", async () => {
    await buildIdeaTracker(agentAuth);
    expect(mockPrisma.idea.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({ parentUuid: true }),
      }),
    );
  });

  it("carries the stored parentUuid onto the tracker entry when set", async () => {
    const parentIdeaUuid = "idea-pppp-pppp-pppp-pppppppppppp";
    mockPrisma.idea.findMany.mockResolvedValue([
      makeIdea("i_child", PROJECT_A, "open", { parentUuid: parentIdeaUuid }),
    ]);
    mockPrisma.project.findMany.mockResolvedValue([{ uuid: PROJECT_A, name: "A" }]);

    const tracker = await buildIdeaTracker(agentAuth);
    expect(tracker[PROJECT_A].ideas[0].parentUuid).toBe(parentIdeaUuid);
  });

  it("normalizes a parentless idea to parentUuid: null", async () => {
    mockPrisma.idea.findMany.mockResolvedValue([
      makeIdea("i_top", PROJECT_A, "open", { parentUuid: null }),
    ]);
    mockPrisma.project.findMany.mockResolvedValue([{ uuid: PROJECT_A, name: "A" }]);

    const tracker = await buildIdeaTracker(agentAuth);
    expect(tracker[PROJECT_A].ideas[0].parentUuid).toBeNull();
  });
});

describe("buildIdeaTracker — grouping & ordering & options", () => {
  it("groups ideas by project and uses project.name", async () => {
    mockPrisma.idea.findMany.mockResolvedValue([
      makeIdea("i1", PROJECT_A, "open"),
      makeIdea("i2", PROJECT_B, "open"),
    ]);
    mockPrisma.project.findMany.mockResolvedValue([
      { uuid: PROJECT_A, name: "A" },
      { uuid: PROJECT_B, name: "B" },
    ]);

    const tracker = await buildIdeaTracker(agentAuth);
    expect(tracker[PROJECT_A].name).toBe("A");
    expect(tracker[PROJECT_A].ideas).toHaveLength(1);
    expect(tracker[PROJECT_B].name).toBe("B");
    expect(tracker[PROJECT_B].ideas).toHaveLength(1);
  });

  it("falls back to empty string when project name is missing", async () => {
    mockPrisma.idea.findMany.mockResolvedValue([
      makeIdea("i1", PROJECT_A, "open"),
    ]);
    mockPrisma.project.findMany.mockResolvedValue([]); // no project rows
    const tracker = await buildIdeaTracker(agentAuth);
    expect(tracker[PROJECT_A].name).toBe("");
  });

  it("orderBy updatedAt desc is requested at the prisma layer", async () => {
    await buildIdeaTracker(agentAuth);
    expect(mockPrisma.idea.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { updatedAt: "desc" } }),
    );
  });

  it("respects options.maxIdeas cap (keeps the first N visited, which are most recent)", async () => {
    const ideas = Array.from({ length: 5 }, (_, i) =>
      makeIdea(`i${i}`, PROJECT_A, "open"),
    );
    mockPrisma.idea.findMany.mockResolvedValue(ideas);
    mockPrisma.project.findMany.mockResolvedValue([{ uuid: PROJECT_A, name: "A" }]);

    const tracker = await buildIdeaTracker(agentAuth, { maxIdeas: 3 });
    expect(tracker[PROJECT_A].ideas.map((i) => i.uuid)).toEqual(["i0", "i1", "i2"]);
  });

  it("default maxIdeas=Infinity returns the full set", async () => {
    const ideas = Array.from({ length: 25 }, (_, i) =>
      makeIdea(`i${i}`, PROJECT_A, "open"),
    );
    mockPrisma.idea.findMany.mockResolvedValue(ideas);
    mockPrisma.project.findMany.mockResolvedValue([{ uuid: PROJECT_A, name: "A" }]);

    const tracker = await buildIdeaTracker(agentAuth);
    expect(tracker[PROJECT_A].ideas).toHaveLength(25);
  });

  it("forwards options.projectUuids as a prisma 'in' filter", async () => {
    await buildIdeaTracker(agentAuth, { projectUuids: [PROJECT_A] });
    expect(mockPrisma.idea.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ projectUuid: { in: [PROJECT_A] } }),
      }),
    );
  });

  it("does NOT add projectUuid filter when projectUuids is empty array", async () => {
    await buildIdeaTracker(agentAuth, { projectUuids: [] });
    const callArg = mockPrisma.idea.findMany.mock.calls[0][0];
    expect(callArg.where).not.toHaveProperty("projectUuid");
  });
});

// ============================================================
// buildTaskTracker
// ============================================================

describe("buildTaskTracker — assignee conditions", () => {
  it("agent with owner: matches both", async () => {
    await buildTaskTracker(agentAuth);
    expect(mockPrisma.task.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [
            { assigneeType: "agent", assigneeUuid: AGENT_UUID },
            { assigneeType: "user", assigneeUuid: OWNER_UUID },
          ],
        }),
      }),
    );
  });

  it("user auth: matches user only", async () => {
    await buildTaskTracker(userAuth);
    expect(mockPrisma.task.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          OR: [{ assigneeType: "user", assigneeUuid: OTHER_USER_UUID }],
        }),
      }),
    );
  });
});

describe("buildTaskTracker — filters & ordering", () => {
  it("excludes status in [done, closed]", async () => {
    await buildTaskTracker(agentAuth);
    expect(mockPrisma.task.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          status: { notIn: ["done", "closed"] },
        }),
      }),
    );
  });

  it("orders by [priority desc, assignedAt desc]", async () => {
    await buildTaskTracker(agentAuth);
    expect(mockPrisma.task.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [{ priority: "desc" }, { assignedAt: "desc" }],
      }),
    );
  });

  it("returns empty object when there are no tasks", async () => {
    mockPrisma.task.findMany.mockResolvedValue([]);
    const tracker = await buildTaskTracker(agentAuth);
    expect(tracker).toEqual({});
  });

  it("forwards options.projectUuids as a prisma 'in' filter", async () => {
    await buildTaskTracker(agentAuth, { projectUuids: [PROJECT_A, PROJECT_B] });
    expect(mockPrisma.task.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          projectUuid: { in: [PROJECT_A, PROJECT_B] },
        }),
      }),
    );
  });
});

describe("buildTaskTracker — ac progress", () => {
  function makeTask(uuid: string, projectUuid: string, items: Array<{ status: string }>) {
    return {
      uuid,
      title: `Task ${uuid}`,
      status: "in_progress",
      priority: "high",
      assignedAt: now,
      projectUuid,
      project: { uuid: projectUuid, name: projectUuid === PROJECT_A ? "A" : "B" },
      acceptanceCriteriaItems: items,
    };
  }

  it("counts admin-verified passes only", async () => {
    mockPrisma.task.findMany.mockResolvedValue([
      makeTask("t1", PROJECT_A, [
        { status: "passed" },
        { status: "passed" },
        { status: "failed" },
        { status: "pending" },
      ]),
    ]);

    const tracker = await buildTaskTracker(agentAuth);
    expect(tracker[PROJECT_A].tasks[0].ac).toEqual({ passed: 2, total: 4 });
  });

  it("returns ac:{0,0} when items array is empty", async () => {
    mockPrisma.task.findMany.mockResolvedValue([
      makeTask("t1", PROJECT_A, []),
    ]);

    const tracker = await buildTaskTracker(agentAuth);
    expect(tracker[PROJECT_A].tasks[0].ac).toEqual({ passed: 0, total: 0 });
  });

  it("returns ac:{0,0} when acceptanceCriteriaItems is missing entirely (null/undefined defensiveness)", async () => {
    mockPrisma.task.findMany.mockResolvedValue([
      {
        ...makeTask("t1", PROJECT_A, []),
        acceptanceCriteriaItems: null,
      },
    ]);

    const tracker = await buildTaskTracker(agentAuth);
    expect(tracker[PROJECT_A].tasks[0].ac).toEqual({ passed: 0, total: 0 });
  });

  it("groups tasks by project and uses task.project.name", async () => {
    mockPrisma.task.findMany.mockResolvedValue([
      makeTask("t1", PROJECT_A, [{ status: "passed" }]),
      makeTask("t2", PROJECT_B, [{ status: "pending" }]),
    ]);

    const tracker = await buildTaskTracker(agentAuth);
    expect(tracker[PROJECT_A].name).toBe("A");
    expect(tracker[PROJECT_A].tasks).toHaveLength(1);
    expect(tracker[PROJECT_B].name).toBe("B");
    expect(tracker[PROJECT_B].tasks).toHaveLength(1);
  });

  it("includes assignedAt as ISO string and falls back to null", async () => {
    mockPrisma.task.findMany.mockResolvedValue([
      makeTask("t1", PROJECT_A, []),
      { ...makeTask("t2", PROJECT_A, []), assignedAt: null },
    ]);

    const tracker = await buildTaskTracker(agentAuth);
    expect(tracker[PROJECT_A].tasks[0].assignedAt).toBe(now.toISOString());
    expect(tracker[PROJECT_A].tasks[1].assignedAt).toBeNull();
  });

  it("falls back to empty string when task.project is missing", async () => {
    mockPrisma.task.findMany.mockResolvedValue([
      { ...makeTask("t1", PROJECT_A, []), project: null },
    ]);
    const tracker = await buildTaskTracker(agentAuth);
    expect(tracker[PROJECT_A].name).toBe("");
  });
});

// ============================================================
// Consistency: checkin vs my_assignments
// ============================================================
//
// Both call buildIdeaTracker on the same auth + same prisma mock.
// my_assignments calls with no maxIdeas (Infinity), checkin with maxIdeas:10.
// The expected invariant: the my_assignments idea set is the same as the
// checkin idea set when total <=10, and a strict superset when >10.

describe("consistency: checkin.ideaTracker ⊆ my_assignments.ideaTracker", () => {
  it("with 4 ideas (1 done, 1 closed): both surfaces return the same 2 ideas", async () => {
    mockPrisma.idea.findMany.mockImplementation(async (args: { where: { status?: unknown } }) => {
      // The DB layer filters status:{not:"closed"} — so "closed" never returns.
      // We honor that filter in the mock by returning only the 3 non-closed ideas.
      void args;
      return [
        makeIdea("i_in_progress", PROJECT_A, "elaborating", { elaborationStatus: "validated" }),
        makeIdea("i_open", PROJECT_A, "open"),
        // i_done has approved proposal where all tasks are done — should be filtered
        makeIdea("i_done", PROJECT_A, "elaborated"),
      ];
    });
    mockPrisma.proposal.findMany.mockResolvedValue([
      makeProposal("p_done", PROJECT_A, "approved", ["i_done"]),
    ]);
    mockPrisma.task.findMany.mockResolvedValue([
      { proposalUuid: "p_done", status: "done" },
    ]);
    mockPrisma.project.findMany.mockResolvedValue([{ uuid: PROJECT_A, name: "A" }]);

    const myAssignments = await buildIdeaTracker(agentAuth);
    const checkin = await buildIdeaTracker(agentAuth, { maxIdeas: 10 });

    // Same uuid set
    const myIds = (myAssignments[PROJECT_A]?.ideas ?? []).map((i) => i.uuid).sort();
    const ckIds = (checkin[PROJECT_A]?.ideas ?? []).map((i) => i.uuid).sort();
    expect(myIds).toEqual(["i_in_progress", "i_open"]);
    expect(ckIds).toEqual(myIds);

    // Same status / counts per idea
    expect(myAssignments[PROJECT_A].ideas).toEqual(checkin[PROJECT_A].ideas);
  });

  it("with 12 active ideas: my_assignments returns all 12, checkin caps to 10", async () => {
    const ideas = Array.from({ length: 12 }, (_, i) =>
      makeIdea(`i${i}`, PROJECT_A, "open"),
    );
    mockPrisma.idea.findMany.mockResolvedValue(ideas);
    mockPrisma.project.findMany.mockResolvedValue([{ uuid: PROJECT_A, name: "A" }]);

    const myAssignments = await buildIdeaTracker(agentAuth);
    const checkin = await buildIdeaTracker(agentAuth, { maxIdeas: 10 });

    expect(myAssignments[PROJECT_A].ideas).toHaveLength(12);
    expect(checkin[PROJECT_A].ideas).toHaveLength(10);

    // checkin set is a strict prefix (most-recent 10) of my_assignments
    const myFirst10 = myAssignments[PROJECT_A].ideas.slice(0, 10).map((i) => i.uuid);
    const ckIds = checkin[PROJECT_A].ideas.map((i) => i.uuid);
    expect(ckIds).toEqual(myFirst10);
  });
});
