import { vi, describe, it, expect, beforeEach } from "vitest";
import {
  makeTask,
  makeAcceptanceCriterion,
  authContexts,
  resetFixtureCounter,
} from "@/__test-utils__/fixtures";

// ===== Module mocks (hoisted) =====

const mockPrisma = vi.hoisted(() => {
  const txProxy = new Proxy(
    {},
    {
      get(_target, prop) {
        // Return the same mock objects as the top-level prisma mock
        // so that transaction callbacks use the same mocked methods
        return (mockPrisma as Record<string, unknown>)[prop as string];
      },
    },
  );

  return {
    task: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
      count: vi.fn(),
    },
    comment: {
      count: vi.fn(),
    },
    acceptanceCriterion: {
      findMany: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    taskDependency: {
      findMany: vi.fn(),
      create: vi.fn(),
      deleteMany: vi.fn(),
    },
    sessionTaskCheckin: {
      findMany: vi.fn(),
    },
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(txProxy)),
  };
});

vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));

const mockEventBus = vi.hoisted(() => ({
  emitChange: vi.fn(),
}));
vi.mock("@/lib/event-bus", () => ({ eventBus: mockEventBus }));

const mockUuidResolver = vi.hoisted(() => ({
  formatAssigneeComplete: vi.fn().mockResolvedValue(null),
  formatCreatedBy: vi.fn().mockResolvedValue({ type: "user", uuid: "u1", name: "Test User" }),
  batchGetActorNames: vi.fn().mockResolvedValue(new Map()),
  batchFormatCreatedBy: vi.fn().mockResolvedValue(new Map()),
}));
vi.mock("@/lib/uuid-resolver", () => mockUuidResolver);

const mockCommentService = vi.hoisted(() => ({
  batchCommentCounts: vi.fn().mockResolvedValue({}),
}));
vi.mock("@/services/comment.service", () => mockCommentService);

