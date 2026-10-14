import { describe, it, expect, vi, beforeEach } from "vitest";

const mockTx = vi.hoisted(() => ({
  agentInstance: { findMany: vi.fn() },
  task: { findMany: vi.fn(), updateMany: vi.fn() },
  idea: { findMany: vi.fn(), updateMany: vi.fn() },
  proposal: { findMany: vi.fn() },
}));
vi.mock("@/lib/prisma", () => ({ prisma: mockTx }));

const mockEmitChange = vi.hoisted(() => vi.fn());
vi.mock("@/lib/event-bus", () => ({ eventBus: { emitChange: mockEmitChange } }));

const mockActivityPublish = vi.hoisted(() => vi.fn());
const mockCreateActivityInTx = vi.hoisted(() => vi.fn());
vi.mock("@/services/activity.service", () => ({
  createActivityInTx: (...args: unknown[]) => mockCreateActivityInTx(...args),
}));


import { releaseAgentAssignments } from "@/services/agent-assignment-release.service";

const companyUuid = "company-1";
const agentUuid = "agent-1";
const actorUuid = "user-1";
const tx = mockTx as unknown as Parameters<typeof releaseAgentAssignments>[3];

const TASK_CLEARED = {
  status: "open",
  assigneeType: null,
  assigneeUuid: null,
  cwdSource: null,
  cwdHost: null,
  runtimeCwd: null,
  assignedAt: null,
  assignedByType: null,
  assignedByUuid: null,
};
const IDEA_CLEARED = {
  assigneeType: null,
  assigneeUuid: null,
  cwdSource: null,
  cwdHost: null,
  runtimeCwd: null,
  assignedAt: null,
  assignedByType: null,
  assignedByUuid: null,
};

// Ideas: the first idea.findMany is the assignee lookup (has OR); the second is
// the project-wide snapshot for derived status (projectUuid: { in }).
type IdeaRow = {
  uuid: string; projectUuid: string; status: string;
  elaborationStatus?: string | null; parentUuid?: string | null; isContainer?: boolean;
};
function setIdeas(assigned: IdeaRow[], projectWide: IdeaRow[] = assigned) {
  mockTx.idea.findMany.mockImplementation(async (args: { where: Record<string, unknown> }) =>
    "OR" in args.where
      ? assigned.map(({ uuid, projectUuid, status }) => ({ uuid, projectUuid, status }))
      : projectWide.map((i) => ({ elaborationStatus: null, parentUuid: null, isContainer: false, ...i })),
  );
}
type ProposalRow = { uuid: string; projectUuid: string; status: string; inputUuids: string[]; createdAt?: Date };
function setProposals(rows: ProposalRow[]) {
  mockTx.proposal.findMany.mockResolvedValue(rows.map((r) => ({ createdAt: new Date(0), ...r })));
}
function taskFindManyFor(proposalTasks: { proposalUuid: string; status: string }[], assignedTasks: unknown[] = []) {
  mockTx.task.findMany.mockImplementation(async (args: { where: Record<string, unknown> }) =>
    "proposalUuid" in args.where ? proposalTasks : assignedTasks,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockTx.proposal.findMany.mockResolvedValue([]);
  mockTx.agentInstance.findMany.mockResolvedValue([]);
  mockTx.task.findMany.mockResolvedValue([]);
  mockTx.idea.findMany.mockResolvedValue([]);
  mockTx.task.updateMany.mockResolvedValue({ count: 0 });
  mockTx.idea.updateMany.mockResolvedValue({ count: 0 });
  mockCreateActivityInTx.mockResolvedValue({ activity: { uuid: "act" }, publish: mockActivityPublish });
});

