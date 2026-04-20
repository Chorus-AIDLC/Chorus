import { describe, it, expect, vi, beforeEach } from "vitest";

// ===== Prisma mock =====
const mockPrisma = vi.hoisted(() => ({
  toolUsageEvent: {
    findMany: vi.fn(),
    createMany: vi.fn(),
  },
  agentSession: {
    findMany: vi.fn(),
    findFirst: vi.fn(),
  },
  tokenUsageRecord: {
    findMany: vi.fn(),
    createMany: vi.fn(),
    deleteMany: vi.fn(),
  },
  idea: {
    findMany: vi.fn(),
  },
  proposal: {
    findMany: vi.fn(),
  },
  task: {
    findMany: vi.fn(),
  },
  agent: {
    findMany: vi.fn(),
  },
}));
vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));

import {
  getEntityTokens,
  getIdeaLifecycleTokens,
  getProposalTokens,
  getAgentObservability,
  batchInsertClientToolEvents,
  classifyPhase,
  resolveProjectUuids,
  insertAttributedTokenUsage,
} from "@/services/observability.service";

// ===== Helpers =====
const companyUuid = "company-0000-0000-0000-000000000001";
const agentUuid = "agent-0000-0000-0000-000000000001";
const sessionUuidA = "session-a";
const sessionUuidB = "session-b";
const ideaUuid = "idea-0000-0000-0000-000000000001";
const proposalUuid = "proposal-0000-0000-0000-000000000001";
const taskUuidA = "task-a";
const taskUuidB = "task-b";
const projectUuid = "project-0000-0000-0000-000000000001";

type Event = {
  toolName: string;
  isError: boolean;
  durationMs: number;
  inputSize: number;
  outputSize: number;
  sessionUuid: string | null;
  entityType?: string | null;
  entityUuid?: string | null;
  agentUuid?: string;
  createdAt?: Date;
};

function makeEvent(overrides: Partial<Event> = {}): Event {
  return {
    toolName: "chorus_get_task",
    isError: false,
    durationMs: 10,
    inputSize: 100,
    outputSize: 200,
    sessionUuid: sessionUuidA,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.tokenUsageRecord.findMany.mockResolvedValue([]);
});

// ===== classifyPhase =====
describe("classifyPhase", () => {
  it("maps elaboration tools", () => {
    expect(classifyPhase("chorus_pm_start_elaboration")).toBe("elaboration");
    expect(classifyPhase("chorus_answer_elaboration")).toBe("elaboration");
    expect(classifyPhase("chorus_get_elaboration")).toBe("elaboration");
  });

  it("maps proposal-phase tools", () => {
    expect(classifyPhase("chorus_pm_create_proposal")).toBe("proposal");
    expect(classifyPhase("chorus_pm_add_task_draft")).toBe("proposal");
    expect(classifyPhase("chorus_pm_submit_proposal")).toBe("proposal");
    expect(classifyPhase("chorus_get_proposal")).toBe("proposal");
  });

  it("maps review-phase tools", () => {
    expect(classifyPhase("chorus_admin_approve_proposal")).toBe("review");
    expect(classifyPhase("chorus_admin_reject_proposal")).toBe("review");
  });

  it("maps verify-phase tools", () => {
    expect(classifyPhase("chorus_submit_for_verify")).toBe("verify");
    expect(classifyPhase("chorus_admin_verify_task")).toBe("verify");
    expect(classifyPhase("chorus_admin_reopen_task")).toBe("verify");
  });

  it("returns null for non-phase tools", () => {
    expect(classifyPhase("chorus_get_task")).toBe(null);
    expect(classifyPhase("chorus_update_task")).toBe(null);
  });
});