const mockMentionService = vi.hoisted(() => ({
  parseMentions: vi.fn().mockReturnValue([]),
  createMentions: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/services/mention.service", () => mockMentionService);

const mockActivityService = vi.hoisted(() => ({
  createActivity: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("@/services/activity.service", () => mockActivityService);

// ===== Import under test (after mocks) =====

import {
  listTasks,
  getTask,
  createTask,
  claimTask,
  releaseTask,
  deleteTask,
  updateTask,
  markAcceptanceCriteria,
  reportCriteriaSelfCheck,
  checkAcceptanceCriteriaGate,
  createAcceptanceCriteria,
} from "@/services/task.service";
import { AlreadyClaimedError, NotClaimedError } from "@/lib/errors";

// ===== Helpers =====

const COMPANY_UUID = authContexts.user.companyUuid;
const PROJECT_UUID = "00000000-0000-0000-0000-000000000010";
const TASK_UUID = "00000000-0000-0000-0000-000000000099";

function rawTask(overrides: Record<string, unknown> = {}) {
  return makeTask({
    uuid: TASK_UUID,
    companyUuid: COMPANY_UUID,
    projectUuid: PROJECT_UUID,
    ...overrides,
  });
}

function rawTaskWithRelations(overrides: Record<string, unknown> = {}) {
  return {
    ...rawTask(overrides),
    project: { uuid: PROJECT_UUID, name: "Test Project" },
    dependsOn: [],
    dependedBy: [],
    acceptanceCriteriaItems: [],
  };
}

// ===== Tests =====

beforeEach(() => {
  vi.clearAllMocks();
  resetFixtureCounter();
});

// ---------- listTasks ----------

describe("listTasks", () => {
  it("returns paginated tasks with total count", async () => {
    const task1 = rawTask({ uuid: "t1" });
    const task2 = rawTask({ uuid: "t2" });
    mockPrisma.task.findMany.mockResolvedValue([task1, task2]);
    mockPrisma.task.count.mockResolvedValue(5);
    mockCommentService.batchCommentCounts.mockResolvedValue({});
    mockUuidResolver.batchGetActorNames.mockResolvedValue(new Map());
    mockUuidResolver.batchFormatCreatedBy.mockResolvedValue(
      new Map([
        [task1.createdByUuid, { type: "user", uuid: task1.createdByUuid, name: "User" }],
        [task2.createdByUuid, { type: "user", uuid: task2.createdByUuid, name: "User" }],
      ]),
    );

    const result = await listTasks({
      companyUuid: COMPANY_UUID,
      projectUuid: PROJECT_UUID,
      skip: 0,
      take: 10,
    });

    expect(result.total).toBe(5);
    expect(result.tasks).toHaveLength(2);
    expect(mockPrisma.task.findMany).toHaveBeenCalledOnce();
    expect(mockPrisma.task.count).toHaveBeenCalledOnce();
  });

  it("passes status filter to prisma where clause", async () => {
    mockPrisma.task.findMany.mockResolvedValue([]);
    mockPrisma.task.count.mockResolvedValue(0);

    await listTasks({
      companyUuid: COMPANY_UUID,
      projectUuid: PROJECT_UUID,
      skip: 0,
      take: 10,
      status: "in_progress",
    });

    const whereArg = mockPrisma.task.findMany.mock.calls[0][0].where;
    expect(whereArg.status).toBe("in_progress");
  });

  it("passes priority filter to prisma where clause", async () => {
    mockPrisma.task.findMany.mockResolvedValue([]);
    mockPrisma.task.count.mockResolvedValue(0);

    await listTasks({
      companyUuid: COMPANY_UUID,
      projectUuid: PROJECT_UUID,
      skip: 0,
      take: 10,
      priority: "high",
    });

    const whereArg = mockPrisma.task.findMany.mock.calls[0][0].where;
    expect(whereArg.priority).toBe("high");
  });

  it("does not include status/priority in where when not provided", async () => {
    mockPrisma.task.findMany.mockResolvedValue([]);
    mockPrisma.task.count.mockResolvedValue(0);

    await listTasks({
      companyUuid: COMPANY_UUID,
      projectUuid: PROJECT_UUID,
      skip: 0,
      take: 10,
    });

    const whereArg = mockPrisma.task.findMany.mock.calls[0][0].where;
    expect(whereArg).not.toHaveProperty("status");
    expect(whereArg).not.toHaveProperty("priority");
  });

  it("uses batch comment counts for all returned tasks", async () => {
    const task1 = rawTask({ uuid: "t1" });
    mockPrisma.task.findMany.mockResolvedValue([task1]);
    mockPrisma.task.count.mockResolvedValue(1);
    mockCommentService.batchCommentCounts.mockResolvedValue({ t1: 3 });
    mockUuidResolver.batchGetActorNames.mockResolvedValue(new Map());
    mockUuidResolver.batchFormatCreatedBy.mockResolvedValue(new Map());

    const result = await listTasks({
      companyUuid: COMPANY_UUID,
      projectUuid: PROJECT_UUID,
      skip: 0,
      take: 10,
    });

    expect(mockCommentService.batchCommentCounts).toHaveBeenCalledWith(
      COMPANY_UUID,
      "task",
      ["t1"],
    );
    expect(result.tasks[0].commentCount).toBe(3);
  });
});

// ---------- getTask ----------

describe("getTask", () => {
  it("returns formatted task with deps and criteria when found", async () => {
    const task = rawTaskWithRelations();
    mockPrisma.task.findFirst.mockResolvedValue(task);
    mockPrisma.comment.count.mockResolvedValue(2);

    const result = await getTask(COMPANY_UUID, TASK_UUID);

    expect(result).not.toBeNull();
    expect(result!.uuid).toBe(TASK_UUID);
    expect(result!.commentCount).toBe(2);
    expect(result!.dependsOn).toEqual([]);
    expect(result!.dependedBy).toEqual([]);
    expect(result!.acceptanceCriteriaItems).toEqual([]);
  });

  it("returns null when task not found", async () => {
    mockPrisma.task.findFirst.mockResolvedValue(null);

    const result = await getTask(COMPANY_UUID, "nonexistent");
    expect(result).toBeNull();
  });

  it("scopes query by companyUuid", async () => {
    mockPrisma.task.findFirst.mockResolvedValue(null);

    await getTask(COMPANY_UUID, TASK_UUID);

    expect(mockPrisma.task.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { uuid: TASK_UUID, companyUuid: COMPANY_UUID },
      }),
    );
  });

  it("formats dependency info from nested relations", async () => {
    const task = rawTaskWithRelations({
      dependsOn: [
        { dependsOn: { uuid: "dep1", title: "Dep Task", status: "done" } },
      ],
      dependedBy: [
        { task: { uuid: "rev1", title: "Reverse Dep", status: "open" } },
      ],
    });
    // Remove the overrides from the top-level so they only appear in the relation fields
    delete (task as Record<string, unknown>)["dependsOn"];
    delete (task as Record<string, unknown>)["dependedBy"];
    const taskWithDeps = {
      ...rawTask(),
      project: { uuid: PROJECT_UUID, name: "Test Project" },
      dependsOn: [
        { dependsOn: { uuid: "dep1", title: "Dep Task", status: "done" } },
      ],
      dependedBy: [
        { task: { uuid: "rev1", title: "Reverse Dep", status: "open" } },
      ],
      acceptanceCriteriaItems: [],
    };
    mockPrisma.task.findFirst.mockResolvedValue(taskWithDeps);
    mockPrisma.comment.count.mockResolvedValue(0);

    const result = await getTask(COMPANY_UUID, TASK_UUID);

    expect(result!.dependsOn).toEqual([
      { uuid: "dep1", title: "Dep Task", status: "done" },
    ]);
    expect(result!.dependedBy).toEqual([
      { uuid: "rev1", title: "Reverse Dep", status: "open" },
    ]);
  });

  it("formats acceptance criteria items", async () => {
    const criterion = makeAcceptanceCriterion({
      taskUuid: TASK_UUID,
      status: "passed",
      markedAt: new Date("2026-02-01"),
      devMarkedAt: null,
    });
    const task = {
      ...rawTask(),
      project: { uuid: PROJECT_UUID, name: "Test Project" },
      dependsOn: [],
      dependedBy: [],
      acceptanceCriteriaItems: [criterion],
    };
    mockPrisma.task.findFirst.mockResolvedValue(task);
    mockPrisma.comment.count.mockResolvedValue(0);

    const result = await getTask(COMPANY_UUID, TASK_UUID);

    expect(result!.acceptanceCriteriaItems).toHaveLength(1);
    expect(result!.acceptanceCriteriaItems[0].status).toBe("passed");
    expect(result!.acceptanceCriteriaItems[0].markedAt).toBe("2026-02-01T00:00:00.000Z");
    expect(result!.acceptanceCriteriaItems[0].devMarkedAt).toBeNull();
  });
});

// ---------- createTask ----------

describe("createTask", () => {
  it("creates a task with correct defaults", async () => {
    const created = rawTask({ status: "open", priority: "medium" });
    mockPrisma.task.create.mockResolvedValue(created);

    const result = await createTask({
      companyUuid: COMPANY_UUID,
      projectUuid: PROJECT_UUID,
      title: "New Task",
      createdByUuid: authContexts.user.actorUuid,
    });

    expect(result.uuid).toBe(TASK_UUID);
    expect(result.status).toBe("open");

    const createData = mockPrisma.task.create.mock.calls[0][0].data;
    expect(createData.status).toBe("open");
    expect(createData.priority).toBe("medium");
    expect(createData.companyUuid).toBe(COMPANY_UUID);
    expect(createData.projectUuid).toBe(PROJECT_UUID);
    expect(createData.title).toBe("New Task");
  });

  it("uses provided priority instead of default", async () => {
    mockPrisma.task.create.mockResolvedValue(rawTask({ priority: "high" }));

    await createTask({
      companyUuid: COMPANY_UUID,
      projectUuid: PROJECT_UUID,
      title: "High Priority",
      priority: "high",
      createdByUuid: authContexts.user.actorUuid,
    });

    const createData = mockPrisma.task.create.mock.calls[0][0].data;
    expect(createData.priority).toBe("high");
  });

  it("emits a change event after creation", async () => {
    mockPrisma.task.create.mockResolvedValue(rawTask());

    await createTask({
      companyUuid: COMPANY_UUID,
      projectUuid: PROJECT_UUID,
      title: "Task",
      createdByUuid: authContexts.user.actorUuid,
    });

    expect(mockEventBus.emitChange).toHaveBeenCalledWith(
      expect.objectContaining({
        companyUuid: COMPANY_UUID,
        projectUuid: PROJECT_UUID,
        entityType: "task",
        action: "created",
      }),
    );
  });

  it("passes optional fields (description, storyPoints, acceptanceCriteria, proposalUuid)", async () => {
    mockPrisma.task.create.mockResolvedValue(rawTask());

    await createTask({
      companyUuid: COMPANY_UUID,
      projectUuid: PROJECT_UUID,
      title: "Task",
      description: "Some desc",
      storyPoints: 5,
      acceptanceCriteria: "- [ ] criterion",
      proposalUuid: "prop-uuid",
      createdByUuid: authContexts.user.actorUuid,
    });

    const createData = mockPrisma.task.create.mock.calls[0][0].data;
    expect(createData.description).toBe("Some desc");
    expect(createData.storyPoints).toBe(5);
    expect(createData.acceptanceCriteria).toBe("- [ ] criterion");
    expect(createData.proposalUuid).toBe("prop-uuid");
  });
});

// ---------- claimTask ----------

describe("claimTask", () => {
  it("claims an open task (sets status to assigned)", async () => {
    const claimed = {
      ...rawTask({ status: "assigned", assigneeType: "agent", assigneeUuid: "a1" }),
      project: { uuid: PROJECT_UUID, name: "Test Project" },
    };
    mockPrisma.task.update.mockResolvedValue(claimed);

    const result = await claimTask({
      taskUuid: TASK_UUID,
      companyUuid: COMPANY_UUID,
      assigneeType: "agent",
      assigneeUuid: "a1",
    });

    expect(result.status).toBe("assigned");
    expect(mockPrisma.task.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { uuid: TASK_UUID, status: "open" },
        data: expect.objectContaining({
          status: "assigned",
          assigneeType: "agent",
          assigneeUuid: "a1",
        }),
      }),
    );
  });

  it("throws AlreadyClaimedError when task is not open (Prisma P2025)", async () => {
    mockPrisma.task.update.mockRejectedValue({ code: "P2025" });

    await expect(
      claimTask({
        taskUuid: TASK_UUID,
        companyUuid: COMPANY_UUID,
        assigneeType: "agent",
        assigneeUuid: "a1",
      }),
    ).rejects.toThrow(AlreadyClaimedError);
  });

  it("re-throws non-P2025 errors", async () => {
    const dbError = new Error("DB connection lost");
    mockPrisma.task.update.mockRejectedValue(dbError);

    await expect(
      claimTask({
        taskUuid: TASK_UUID,
        companyUuid: COMPANY_UUID,
        assigneeType: "agent",
        assigneeUuid: "a1",
      }),
    ).rejects.toThrow("DB connection lost");
  });

  it("emits change event on successful claim", async () => {
    const claimed = {
      ...rawTask({ status: "assigned" }),
      project: { uuid: PROJECT_UUID, name: "Test Project" },
    };
    mockPrisma.task.update.mockResolvedValue(claimed);

    await claimTask({
      taskUuid: TASK_UUID,
      companyUuid: COMPANY_UUID,
      assigneeType: "agent",
      assigneeUuid: "a1",
    });

    expect(mockEventBus.emitChange).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: "task",
        action: "updated",
      }),
    );
  });

  it("passes assignedByUuid when provided", async () => {
    const claimed = {
      ...rawTask({ status: "assigned" }),
      project: { uuid: PROJECT_UUID, name: "Test Project" },
    };
    mockPrisma.task.update.mockResolvedValue(claimed);

    await claimTask({
      taskUuid: TASK_UUID,
      companyUuid: COMPANY_UUID,
      assigneeType: "agent",
      assigneeUuid: "a1",
      assignedByUuid: "user-123",
    });

    const updateData = mockPrisma.task.update.mock.calls[0][0].data;
    expect(updateData.assignedByUuid).toBe("user-123");
  });
});

