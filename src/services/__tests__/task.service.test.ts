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
      create: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
    },
    taskDependency: {
      findMany: vi.fn(),
      create: vi.fn(),
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

vi.mock("@/services/mention.service", () => ({
  parseMentions: vi.fn().mockReturnValue([]),
  createMentions: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/services/activity.service", () => ({
  createActivity: vi.fn().mockResolvedValue(undefined),
}));

// ===== Import under test (after mocks) =====

import {
  listTasks,
  getTask,
  createTask,
  claimTask,
  releaseTask,
  deleteTask,
  markAcceptanceCriteria,
  reportCriteriaSelfCheck,
  checkAcceptanceCriteriaGate,
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