// ===== getEntityTokens =====
describe("getEntityTokens", () => {
  it("aggregates tool events and sums token usage from TokenUsageRecord", async () => {
    mockPrisma.toolUsageEvent.findMany.mockResolvedValue([
      makeEvent({ toolName: "chorus_get_task", inputSize: 100, outputSize: 200, durationMs: 10 }),
      makeEvent({ toolName: "chorus_update_task", inputSize: 50, outputSize: 80, durationMs: 5 }),
      makeEvent({ toolName: "chorus_get_task", inputSize: 30, outputSize: 40, durationMs: 2, isError: true }),
    ]);
    mockPrisma.tokenUsageRecord.findMany.mockResolvedValue([
      {
        inputTokens: 1000, outputTokens: 500, cacheCreationInputTokens: 0, cacheReadInputTokens: 200,
        sessionUuid: sessionUuidA,
      },
    ]);

    const result = await getEntityTokens(companyUuid, "task", taskUuidA);

    expect(result.toolCallCount).toBe(3);
    expect(result.toolErrorCount).toBe(1);
    expect(result.totalInputSize).toBe(180);
    expect(result.totalOutputSize).toBe(320);
    expect(result.totalDurationMs).toBe(17);
    expect(result.toolBreakdown).toHaveLength(2);
    expect(result.toolBreakdown[0].toolName).toBe("chorus_get_task");
    expect(result.toolBreakdown[0].callCount).toBe(2);
    expect(result.toolBreakdown[0].errorCount).toBe(1);
    expect(result.sessionTokens).toEqual({
      input_tokens: 1000,
      output_tokens: 500,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 200,
    });
    expect(result.sessionCount).toBe(1);
  });

  it("skips session lookup when no events have sessionUuid", async () => {
    mockPrisma.toolUsageEvent.findMany.mockResolvedValue([
      makeEvent({ sessionUuid: null }),
    ]);

    const result = await getEntityTokens(companyUuid, "idea", ideaUuid);
    expect(mockPrisma.agentSession.findMany).not.toHaveBeenCalled();
    expect(result.sessionCount).toBe(0);
    expect(result.sessionTokens.input_tokens).toBe(0);
  });

  it("sums token records and counts distinct sessions", async () => {
    mockPrisma.toolUsageEvent.findMany.mockResolvedValue([
      makeEvent({ sessionUuid: sessionUuidA }),
      makeEvent({ sessionUuid: sessionUuidA }),
      makeEvent({ sessionUuid: sessionUuidB }),
    ]);
    mockPrisma.tokenUsageRecord.findMany.mockResolvedValue([
      { inputTokens: 100, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, sessionUuid: sessionUuidA },
      { inputTokens: 50, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, sessionUuid: sessionUuidB },
    ]);

    const result = await getEntityTokens(companyUuid, "task", taskUuidA);

    expect(result.sessionTokens.input_tokens).toBe(150);
    expect(result.sessionCount).toBe(2);
  });

  it("handles missing/invalid tokenUsage safely", async () => {
    mockPrisma.toolUsageEvent.findMany.mockResolvedValue([
      makeEvent({ sessionUuid: sessionUuidA }),
    ]);
    mockPrisma.agentSession.findMany.mockResolvedValue([
      { tokenUsage: null },
      { tokenUsage: { input_tokens: "bogus" } },
    ]);

    const result = await getEntityTokens(companyUuid, "task", taskUuidA);
    expect(result.sessionTokens.input_tokens).toBe(0);
  });

  it("returns empty aggregation when no events exist", async () => {
    mockPrisma.toolUsageEvent.findMany.mockResolvedValue([]);
    const result = await getEntityTokens(companyUuid, "document", "doc-uuid");
    expect(result.toolCallCount).toBe(0);
    expect(result.toolBreakdown).toEqual([]);
    expect(mockPrisma.agentSession.findMany).not.toHaveBeenCalled();
  });
});