// ---------- releaseTask ----------

describe("releaseTask", () => {
  it("releases an assigned task (reverts to open, clears assignee)", async () => {
    const released = {
      ...rawTask({ status: "open", assigneeType: null, assigneeUuid: null }),
      project: { uuid: PROJECT_UUID, name: "Test Project" },
    };
    mockPrisma.task.update.mockResolvedValue(released);

    const result = await releaseTask(TASK_UUID);

    expect(result.status).toBe("open");
    expect(mockPrisma.task.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { uuid: TASK_UUID, status: "assigned" },
        data: expect.objectContaining({
          status: "open",
          assigneeType: null,
          assigneeUuid: null,
          assignedAt: null,
          assignedByUuid: null,
        }),
      }),
    );
  });

  it("throws NotClaimedError when task is not assigned (Prisma P2025)", async () => {
    mockPrisma.task.update.mockRejectedValue({ code: "P2025" });

    await expect(releaseTask(TASK_UUID)).rejects.toThrow(NotClaimedError);
  });

  it("re-throws non-P2025 errors", async () => {
    const dbError = new Error("Timeout");
    mockPrisma.task.update.mockRejectedValue(dbError);

    await expect(releaseTask(TASK_UUID)).rejects.toThrow("Timeout");
  });

  it("emits change event on successful release", async () => {
    const released = {
      ...rawTask({ status: "open" }),
      project: { uuid: PROJECT_UUID, name: "Test Project" },
    };
    mockPrisma.task.update.mockResolvedValue(released);

    await releaseTask(TASK_UUID);

    expect(mockEventBus.emitChange).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: "task",
        action: "updated",
      }),
    );
  });
});

// ---------- deleteTask ----------

describe("deleteTask", () => {
  it("deletes the task by uuid", async () => {
    const task = rawTask();
    mockPrisma.task.delete.mockResolvedValue(task);

    const result = await deleteTask(TASK_UUID);

    expect(result.uuid).toBe(TASK_UUID);
    expect(mockPrisma.task.delete).toHaveBeenCalledWith({ where: { uuid: TASK_UUID } });
  });

  it("emits change event with action deleted", async () => {
    const task = rawTask();
    mockPrisma.task.delete.mockResolvedValue(task);

    await deleteTask(TASK_UUID);

    expect(mockEventBus.emitChange).toHaveBeenCalledWith(
      expect.objectContaining({
        companyUuid: COMPANY_UUID,
        entityType: "task",
        action: "deleted",
      }),
    );
  });
});

// ---------- markAcceptanceCriteria ----------