describe("releaseAgentAssignments", () => {
  it("scopes lookups to the company, the agent and its instances (read before cascade)", async () => {
    mockTx.agentInstance.findMany.mockResolvedValue([{ uuid: "inst-1" }, { uuid: "inst-2" }]);

    await releaseAgentAssignments(companyUuid, agentUuid, actorUuid, tx);

    expect(mockTx.agentInstance.findMany).toHaveBeenCalledWith({
      where: { companyUuid, agentUuid },
      select: { uuid: true },
    });
    const assigneeMatch = [
      { assigneeType: "agent", assigneeUuid: agentUuid },
      { assigneeType: "agent_instance", assigneeUuid: { in: ["inst-1", "inst-2"] } },
    ];
    expect(mockTx.task.findMany).toHaveBeenCalledWith({
      where: { companyUuid, status: { in: ["assigned", "in_progress"] }, OR: assigneeMatch },
      select: { uuid: true, projectUuid: true },
    });
    expect(mockTx.idea.findMany).toHaveBeenNthCalledWith(1, {
      where: { companyUuid, OR: assigneeMatch },
      select: { uuid: true, projectUuid: true, status: true },
    });
  });

  it("omits the agent_instance branch when the agent has no instances", async () => {
    await releaseAgentAssignments(companyUuid, agentUuid, actorUuid, tx);

    expect(mockTx.task.findMany.mock.calls[0][0].where.OR).toEqual([
      { assigneeType: "agent", assigneeUuid: agentUuid },
    ]);
  });

  it("is a no-op when nothing is assigned", async () => {
    const result = await releaseAgentAssignments(companyUuid, agentUuid, actorUuid, tx);

    expect(result.releasedTaskUuids).toEqual([]);
    expect(result.releasedIdeaUuids).toEqual([]);
    expect(mockTx.task.updateMany).not.toHaveBeenCalled();
    expect(mockTx.idea.updateMany).not.toHaveBeenCalled();
    expect(mockCreateActivityInTx).not.toHaveBeenCalled();
    expect(mockTx.proposal.findMany).not.toHaveBeenCalled();
    result.publish();
    expect(mockEmitChange).not.toHaveBeenCalled();
  });

  it("returns assigned/in_progress tasks to open with the releaseTask field set", async () => {
    mockTx.task.findMany.mockResolvedValue([
      { uuid: "t1", projectUuid: "p1" },
      { uuid: "t2", projectUuid: "p2" },
    ]);

    const result = await releaseAgentAssignments(companyUuid, agentUuid, actorUuid, tx);

    expect(result.releasedTaskUuids).toEqual(["t1", "t2"]);
    expect(mockTx.task.updateMany).toHaveBeenCalledWith({
      where: { companyUuid, uuid: { in: ["t1", "t2"] }, status: { in: ["assigned", "in_progress"] } },
      data: TASK_CLEARED,
    });
  });

  it("releases non-done ideas with releaseIdea semantics and keeps done ideas", async () => {
    setIdeas([
      { uuid: "i-open", projectUuid: "p1", status: "open" },
      { uuid: "i-elab", projectUuid: "p1", status: "elaborating" },
      { uuid: "i-legacy", projectUuid: "p2", status: "in_progress" },
      { uuid: "i-elaborated", projectUuid: "p2", status: "elaborated" },
      { uuid: "i-done", projectUuid: "p2", status: "elaborated" },
    ]);
    setProposals([
      { uuid: "prop-done", projectUuid: "p2", status: "approved", inputUuids: ["i-done"] },
      { uuid: "prop-building", projectUuid: "p2", status: "approved", inputUuids: ["i-elaborated"] },
    ]);
    taskFindManyFor([
      { proposalUuid: "prop-done", status: "done" },
      { proposalUuid: "prop-done", status: "closed" },
      { proposalUuid: "prop-building", status: "done" },
      { proposalUuid: "prop-building", status: "in_progress" },
    ]);

    const result = await releaseAgentAssignments(companyUuid, agentUuid, actorUuid, tx);

    expect(mockTx.idea.findMany).toHaveBeenNthCalledWith(2, expect.objectContaining({
      where: { companyUuid, projectUuid: { in: ["p1", "p2"] } },
    }));
    expect(mockTx.proposal.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { companyUuid, projectUuid: { in: ["p1", "p2"] }, status: { in: ["approved", "pending"] } },
    }));
    expect(result.releasedIdeaUuids).toEqual(["i-open", "i-elab", "i-legacy", "i-elaborated"]);
    expect(mockTx.idea.updateMany).toHaveBeenCalledWith({
      where: { companyUuid, uuid: { in: ["i-elaborated"] } },
      data: IDEA_CLEARED,
    });
    expect(mockTx.idea.updateMany).toHaveBeenCalledWith({
      where: { companyUuid, uuid: { in: ["i-open", "i-elab", "i-legacy"] } },
      data: { ...IDEA_CLEARED, status: "open", elaborationDepth: null, elaborationStatus: null },
    });
    const touched = mockTx.idea.updateMany.mock.calls.flatMap((c) => c[0].where.uuid.in);
    expect(touched).not.toContain("i-done");
  });

  it("uses the latest approved proposal and ignores proposals from another project", async () => {
    setIdeas([{ uuid: "i1", projectUuid: "p1", status: "elaborated" }]);
    setProposals([
      { uuid: "old", projectUuid: "p1", status: "approved", inputUuids: ["i1"], createdAt: new Date(1) },
      { uuid: "new", projectUuid: "p1", status: "approved", inputUuids: ["i1"], createdAt: new Date(2) },
      { uuid: "foreign", projectUuid: "p9", status: "pending", inputUuids: ["i1"] },
      { uuid: "bad", projectUuid: "p1", status: "pending", inputUuids: "nope" as unknown as string[] },
    ]);
    taskFindManyFor([
      { proposalUuid: "old", status: "in_progress" },
      { proposalUuid: "new", status: "done" },
    ]);

    const result = await releaseAgentAssignments(companyUuid, agentUuid, actorUuid, tx);

    // Latest approved proposal is all done and the foreign pending one is ignored → done, kept.
    expect(result.releasedIdeaUuids).toEqual([]);
    expect(mockTx.task.findMany).toHaveBeenCalledWith({
      where: { companyUuid, proposalUuid: { in: ["new"] } },
      select: { proposalUuid: true, status: true },
    });
  });

  it("releases an idea with a pending proposal (human review is not done)", async () => {
    setIdeas([{ uuid: "i1", projectUuid: "p1", status: "elaborated" }]);
    setProposals([{ uuid: "pend", projectUuid: "p1", status: "pending", inputUuids: ["i1"] }]);

    const result = await releaseAgentAssignments(companyUuid, agentUuid, actorUuid, tx);

    expect(result.releasedIdeaUuids).toEqual(["i1"]);
  });

  it("rolls a theme's status up from its same-project children", async () => {
    const theme = { projectUuid: "p1", status: "elaborated", isContainer: true };
    setIdeas(
      [
        { uuid: "theme-done", ...theme },
        { uuid: "theme-open", ...theme },
        { uuid: "theme-childless", ...theme },
      ],
      [
        { uuid: "theme-done", ...theme },
        { uuid: "sub-theme", ...theme, parentUuid: "theme-done" },
        { uuid: "leaf-a", projectUuid: "p1", status: "elaborated", parentUuid: "sub-theme" },
        { uuid: "theme-open", ...theme },
        { uuid: "leaf-b", projectUuid: "p1", status: "open", parentUuid: "theme-open" },
        { uuid: "theme-childless", ...theme },
        { uuid: "orphan", projectUuid: "p1", status: "open", parentUuid: "missing" },
      ],
    );
    setProposals([{ uuid: "pa", projectUuid: "p1", status: "approved", inputUuids: ["leaf-a"] }]);
    taskFindManyFor([{ proposalUuid: "pa", status: "done" }]);

    const result = await releaseAgentAssignments(companyUuid, agentUuid, actorUuid, tx);

    // theme-done ← sub-theme ← leaf-a (done) → done, kept. theme-open has a todo
    // child; a childless theme keeps its own (planning) status.
    expect(result.releasedIdeaUuids).toEqual(["theme-open", "theme-childless"]);
  });

  it("falls back to own status for containers in a malformed parent cycle", async () => {
    const theme = { projectUuid: "p1", status: "elaborated", isContainer: true };
    setIdeas(
      [{ uuid: "c1", ...theme, parentUuid: "c2" }],
      [
        { uuid: "c1", ...theme, parentUuid: "c2" },
        { uuid: "c2", ...theme, parentUuid: "c1" },
        { uuid: "tail", ...theme, parentUuid: "c1" },
      ],
    );

    const result = await releaseAgentAssignments(companyUuid, agentUuid, actorUuid, tx);

    // Own status is "planning" (in_progress), not done → released, no infinite loop.
    expect(result.releasedIdeaUuids).toEqual(["c1"]);
  });

  it("logs one released activity per entity attributed to the deleting user, publishing only on demand", async () => {
    mockTx.task.findMany.mockResolvedValue([{ uuid: "t1", projectUuid: "p1" }]);
    setIdeas([{ uuid: "i1", projectUuid: "p2", status: "open" }]);

    const result = await releaseAgentAssignments(companyUuid, agentUuid, actorUuid, tx);

    expect(mockCreateActivityInTx).toHaveBeenCalledTimes(2);
    expect(mockCreateActivityInTx).toHaveBeenCalledWith(tx, {
      companyUuid, projectUuid: "p1", targetType: "task", targetUuid: "t1",
      actorType: "user", actorUuid, action: "released",
    });
    expect(mockCreateActivityInTx).toHaveBeenCalledWith(tx, {
      companyUuid, projectUuid: "p2", targetType: "idea", targetUuid: "i1",
      actorType: "user", actorUuid, action: "released",
    });
    expect(mockEmitChange).not.toHaveBeenCalled();
    expect(mockActivityPublish).not.toHaveBeenCalled();

    result.publish();

    expect(mockActivityPublish).toHaveBeenCalledTimes(2);
    expect(mockEmitChange).toHaveBeenCalledWith({
      companyUuid, projectUuid: "p1", entityType: "task", entityUuid: "t1", action: "updated",
    });
    expect(mockEmitChange).toHaveBeenCalledWith({
      companyUuid, projectUuid: "p2", entityType: "idea", entityUuid: "i1", action: "updated",
    });
  });
});