// ===== getIdeaLifecycleTokens =====
describe("getIdeaLifecycleTokens", () => {
  it("aggregates events across idea/proposal/tasks and buckets by phase", async () => {
    mockPrisma.proposal.findMany.mockResolvedValue([
      { uuid: proposalUuid, inputUuids: [ideaUuid] },
      { uuid: "other-proposal", inputUuids: ["other-idea"] },
    ]);
    mockPrisma.task.findMany.mockResolvedValue([
      { uuid: taskUuidA, title: "Task A", status: "done" },
      { uuid: taskUuidB, title: "Task B", status: "in_progress" },
    ]);
    mockPrisma.toolUsageEvent.findMany.mockResolvedValue([
      // elaboration on the idea
      makeEvent({ toolName: "chorus_pm_start_elaboration", entityType: "idea", entityUuid: ideaUuid, sessionUuid: sessionUuidA }),
      makeEvent({ toolName: "chorus_answer_elaboration", entityType: "idea", entityUuid: ideaUuid, sessionUuid: sessionUuidA }),
      // proposal drafting
      makeEvent({ toolName: "chorus_pm_add_task_draft", entityType: "proposal", entityUuid: proposalUuid, sessionUuid: sessionUuidA }),
      // review
      makeEvent({ toolName: "chorus_admin_approve_proposal", entityType: "proposal", entityUuid: proposalUuid, sessionUuid: sessionUuidB }),
      // execution on task A
      makeEvent({ toolName: "chorus_get_task", entityType: "task", entityUuid: taskUuidA, sessionUuid: sessionUuidB }),
      // verify on task B
      makeEvent({ toolName: "chorus_submit_for_verify", entityType: "task", entityUuid: taskUuidB, sessionUuid: sessionUuidB }),
    ]);
    // First call: entity-level token records
    mockPrisma.tokenUsageRecord.findMany.mockResolvedValueOnce([
      { entityType: "idea", entityUuid: ideaUuid, inputTokens: 100, outputTokens: 50, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
      { entityType: "task", entityUuid: taskUuidA, inputTokens: 200, outputTokens: 80, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
    ]);
    // Second call: project-level token records
    mockPrisma.tokenUsageRecord.findMany.mockResolvedValueOnce([]);

    const result = await getIdeaLifecycleTokens(companyUuid, ideaUuid);

    expect(result.ideaUuid).toBe(ideaUuid);
    expect(result.phases).toHaveLength(5);
    const byPhase = Object.fromEntries(result.phases.map((p) => [p.phase, p]));
    expect(byPhase.elaboration.toolCallCount).toBe(2);
    expect(byPhase.proposal.toolCallCount).toBe(1);
    expect(byPhase.review.toolCallCount).toBe(1);
    expect(byPhase.execution.toolCallCount).toBe(1);
    expect(byPhase.verify.toolCallCount).toBe(1);

    // idea entity tokens appear in elaboration phase
    expect(byPhase.elaboration.sessionTokens.input_tokens).toBe(100);

    // Tasks
    expect(result.tasks).toHaveLength(2);
    const byTask = Object.fromEntries(result.tasks.map((t) => [t.taskUuid, t]));
    expect(byTask[taskUuidA].toolCallCount).toBe(1);
    expect(byTask[taskUuidA].sessionTokens.input_tokens).toBe(200);
    expect(byTask[taskUuidB].toolCallCount).toBe(1);

    // Totals: idea + task A = 300 input tokens
    expect(result.totals.sessionTokens.input_tokens).toBe(300);
    expect(result.totals.toolCallCount).toBe(6);
  });

  it("uses entity fallback for non-discriminating tool names", async () => {
    mockPrisma.proposal.findMany.mockResolvedValue([]);
    mockPrisma.task.findMany.mockResolvedValue([]);
    mockPrisma.toolUsageEvent.findMany.mockResolvedValue([
      makeEvent({ toolName: "chorus_get_idea", entityType: "idea", entityUuid: ideaUuid, sessionUuid: null }),
    ]);
    mockPrisma.agentSession.findMany.mockResolvedValue([]);

    const result = await getIdeaLifecycleTokens(companyUuid, ideaUuid);
    const elab = result.phases.find((p) => p.phase === "elaboration")!;
    expect(elab.toolCallCount).toBe(1);
  });

  it("handles idea with no proposals/tasks", async () => {
    mockPrisma.proposal.findMany.mockResolvedValue([]);
    mockPrisma.task.findMany.mockResolvedValue([]);
    mockPrisma.toolUsageEvent.findMany.mockResolvedValue([]);
    mockPrisma.agentSession.findMany.mockResolvedValue([]);

    const result = await getIdeaLifecycleTokens(companyUuid, ideaUuid);
    expect(result.phases.every((p) => p.toolCallCount === 0)).toBe(true);
    expect(result.tasks).toEqual([]);
    expect(mockPrisma.task.findMany).not.toHaveBeenCalled();
  });

  it("filters proposals by inputUuids containing the ideaUuid", async () => {
    mockPrisma.proposal.findMany.mockResolvedValue([
      { uuid: "p1", inputUuids: [ideaUuid] },
      { uuid: "p2", inputUuids: ["other"] },
      { uuid: "p3", inputUuids: null },
    ]);
    mockPrisma.task.findMany.mockResolvedValue([]);
    mockPrisma.toolUsageEvent.findMany.mockResolvedValue([]);
    mockPrisma.agentSession.findMany.mockResolvedValue([]);

    await getIdeaLifecycleTokens(companyUuid, ideaUuid);
    const callArg = mockPrisma.task.findMany.mock.calls[0][0];
    expect(callArg.where.proposalUuid.in).toEqual(["p1"]);
  });
});

// ===== getProposalTokens =====
describe("getProposalTokens", () => {
  it("splits drafting vs review events", async () => {
    mockPrisma.toolUsageEvent.findMany.mockResolvedValue([
      makeEvent({ toolName: "chorus_pm_add_task_draft", sessionUuid: sessionUuidA, inputSize: 100, outputSize: 50 }),
      makeEvent({ toolName: "chorus_pm_submit_proposal", sessionUuid: sessionUuidA, inputSize: 20, outputSize: 30 }),
      makeEvent({ toolName: "chorus_admin_approve_proposal", sessionUuid: sessionUuidB, inputSize: 10, outputSize: 40 }),
      makeEvent({ toolName: "chorus_admin_reject_proposal", sessionUuid: sessionUuidB, inputSize: 15, outputSize: 25 }),
    ]);
    mockPrisma.tokenUsageRecord.findMany.mockResolvedValue([
      { inputTokens: 500, outputTokens: 250, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
    ]);

    const result = await getProposalTokens(companyUuid, proposalUuid);

    expect(result.proposalUuid).toBe(proposalUuid);
    expect(result.drafting.toolCallCount).toBe(2);
    expect(result.drafting.totalInputSize).toBe(120);
    expect(result.drafting.totalOutputSize).toBe(80);
    expect(result.review.toolCallCount).toBe(2);
    expect(result.review.totalInputSize).toBe(25);
    expect(result.review.totalOutputSize).toBe(65);
    expect(result.drafting.sessionTokens.input_tokens).toBe(500);
  });

  it("returns zeroed aggregations when no events", async () => {
    mockPrisma.toolUsageEvent.findMany.mockResolvedValue([]);
    const result = await getProposalTokens(companyUuid, proposalUuid);
    expect(result.drafting.toolCallCount).toBe(0);
    expect(result.review.toolCallCount).toBe(0);
    expect(result.drafting.sessionTokens.input_tokens).toBe(0);
  });
});

// ===== getAgentObservability =====
describe("getAgentObservability", () => {
  it("groups events by agent with tokens and daily series", async () => {
    const day1 = new Date("2026-04-17T10:00:00Z");
    const day2 = new Date("2026-04-18T10:00:00Z");
    mockPrisma.toolUsageEvent.findMany.mockResolvedValue([
      {
        agentUuid: "agent-1",
        toolName: "chorus_get_task",
        isError: false,
        durationMs: 5,
        inputSize: 10,
        outputSize: 20,
        sessionUuid: sessionUuidA,
        createdAt: day1,
      },
      {
        agentUuid: "agent-1",
        toolName: "chorus_get_task",
        isError: true,
        durationMs: 3,
        inputSize: 5,
        outputSize: 8,
        sessionUuid: sessionUuidA,
        createdAt: day2,
      },
      {
        agentUuid: "agent-2",
        toolName: "chorus_update_task",
        isError: false,
        durationMs: 8,
        inputSize: 40,
        outputSize: 60,
        sessionUuid: null,
        createdAt: day1,
      },
    ]);
    mockPrisma.agent.findMany.mockResolvedValue([
      { uuid: "agent-1", name: "Alpha" },
      { uuid: "agent-2", name: "Beta" },
    ]);
    mockPrisma.tokenUsageRecord.findMany.mockResolvedValue([
      { agentUuid: "agent-1", inputTokens: 500, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, sessionUuid: sessionUuidA },
    ]);

    const result = await getAgentObservability(companyUuid, projectUuid, 7);

    expect(result.dateRange.days).toBe(7);
    expect(result.agents).toHaveLength(2);
    expect(result.agents[0].agentUuid).toBe("agent-1");
    expect(result.agents[0].agentName).toBe("Alpha");
    expect(result.agents[0].toolCallCount).toBe(2);
    expect(result.agents[0].toolErrorCount).toBe(1);
    expect(result.agents[0].sessionCount).toBe(1);
    expect(result.agents[0].sessionTokens.input_tokens).toBe(500);
    expect(result.agents[0].dailySeries).toEqual([
      { date: "2026-04-17", toolCallCount: 1 },
      { date: "2026-04-18", toolCallCount: 1 },
    ]);
    expect(result.agents[1].agentUuid).toBe("agent-2");
    expect(result.agents[1].sessionCount).toBe(0);
  });

  it("handles agent with unknown name gracefully", async () => {
    mockPrisma.toolUsageEvent.findMany.mockResolvedValue([
      {
        agentUuid: "agent-unknown",
        toolName: "chorus_get_task",
        isError: false,
        durationMs: 1,
        inputSize: 1,
        outputSize: 1,
        sessionUuid: null,
        createdAt: new Date("2026-04-18T00:00:00Z"),
      },
    ]);
    mockPrisma.agent.findMany.mockResolvedValue([]);

    const result = await getAgentObservability(companyUuid, projectUuid, 30);
    expect(result.agents[0].agentName).toBe("Unknown Agent");
  });

  it("returns empty agents list when no events", async () => {
    mockPrisma.toolUsageEvent.findMany.mockResolvedValue([]);
    mockPrisma.agent.findMany.mockResolvedValue([]);

    const result = await getAgentObservability(companyUuid, projectUuid, 30);
    expect(result.agents).toEqual([]);
    expect(mockPrisma.agent.findMany).not.toHaveBeenCalled();
  });

  it("scopes the query by company, project and time window", async () => {
    mockPrisma.toolUsageEvent.findMany.mockResolvedValue([]);
    mockPrisma.agent.findMany.mockResolvedValue([]);
    mockPrisma.agentSession.findMany.mockResolvedValue([]);

    await getAgentObservability(companyUuid, projectUuid, 7);
    const call = mockPrisma.toolUsageEvent.findMany.mock.calls[0][0];
    expect(call.where.companyUuid).toBe(companyUuid);
    expect(call.where.projectUuid).toBe(projectUuid);
    expect(call.where.createdAt.gte).toBeInstanceOf(Date);
  });
});

// ===== batchInsertClientToolEvents =====
describe("batchInsertClientToolEvents", () => {
  it("inserts mapped rows with source=client", async () => {
    mockPrisma.toolUsageEvent.createMany.mockResolvedValue({ count: 2 });

    const result = await batchInsertClientToolEvents(
      companyUuid,
      agentUuid,
      sessionUuidA,
      [
        {
          tool: "Bash",
          input_len: 100,
          output_len: 200,
          entity_type: "task",
          entity_uuid: taskUuidA,
          project_uuid: projectUuid,
          ts: "2026-04-18T00:00:00Z",
        },
        { tool: "Read" },
      ]
    );

    expect(result.inserted).toBe(2);
    const args = mockPrisma.toolUsageEvent.createMany.mock.calls[0][0];
    expect(args.data).toHaveLength(2);
    expect(args.data[0]).toMatchObject({
      companyUuid,
      agentUuid,
      sessionUuid: sessionUuidA,
      toolName: "Bash",
      source: "client",
      inputSize: 100,
      outputSize: 200,
      entityType: "task",
      entityUuid: taskUuidA,
      projectUuid,
    });
    expect(args.data[0].createdAt).toEqual(new Date("2026-04-18T00:00:00Z"));
    expect(args.data[1]).toMatchObject({
      toolName: "Read",
      inputSize: 0,
      outputSize: 0,
      entityType: null,
      entityUuid: null,
      projectUuid: null,
    });
  });

  it("returns 0 and skips DB call when events is empty", async () => {
    const result = await batchInsertClientToolEvents(
      companyUuid,
      agentUuid,
      sessionUuidA,
      []
    );
    expect(result.inserted).toBe(0);
    expect(mockPrisma.toolUsageEvent.createMany).not.toHaveBeenCalled();
  });

  it("propagates is_error and error_text flags", async () => {
    mockPrisma.toolUsageEvent.createMany.mockResolvedValue({ count: 1 });
    await batchInsertClientToolEvents(companyUuid, agentUuid, null, [
      { tool: "Bash", is_error: true, error_text: "boom" },
    ]);
    const args = mockPrisma.toolUsageEvent.createMany.mock.calls[0][0];
    expect(args.data[0].isError).toBe(true);
    expect(args.data[0].errorText).toBe("boom");
    expect(args.data[0].sessionUuid).toBe(null);
  });
});

// ===== resolveProjectUuids =====
describe("resolveProjectUuids", () => {
  beforeEach(() => vi.clearAllMocks());

  it("resolves idea → projectUuid directly", async () => {
    mockPrisma.task.findMany.mockResolvedValue([]);
    mockPrisma.idea.findMany.mockResolvedValue([{ uuid: ideaUuid, projectUuid }]);
    mockPrisma.proposal.findMany.mockResolvedValue([]);

    const records = [{ entityType: "idea", entityUuid: ideaUuid }] as Parameters<typeof resolveProjectUuids>[1];
    const result = await resolveProjectUuids(companyUuid, records);
    expect(result.get(ideaUuid)).toBe(projectUuid);
  });

  it("resolves proposal → projectUuid directly", async () => {
    mockPrisma.task.findMany.mockResolvedValue([]);
    mockPrisma.idea.findMany.mockResolvedValue([]);
    mockPrisma.proposal.findMany.mockResolvedValue([{ uuid: proposalUuid, projectUuid }]);

    const records = [{ entityType: "proposal", entityUuid: proposalUuid }] as Parameters<typeof resolveProjectUuids>[1];
    const result = await resolveProjectUuids(companyUuid, records);
    expect(result.get(proposalUuid)).toBe(projectUuid);
  });

  it("resolves task → proposal → projectUuid via join", async () => {
    mockPrisma.task.findMany.mockResolvedValue([{ uuid: taskUuidA, proposalUuid }]);
    mockPrisma.idea.findMany.mockResolvedValue([]);
    // Only one proposal.findMany call: task→proposalUuid lookup (direct proposal lookup skipped since no proposal entity)
    mockPrisma.proposal.findMany.mockResolvedValue([{ uuid: proposalUuid, projectUuid }]);

    const records = [{ entityType: "task", entityUuid: taskUuidA }] as Parameters<typeof resolveProjectUuids>[1];
    const result = await resolveProjectUuids(companyUuid, records);
    expect(result.get(taskUuidA)).toBe(projectUuid);
  });

  it("returns empty map for records without entities", async () => {
    const records = [{ entityType: null, entityUuid: null }] as Parameters<typeof resolveProjectUuids>[1];
    const result = await resolveProjectUuids(companyUuid, records);
    expect(result.size).toBe(0);
  });
});

// ===== insertAttributedTokenUsage =====
describe("insertAttributedTokenUsage", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns zero for empty records", async () => {
    const result = await insertAttributedTokenUsage([]);
    expect(result).toEqual({ inserted: 0 });
    expect(mockPrisma.tokenUsageRecord.createMany).not.toHaveBeenCalled();
  });

  it("deletes old records by sourceSessionId before inserting", async () => {
    mockPrisma.tokenUsageRecord.deleteMany.mockResolvedValue({ count: 1 });
    mockPrisma.tokenUsageRecord.createMany.mockResolvedValue({ count: 2 });

    const records = [
      { sourceSessionId: "sess-1", companyUuid, agentUuid, sessionUuid: null, projectUuid: null, entityType: "task", entityUuid: taskUuidA, inputTokens: 10, outputTokens: 20, cacheCreationInputTokens: 30, cacheReadInputTokens: 40, isReviewer: false, turnTimestamp: null },
      { sourceSessionId: "sess-1", companyUuid, agentUuid, sessionUuid: null, projectUuid: null, entityType: "idea", entityUuid: ideaUuid, inputTokens: 5, outputTokens: 15, cacheCreationInputTokens: 25, cacheReadInputTokens: 35, isReviewer: false, turnTimestamp: null },
    ] as Parameters<typeof insertAttributedTokenUsage>[0];

    const result = await insertAttributedTokenUsage(records);
    expect(mockPrisma.tokenUsageRecord.deleteMany).toHaveBeenCalledWith({
      where: { sourceSessionId: { in: ["sess-1"] } },
    });
    expect(mockPrisma.tokenUsageRecord.createMany).toHaveBeenCalledWith({ data: records });
    expect(result).toEqual({ inserted: 2 });
  });

  it("skips delete when no sourceSessionId", async () => {
    mockPrisma.tokenUsageRecord.createMany.mockResolvedValue({ count: 1 });

    const records = [
      { sourceSessionId: null, companyUuid, agentUuid, sessionUuid: "s1", projectUuid: null, entityType: "task", entityUuid: taskUuidA, inputTokens: 10, outputTokens: 20, cacheCreationInputTokens: 0, cacheReadInputTokens: 0, isReviewer: false, turnTimestamp: null },
    ] as Parameters<typeof insertAttributedTokenUsage>[0];

    const result = await insertAttributedTokenUsage(records);
    expect(mockPrisma.tokenUsageRecord.deleteMany).not.toHaveBeenCalled();
    expect(result).toEqual({ inserted: 1 });
  });
});