describe("markAcceptanceCriteria", () => {
  const criterionUuid = "crit-0001";

  it("validates task belongs to company and updates criteria", async () => {
    const task = rawTask();
    mockPrisma.task.findFirst
      .mockResolvedValueOnce(task)   // validation in markAcceptanceCriteria
      .mockResolvedValueOnce(task);  // validation in getAcceptanceStatus
    mockPrisma.acceptanceCriterion.findMany
      .mockResolvedValueOnce([{ uuid: criterionUuid }])  // pre-validation
      .mockResolvedValueOnce([                            // getAcceptanceStatus return
        makeAcceptanceCriterion({ uuid: criterionUuid, status: "passed", taskUuid: TASK_UUID }),
      ]);
    mockPrisma.acceptanceCriterion.update.mockResolvedValue({});

    const result = await markAcceptanceCriteria(
      COMPANY_UUID,
      TASK_UUID,
      [{ uuid: criterionUuid, status: "passed", evidence: "Looks good" }],
      { type: "user", actorUuid: authContexts.user.actorUuid },
    );

    expect(result.items).toHaveLength(1);
    expect(mockPrisma.acceptanceCriterion.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { uuid: criterionUuid },
        data: expect.objectContaining({
          status: "passed",
          evidence: "Looks good",
          markedByType: "user",
          markedBy: authContexts.user.actorUuid,
        }),
      }),
    );
  });

  it("throws when task not found for company", async () => {
    mockPrisma.task.findFirst.mockResolvedValue(null);

    await expect(
      markAcceptanceCriteria(
        COMPANY_UUID,
        TASK_UUID,
        [{ uuid: criterionUuid, status: "passed" }],
        { type: "user", actorUuid: "u1" },
      ),
    ).rejects.toThrow("Task not found");
  });

  it("throws when criterion does not belong to task", async () => {
    mockPrisma.task.findFirst.mockResolvedValue(rawTask());
    mockPrisma.acceptanceCriterion.findMany.mockResolvedValue([]); // no matching criteria

    await expect(
      markAcceptanceCriteria(
        COMPANY_UUID,
        TASK_UUID,
        [{ uuid: "wrong-crit", status: "passed" }],
        { type: "user", actorUuid: "u1" },
      ),
    ).rejects.toThrow(/does not belong to task/);
  });

  it("emits change event after marking", async () => {
    const task = rawTask();
    mockPrisma.task.findFirst
      .mockResolvedValueOnce(task)
      .mockResolvedValueOnce(task);
    mockPrisma.acceptanceCriterion.findMany
      .mockResolvedValueOnce([{ uuid: criterionUuid }])
      .mockResolvedValueOnce([
        makeAcceptanceCriterion({ uuid: criterionUuid, status: "passed", taskUuid: TASK_UUID }),
      ]);
    mockPrisma.acceptanceCriterion.update.mockResolvedValue({});

    await markAcceptanceCriteria(
      COMPANY_UUID,
      TASK_UUID,
      [{ uuid: criterionUuid, status: "passed" }],
      { type: "user", actorUuid: "u1" },
    );

    expect(mockEventBus.emitChange).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: "task",
        entityUuid: TASK_UUID,
        action: "updated",
      }),
    );
  });
});

// ---------- reportCriteriaSelfCheck ----------

describe("reportCriteriaSelfCheck", () => {
  const criterionUuid = "crit-0002";

  it("updates devStatus fields on criteria", async () => {
    const task = rawTask();
    mockPrisma.task.findFirst
      .mockResolvedValueOnce(task)
      .mockResolvedValueOnce(task);
    mockPrisma.acceptanceCriterion.findMany
      .mockResolvedValueOnce([{ uuid: criterionUuid }])
      .mockResolvedValueOnce([
        makeAcceptanceCriterion({ uuid: criterionUuid, devStatus: "passed", taskUuid: TASK_UUID }),
      ]);
    mockPrisma.acceptanceCriterion.update.mockResolvedValue({});

    const result = await reportCriteriaSelfCheck(
      COMPANY_UUID,
      TASK_UUID,
      [{ uuid: criterionUuid, devStatus: "passed", devEvidence: "Tests pass" }],
      { type: "agent", actorUuid: authContexts.agent.actorUuid },
    );

    expect(result.items).toHaveLength(1);
    expect(mockPrisma.acceptanceCriterion.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { uuid: criterionUuid },
        data: expect.objectContaining({
          devStatus: "passed",
          devEvidence: "Tests pass",
          devMarkedByType: "agent",
          devMarkedBy: authContexts.agent.actorUuid,
        }),
      }),
    );
  });

  it("throws when task not found", async () => {
    mockPrisma.task.findFirst.mockResolvedValue(null);

    await expect(
      reportCriteriaSelfCheck(
        COMPANY_UUID,
        TASK_UUID,
        [{ uuid: "c1", devStatus: "passed" }],
        { type: "agent", actorUuid: "a1" },
      ),
    ).rejects.toThrow("Task not found");
  });

  it("throws when criterion does not belong to task", async () => {
    mockPrisma.task.findFirst.mockResolvedValue(rawTask());
    mockPrisma.acceptanceCriterion.findMany.mockResolvedValue([]);

    await expect(
      reportCriteriaSelfCheck(
        COMPANY_UUID,
        TASK_UUID,
        [{ uuid: "wrong-crit", devStatus: "failed" }],
        { type: "agent", actorUuid: "a1" },
      ),
    ).rejects.toThrow(/does not belong to task/);
  });

  it("sets devEvidence to null when not provided", async () => {
    const task = rawTask();
    mockPrisma.task.findFirst
      .mockResolvedValueOnce(task)
      .mockResolvedValueOnce(task);
    mockPrisma.acceptanceCriterion.findMany
      .mockResolvedValueOnce([{ uuid: "c1" }])
      .mockResolvedValueOnce([
        makeAcceptanceCriterion({ uuid: "c1", devStatus: "passed", taskUuid: TASK_UUID }),
      ]);
    mockPrisma.acceptanceCriterion.update.mockResolvedValue({});

    await reportCriteriaSelfCheck(
      COMPANY_UUID,
      TASK_UUID,
      [{ uuid: "c1", devStatus: "passed" }],
      { type: "agent", actorUuid: "a1" },
    );

    const updateData = mockPrisma.acceptanceCriterion.update.mock.calls[0][0].data;
    expect(updateData.devEvidence).toBeNull();
  });
});

// ---------- checkAcceptanceCriteriaGate ----------

describe("checkAcceptanceCriteriaGate", () => {
  it("allows transition when no criteria exist (backward compat)", async () => {
    mockPrisma.acceptanceCriterion.findMany.mockResolvedValue([]);

    const result = await checkAcceptanceCriteriaGate(TASK_UUID);

    expect(result.allowed).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it("allows transition when all required criteria are passed", async () => {
    mockPrisma.acceptanceCriterion.findMany.mockResolvedValue([
      makeAcceptanceCriterion({ required: true, status: "passed" }),
      makeAcceptanceCriterion({ required: true, status: "passed" }),
      makeAcceptanceCriterion({ required: false, status: "pending" }),
    ]);

    const result = await checkAcceptanceCriteriaGate(TASK_UUID);

    expect(result.allowed).toBe(true);
  });

  it("blocks transition when required criteria are not all passed", async () => {
    mockPrisma.acceptanceCriterion.findMany.mockResolvedValue([
      makeAcceptanceCriterion({ uuid: "c1", required: true, status: "passed" }),
      makeAcceptanceCriterion({ uuid: "c2", required: true, status: "pending" }),
    ]);

    const result = await checkAcceptanceCriteriaGate(TASK_UUID);

    expect(result.allowed).toBe(false);
    expect(result.reason).toContain("Not all required acceptance criteria are passed");
    expect(result.summary).toBeDefined();
    expect(result.summary!.requiredPending).toBe(1);
  });

  it("blocks transition when required criteria are failed", async () => {
    mockPrisma.acceptanceCriterion.findMany.mockResolvedValue([
      makeAcceptanceCriterion({ uuid: "c1", required: true, status: "failed" }),
      makeAcceptanceCriterion({ uuid: "c2", required: true, status: "passed" }),
    ]);

    const result = await checkAcceptanceCriteriaGate(TASK_UUID);

    expect(result.allowed).toBe(false);
    expect(result.summary!.requiredFailed).toBe(1);
  });

  it("returns unresolved criteria (required items that are not passed)", async () => {
    const pendingCrit = makeAcceptanceCriterion({
      uuid: "c-pending",
      required: true,
      status: "pending",
      description: "Must do X",
    });
    const failedCrit = makeAcceptanceCriterion({
      uuid: "c-failed",
      required: true,
      status: "failed",
      description: "Must do Y",
    });
    const passedCrit = makeAcceptanceCriterion({
      uuid: "c-passed",
      required: true,
      status: "passed",
    });

    mockPrisma.acceptanceCriterion.findMany.mockResolvedValue([
      passedCrit,
      pendingCrit,
      failedCrit,
    ]);

    const result = await checkAcceptanceCriteriaGate(TASK_UUID);

    expect(result.allowed).toBe(false);
    expect(result.unresolvedCriteria).toHaveLength(2);
    const uuids = result.unresolvedCriteria!.map((c) => c.uuid);
    expect(uuids).toContain("c-pending");
    expect(uuids).toContain("c-failed");
  });

  it("allows when only optional criteria are pending/failed", async () => {
    mockPrisma.acceptanceCriterion.findMany.mockResolvedValue([
      makeAcceptanceCriterion({ required: true, status: "passed" }),
      makeAcceptanceCriterion({ required: false, status: "pending" }),
      makeAcceptanceCriterion({ required: false, status: "failed" }),
    ]);

    const result = await checkAcceptanceCriteriaGate(TASK_UUID);

    expect(result.allowed).toBe(true);
  });
});

// ---------- addTaskDependency ----------

describe("addTaskDependency", () => {
  const taskUuid1 = "task-0001";
  const taskUuid2 = "task-0002";
  const taskUuid3 = "task-0003";

  it("should throw when task depends on itself", async () => {
    await expect(
      (await import("@/services/task.service")).addTaskDependency(
        COMPANY_UUID,
        taskUuid1,
        taskUuid1,
      ),
    ).rejects.toThrow("A task cannot depend on itself");
  });

  it("should throw when task not found", async () => {
    mockPrisma.task.findFirst
      .mockResolvedValueOnce(null) // task not found
      .mockResolvedValueOnce(rawTask({ uuid: taskUuid2 })); // dependsOn exists

    await expect(
      (await import("@/services/task.service")).addTaskDependency(
        COMPANY_UUID,
        "nonexistent",
        taskUuid2,
      ),
    ).rejects.toThrow("Task not found");
  });

  it("should throw when dependency task not found", async () => {
    mockPrisma.task.findFirst
      .mockResolvedValueOnce(rawTask({ uuid: taskUuid1 }))
      .mockResolvedValueOnce(null); // dependsOn not found

    await expect(
      (await import("@/services/task.service")).addTaskDependency(
        COMPANY_UUID,
        taskUuid1,
        "nonexistent",
      ),
    ).rejects.toThrow("Dependency task not found");
  });

  it("should throw when tasks belong to different projects", async () => {
    mockPrisma.task.findFirst
      .mockResolvedValueOnce(rawTask({ uuid: taskUuid1, projectUuid: "proj-a" }))
      .mockResolvedValueOnce(rawTask({ uuid: taskUuid2, projectUuid: "proj-b" }));

    await expect(
      (await import("@/services/task.service")).addTaskDependency(
        COMPANY_UUID,
        taskUuid1,
        taskUuid2,
      ),
    ).rejects.toThrow("Tasks must belong to the same project");
  });

  it("should throw when adding dependency would create a cycle", async () => {
    // Task1 -> Task2 -> Task3, trying to add Task3 -> Task1 (cycle)
    mockPrisma.task.findFirst
      .mockResolvedValueOnce(rawTask({ uuid: taskUuid3, projectUuid: PROJECT_UUID }))
      .mockResolvedValueOnce(rawTask({ uuid: taskUuid1, projectUuid: PROJECT_UUID }));

    // Existing edges: task1 -> task2, task2 -> task3
    mockPrisma.taskDependency.findMany.mockResolvedValue([
      { taskUuid: taskUuid1, dependsOnUuid: taskUuid2 },
      { taskUuid: taskUuid2, dependsOnUuid: taskUuid3 },
    ]);

    await expect(
      (await import("@/services/task.service")).addTaskDependency(
        COMPANY_UUID,
        taskUuid3,
        taskUuid1,
      ),
    ).rejects.toThrow("Adding this dependency would create a cycle");
  });

  it("should create dependency when no cycle detected", async () => {
    mockPrisma.task.findFirst
      .mockResolvedValueOnce(rawTask({ uuid: taskUuid1, projectUuid: PROJECT_UUID }))
      .mockResolvedValueOnce(rawTask({ uuid: taskUuid2, projectUuid: PROJECT_UUID }));
    mockPrisma.taskDependency.findMany.mockResolvedValue([]);
    mockPrisma.taskDependency.create.mockResolvedValue({
      taskUuid: taskUuid1,
      dependsOnUuid: taskUuid2,
      createdAt: new Date("2026-03-01"),
    });

    const result = await (await import("@/services/task.service")).addTaskDependency(
      COMPANY_UUID,
      taskUuid1,
      taskUuid2,
    );

    expect(result.taskUuid).toBe(taskUuid1);
    expect(result.dependsOnUuid).toBe(taskUuid2);
    expect(mockPrisma.taskDependency.create).toHaveBeenCalledWith({
      data: { taskUuid: taskUuid1, dependsOnUuid: taskUuid2 },
    });
  });
});

// ---------- removeTaskDependency ----------

describe("removeTaskDependency", () => {
  it("should throw when task not found", async () => {
    mockPrisma.task.findFirst.mockResolvedValue(null);

    await expect(
      (await import("@/services/task.service")).removeTaskDependency(
        COMPANY_UUID,
        "nonexistent",
        "dep-uuid",
      ),
    ).rejects.toThrow("Task not found");
  });

  it("should delete dependency", async () => {
    mockPrisma.task.findFirst.mockResolvedValue(rawTask({ uuid: "t1" }));
    mockPrisma.taskDependency.deleteMany.mockResolvedValue({ count: 1 });

    await (await import("@/services/task.service")).removeTaskDependency(
      COMPANY_UUID,
      "t1",
      "dep-uuid",
    );

    expect(mockPrisma.taskDependency.deleteMany).toHaveBeenCalledWith({
      where: { taskUuid: "t1", dependsOnUuid: "dep-uuid" },
    });
  });
});

// ---------- computeAcceptanceStatus ----------

describe("computeAcceptanceStatus", () => {
  it("should return not_started when no items", async () => {
    const { computeAcceptanceStatus } = await import("@/services/task.service");
    const result = computeAcceptanceStatus([]);
    expect(result.status).toBe("not_started");
    expect(result.summary.total).toBe(0);
  });

  it("should return failed when any required criterion failed", async () => {
    const { computeAcceptanceStatus } = await import("@/services/task.service");
    const result = computeAcceptanceStatus([
      { required: true, status: "passed" },
      { required: true, status: "failed" },
    ]);
    expect(result.status).toBe("failed");
    expect(result.summary.requiredFailed).toBe(1);
  });

  it("should return passed when all required criteria passed", async () => {
    const { computeAcceptanceStatus } = await import("@/services/task.service");
    const result = computeAcceptanceStatus([
      { required: true, status: "passed" },
      { required: true, status: "passed" },
      { required: false, status: "pending" },
    ]);
    expect(result.status).toBe("passed");
    expect(result.summary.requiredPassed).toBe(2);
  });

  it("should return in_progress when some criteria evaluated but not all required passed", async () => {
    const { computeAcceptanceStatus } = await import("@/services/task.service");
    const result = computeAcceptanceStatus([
      { required: true, status: "passed" },
      { required: true, status: "pending" },
      { required: false, status: "failed" },
    ]);
    expect(result.status).toBe("in_progress");
  });

  it("should return not_started when all criteria pending", async () => {
    const { computeAcceptanceStatus } = await import("@/services/task.service");
    const result = computeAcceptanceStatus([
      { required: true, status: "pending" },
      { required: false, status: "pending" },
    ]);
    expect(result.status).toBe("not_started");
  });
});

// ---------- getTaskDependencies ----------

describe("getTaskDependencies", () => {
  it("should return dependencies for a task", async () => {
    const task = {
      ...rawTask({ uuid: "t1" }),
      dependsOn: [
        { dependsOn: { uuid: "dep1", title: "Dep 1", status: "done" } },
      ],
      dependedBy: [
        { task: { uuid: "rev1", title: "Rev 1", status: "open" } },
      ],
      acceptanceCriteriaItems: [],
    };
    mockPrisma.task.findFirst.mockResolvedValue(task);

    const result = await (await import("@/services/task.service")).getTaskDependencies(
      COMPANY_UUID,
      "t1",
    );

    expect(result.dependsOn).toHaveLength(1);
    expect(result.dependsOn[0].uuid).toBe("dep1");
    expect(result.dependedBy).toHaveLength(1);
    expect(result.dependedBy[0].uuid).toBe("rev1");
  });

  it("should throw when task not found", async () => {
    mockPrisma.task.findFirst.mockResolvedValue(null);

    await expect(
      (await import("@/services/task.service")).getTaskDependencies(
        COMPANY_UUID,
        "nonexistent",
      ),
    ).rejects.toThrow("Task not found");
  });
});

// ---------- getUnblockedTasks ----------

describe("getUnblockedTasks", () => {
  it("should return tasks without unresolved dependencies", async () => {
    const task1 = rawTask({ uuid: "t1", status: "open" });
    mockPrisma.task.findMany.mockResolvedValue([task1]);
    mockPrisma.task.count.mockResolvedValue(1);
    mockCommentService.batchCommentCounts.mockResolvedValue({});
    mockUuidResolver.batchGetActorNames.mockResolvedValue(new Map());
    mockUuidResolver.batchFormatCreatedBy.mockResolvedValue(
      new Map([[task1.createdByUuid, { type: "user", uuid: task1.createdByUuid, name: "User" }]]),
    );

    const result = await (await import("@/services/task.service")).getUnblockedTasks({
      companyUuid: COMPANY_UUID,
      projectUuid: PROJECT_UUID,
    });

    expect(result.tasks).toHaveLength(1);
    expect(result.total).toBe(1);
  });

  it("should filter for open/assigned status", async () => {
    mockPrisma.task.findMany.mockResolvedValue([]);
    mockPrisma.task.count.mockResolvedValue(0);

    await (await import("@/services/task.service")).getUnblockedTasks({
      companyUuid: COMPANY_UUID,
      projectUuid: PROJECT_UUID,
    });

    const whereArg = mockPrisma.task.findMany.mock.calls[0][0].where;
    expect(whereArg.status.in).toEqual(["open", "assigned"]);
  });
});

// ---------- checkDependenciesResolved ----------

describe("checkDependenciesResolved", () => {
  it("should return resolved=true when no dependencies", async () => {
    mockPrisma.taskDependency.findMany.mockResolvedValue([]);

    const result = await (await import("@/services/task.service")).checkDependenciesResolved(
      TASK_UUID,
    );

    expect(result.resolved).toBe(true);
    expect(result.blockers).toEqual([]);
  });

  it("should return resolved=true when all dependencies are done/closed", async () => {
    mockPrisma.taskDependency.findMany.mockResolvedValue([
      { dependsOn: { uuid: "d1", title: "Dep 1", status: "done", assigneeType: null, assigneeUuid: null } },
      { dependsOn: { uuid: "d2", title: "Dep 2", status: "closed", assigneeType: null, assigneeUuid: null } },
    ]);

    const result = await (await import("@/services/task.service")).checkDependenciesResolved(
      TASK_UUID,
    );

    expect(result.resolved).toBe(true);
    expect(result.blockers).toEqual([]);
  });

  it("should return resolved=false with blockers when dependencies unresolved", async () => {
    mockPrisma.taskDependency.findMany.mockResolvedValue([
      { dependsOn: { uuid: "d1", title: "Blocker Task", status: "in_progress", assigneeType: "agent", assigneeUuid: "a1" } },
    ]);
    mockPrisma.sessionTaskCheckin.findMany.mockResolvedValue([]);
    mockUuidResolver.batchGetActorNames.mockResolvedValue(new Map([["a1", "Agent 1"]]));

    const result = await (await import("@/services/task.service")).checkDependenciesResolved(
      TASK_UUID,
    );

    expect(result.resolved).toBe(false);
    expect(result.blockers).toHaveLength(1);
    expect(result.blockers[0].uuid).toBe("d1");
    expect(result.blockers[0].assignee).toEqual({
      type: "agent",
      uuid: "a1",
      name: "Agent 1",
    });
  });

  it("should include session checkin info in blockers", async () => {
    mockPrisma.taskDependency.findMany.mockResolvedValue([
      { dependsOn: { uuid: "d1", title: "Blocker", status: "in_progress", assigneeType: null, assigneeUuid: null } },
    ]);
    mockPrisma.sessionTaskCheckin.findMany.mockResolvedValue([
      { taskUuid: "d1", sessionUuid: "s1", session: { name: "worker-1" } },
    ]);
    mockUuidResolver.batchGetActorNames.mockResolvedValue(new Map());

    const result = await (await import("@/services/task.service")).checkDependenciesResolved(
      TASK_UUID,
    );

    expect(result.blockers[0].sessionCheckin).toEqual({
      sessionUuid: "s1",
      sessionName: "worker-1",
    });
  });
});

// ---------- getProjectTaskDependencies ----------

describe("getProjectTaskDependencies", () => {
  it("should return nodes and edges for project DAG", async () => {
    mockPrisma.task.findMany.mockResolvedValue([
      { uuid: "t1", title: "Task 1", status: "open", priority: "high" },
      { uuid: "t2", title: "Task 2", status: "done", priority: "medium" },
    ]);
    mockPrisma.taskDependency.findMany.mockResolvedValue([
      { taskUuid: "t2", dependsOnUuid: "t1" },
    ]);

    const result = await (await import("@/services/task.service")).getProjectTaskDependencies(
      COMPANY_UUID,
      PROJECT_UUID,
    );

    expect(result.nodes).toHaveLength(2);
    expect(result.nodes[0].uuid).toBe("t1");
    expect(result.edges).toHaveLength(1);
    expect(result.edges[0]).toEqual({ from: "t2", to: "t1" });
  });

  it("should return empty arrays when no tasks", async () => {
    mockPrisma.task.findMany.mockResolvedValue([]);
    mockPrisma.taskDependency.findMany.mockResolvedValue([]);

    const result = await (await import("@/services/task.service")).getProjectTaskDependencies(
      COMPANY_UUID,
      PROJECT_UUID,
    );

    expect(result.nodes).toEqual([]);
    expect(result.edges).toEqual([]);
  });
});

// ---------- resetAcceptanceCriterion ----------

describe("resetAcceptanceCriterion", () => {
  it("should reset criterion to pending", async () => {
    const task = rawTask();
    mockPrisma.task.findFirst.mockResolvedValue(task);
    mockPrisma.acceptanceCriterion.findFirst.mockResolvedValue(
      makeAcceptanceCriterion({ uuid: "c1", taskUuid: TASK_UUID })
    );
    mockPrisma.acceptanceCriterion.update.mockResolvedValue({});

    await (await import("@/services/task.service")).resetAcceptanceCriterion(
      COMPANY_UUID,
      TASK_UUID,
      "c1",
    );

    expect(mockPrisma.acceptanceCriterion.update).toHaveBeenCalledWith({
      where: { uuid: "c1" },
      data: expect.objectContaining({
        status: "pending",
        evidence: null,
        markedByType: null,
        markedBy: null,
        markedAt: null,
      }),
    });
    expect(mockEventBus.emitChange).toHaveBeenCalled();
  });

  it("should throw when task not found", async () => {
    mockPrisma.task.findFirst.mockResolvedValue(null);

    await expect(
      (await import("@/services/task.service")).resetAcceptanceCriterion(
        COMPANY_UUID,
        "nonexistent",
        "c1",
      ),
    ).rejects.toThrow("Task not found");
  });

  it("should throw when criterion not found for task", async () => {
    mockPrisma.task.findFirst.mockResolvedValue(rawTask());
    mockPrisma.acceptanceCriterion.findFirst.mockResolvedValue(null);

    await expect(
      (await import("@/services/task.service")).resetAcceptanceCriterion(
        COMPANY_UUID,
        TASK_UUID,
        "wrong-crit",
      ),
    ).rejects.toThrow("Criterion not found for this task");
  });
});

// ---------- getAcceptanceStatus ----------

describe("getAcceptanceStatus", () => {
  it("should return acceptance status and criteria items", async () => {
    const task = rawTask();
    mockPrisma.task.findFirst.mockResolvedValue(task);
    mockPrisma.acceptanceCriterion.findMany.mockResolvedValue([
      makeAcceptanceCriterion({ required: true, status: "passed" }),
      makeAcceptanceCriterion({ required: true, status: "pending" }),
    ]);

    const result = await (await import("@/services/task.service")).getAcceptanceStatus(
      COMPANY_UUID,
      TASK_UUID,
    );

    expect(result.items).toHaveLength(2);
    expect(result.status).toBe("in_progress");
    expect(result.summary.required).toBe(2);
  });

  it("should throw when task not found", async () => {
    mockPrisma.task.findFirst.mockResolvedValue(null);

    await expect(
      (await import("@/services/task.service")).getAcceptanceStatus(
        COMPANY_UUID,
        "nonexistent",
      ),
    ).rejects.toThrow("Task not found");
  });
});

// ---------- createAcceptanceCriteria ----------

describe("createAcceptanceCriteria", () => {
  it("should create multiple acceptance criteria", async () => {
    mockPrisma.acceptanceCriterion.create
      .mockResolvedValueOnce(makeAcceptanceCriterion({ uuid: "c1", description: "Criterion 1" }))
      .mockResolvedValueOnce(makeAcceptanceCriterion({ uuid: "c2", description: "Criterion 2" }));

    const result = await createAcceptanceCriteria(TASK_UUID, [
      { description: "Criterion 1", required: true },
      { description: "Criterion 2", required: false },
    ]);

    expect(result).toHaveLength(2);
    expect(mockPrisma.acceptanceCriterion.create).toHaveBeenCalledTimes(2);
  });

  it("should return empty array when no items provided", async () => {
    const result = await createAcceptanceCriteria(TASK_UUID, []);
    expect(result).toEqual([]);
  });

  it("should use default required=true when not specified", async () => {
    mockPrisma.acceptanceCriterion.create.mockResolvedValue(
      makeAcceptanceCriterion({ uuid: "c1" })
    );

    await createAcceptanceCriteria(TASK_UUID, [{ description: "Test" }]);

    const createData = mockPrisma.acceptanceCriterion.create.mock.calls[0][0].data;
    expect(createData.required).toBe(true);
  });

  it("should use index as sortOrder when not specified", async () => {
    mockPrisma.acceptanceCriterion.create
      .mockResolvedValueOnce(makeAcceptanceCriterion({ uuid: "c1" }))
      .mockResolvedValueOnce(makeAcceptanceCriterion({ uuid: "c2" }));

    await createAcceptanceCriteria(TASK_UUID, [
      { description: "First" },
      { description: "Second" },
    ]);

    expect(mockPrisma.acceptanceCriterion.create.mock.calls[0][0].data.sortOrder).toBe(0);
    expect(mockPrisma.acceptanceCriterion.create.mock.calls[1][0].data.sortOrder).toBe(1);
  });
});

// ---------- updateTask (mention processing) ----------

describe("updateTask", () => {
  it("should update task fields", async () => {
    mockPrisma.task.findUnique.mockResolvedValue(null);
    const updated = {
      ...rawTask({ title: "Updated Title", status: "in_progress" }),
      project: { uuid: PROJECT_UUID, name: "Test Project" },
    };
    mockPrisma.task.update.mockResolvedValue(updated);

    const result = await updateTask(TASK_UUID, {
      title: "Updated Title",
      status: "in_progress",
    });

    expect(result.title).toBe("Updated Title");
    expect(result.status).toBe("in_progress");
    expect(mockEventBus.emitChange).toHaveBeenCalled();
  });

  it("should reset acceptance criteria when moving from to_verify to other status", async () => {
    mockPrisma.task.findUnique.mockResolvedValue(null);
    const updated = {
      ...rawTask({ status: "in_progress" }),
      project: { uuid: PROJECT_UUID, name: "Test Project" },
    };
    mockPrisma.task.findUnique.mockResolvedValue({ status: "to_verify" });
    mockPrisma.task.update.mockResolvedValue(updated);
    mockPrisma.acceptanceCriterion.updateMany.mockResolvedValue({ count: 2 });

    await updateTask(TASK_UUID, { status: "in_progress" });

    expect(mockPrisma.acceptanceCriterion.updateMany).toHaveBeenCalledWith({
      where: { taskUuid: TASK_UUID },
      data: expect.objectContaining({
        status: "pending",
        devStatus: "pending",
      }),
    });
  });

  it("should NOT reset criteria when moving from to_verify to done", async () => {
    mockPrisma.task.findUnique.mockResolvedValue(null);
    const updated = {
      ...rawTask({ status: "done" }),
      project: { uuid: PROJECT_UUID, name: "Test Project" },
    };
    mockPrisma.task.findUnique.mockResolvedValue({ status: "to_verify" });
    mockPrisma.task.update.mockResolvedValue(updated);

    await updateTask(TASK_UUID, { status: "done" });

    expect(mockPrisma.acceptanceCriterion.updateMany).not.toHaveBeenCalled();
  });

  it("should process new mentions when description updated with actor context", async () => {
    const oldDesc = "Old description";
    const newDesc = "New description with @user[uuid1]";

    mockPrisma.task.findUnique.mockResolvedValue({ description: oldDesc });
    const updated = {
      ...rawTask({ description: newDesc }),
      project: { uuid: PROJECT_UUID, name: "Test Project" },
    };
    mockPrisma.task.update.mockResolvedValue(updated);

    mockMentionService.parseMentions
      .mockReturnValueOnce([]) // old mentions
      .mockReturnValueOnce([{ type: "user", uuid: "uuid1", displayName: "User 1" }]); // new mentions

    await updateTask(
      TASK_UUID,
      { description: newDesc },
      { actorType: "agent", actorUuid: "agent1" },
    );

    // Wait for async processing to complete
    await new Promise(resolve => setTimeout(resolve, 10));

    expect(mockMentionService.parseMentions).toHaveBeenCalledWith(oldDesc);
    expect(mockMentionService.parseMentions).toHaveBeenCalledWith(newDesc);
    expect(mockMentionService.createMentions).toHaveBeenCalled();
    expect(mockActivityService.createActivity).toHaveBeenCalled();
  });
});
