import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock prisma for wouldCreateCycle tests (accessed via addTaskDependency)
// vi.hoisted ensures the variable is available when vi.mock factory runs (hoisted)
const mockPrisma = vi.hoisted(() => ({
  task: {
    findFirst: vi.fn(),
  },
  taskDependency: {
    findMany: vi.fn(),
    create: vi.fn(),
  },
}));
vi.mock("@/lib/prisma", () => ({
  prisma: mockPrisma,
}));

// Mock event-bus (imported by task.service)
vi.mock("@/lib/event-bus", () => ({
  eventBus: {
    emitChange: vi.fn(),
  },
}));

// Mock uuid-resolver (imported by task.service)
vi.mock("@/lib/uuid-resolver", () => ({
  formatAssigneeComplete: vi.fn(),
  formatCreatedBy: vi.fn(),
  batchGetActorNames: vi.fn(),
  batchFormatCreatedBy: vi.fn(),
}));

// Mock comment.service (imported by task.service)
vi.mock("@/services/comment.service", () => ({
  batchCommentCounts: vi.fn(),
}));

// Mock mention.service (imported by task.service)
vi.mock("@/services/mention.service", () => ({
  parseMentions: vi.fn().mockReturnValue([]),
  createMentions: vi.fn(),
}));

// Mock activity.service (imported by task.service)
vi.mock("@/services/activity.service", () => ({
  createActivity: vi.fn(),
}));

import {
  isValidTaskStatusTransition,
  computeAcceptanceStatus,
  addTaskDependency,
  TASK_STATUS_TRANSITIONS,
} from "@/services/task.service";

// ===== isValidTaskStatusTransition =====

describe("isValidTaskStatusTransition", () => {
  describe("valid transitions", () => {
    const validCases: [string, string][] = [
      ["open", "assigned"],
      ["open", "closed"],
      ["assigned", "open"],
      ["assigned", "in_progress"],
      ["assigned", "closed"],
      ["in_progress", "to_verify"],
      ["in_progress", "closed"],
      ["to_verify", "done"],
      ["to_verify", "in_progress"],
      ["to_verify", "closed"],
      ["done", "closed"],
    ];

    it.each(validCases)("%s -> %s should be valid", (from, to) => {
      expect(isValidTaskStatusTransition(from, to)).toBe(true);
    });
  });

  describe("invalid transitions", () => {
    const invalidCases: [string, string][] = [
      ["open", "in_progress"],
      ["open", "to_verify"],
      ["open", "done"],
      ["assigned", "to_verify"],
      ["assigned", "done"],
      ["in_progress", "open"],
      ["in_progress", "assigned"],
      ["in_progress", "done"],
      ["to_verify", "open"],
      ["to_verify", "assigned"],
      ["done", "open"],
      ["done", "assigned"],
      ["done", "in_progress"],
      ["done", "to_verify"],
      ["closed", "open"],
      ["closed", "assigned"],
      ["closed", "in_progress"],
      ["closed", "to_verify"],
      ["closed", "done"],
    ];

    it.each(invalidCases)("%s -> %s should be invalid", (from, to) => {
      expect(isValidTaskStatusTransition(from, to)).toBe(false);
    });
  });

  it("should return false for unknown source status", () => {
    expect(isValidTaskStatusTransition("nonexistent", "open")).toBe(false);
  });

  it("should return false for same-status transition (not in allowed list)", () => {
    expect(isValidTaskStatusTransition("open", "open")).toBe(false);
  });

  it("should have all expected statuses in TASK_STATUS_TRANSITIONS", () => {
    const expectedStatuses = ["open", "assigned", "in_progress", "to_verify", "done", "closed"];
    expect(Object.keys(TASK_STATUS_TRANSITIONS).sort()).toEqual(expectedStatuses.sort());
  });
});

// ===== computeAcceptanceStatus =====

describe("computeAcceptanceStatus", () => {
  it("should return not_started with empty summary for empty items array", () => {
    const result = computeAcceptanceStatus([]);
    expect(result.status).toBe("not_started");
    expect(result.summary).toEqual({
      total: 0,
      required: 0,
      passed: 0,
      failed: 0,
      pending: 0,
      requiredPassed: 0,
      requiredFailed: 0,
      requiredPending: 0,
    });
  });

  it("should return not_started when all items are pending", () => {
    const items = [
      { required: true, status: "pending" },
      { required: false, status: "pending" },
    ];
    const result = computeAcceptanceStatus(items);
    expect(result.status).toBe("not_started");
    expect(result.summary.total).toBe(2);
    expect(result.summary.required).toBe(1);
    expect(result.summary.pending).toBe(2);
  });

  it("should return passed when all required items are passed", () => {
    const items = [
      { required: true, status: "passed" },
      { required: true, status: "passed" },
      { required: false, status: "pending" },
    ];
    const result = computeAcceptanceStatus(items);
    expect(result.status).toBe("passed");
    expect(result.summary.requiredPassed).toBe(2);
    expect(result.summary.required).toBe(2);
  });

  it("should return failed when any required item is failed", () => {
    const items = [
      { required: true, status: "passed" },
      { required: true, status: "failed" },
      { required: false, status: "passed" },
    ];
    const result = computeAcceptanceStatus(items);
    expect(result.status).toBe("failed");
    expect(result.summary.requiredFailed).toBe(1);
  });

  it("should return failed even if some required items are passed but one is failed", () => {
    const items = [
      { required: true, status: "passed" },
      { required: true, status: "failed" },
      { required: true, status: "pending" },
    ];
    const result = computeAcceptanceStatus(items);
    expect(result.status).toBe("failed");
  });

  it("should return in_progress when some items have results but not all required passed", () => {
    const items = [
      { required: true, status: "passed" },
      { required: true, status: "pending" },
    ];
    const result = computeAcceptanceStatus(items);
    expect(result.status).toBe("in_progress");
  });

  it("should return in_progress when only optional items have been evaluated", () => {
    const items = [
      { required: false, status: "passed" },
      { required: false, status: "pending" },
    ];
    const result = computeAcceptanceStatus(items);
    // No required items, so required === 0, requiredPassed === 0
    // But passed > 0, so in_progress
    expect(result.status).toBe("in_progress");
  });

  it("should return in_progress when optional item failed but no required items exist", () => {
    const items = [
      { required: false, status: "failed" },
      { required: false, status: "pending" },
    ];
    const result = computeAcceptanceStatus(items);
    // requiredFailed === 0, so not "failed"
    // required === 0, requiredPassed === 0, so "passed" condition fails (required === 0 check)
    // failed > 0, so "in_progress"
    expect(result.status).toBe("in_progress");
  });

  it("should correctly count summary fields", () => {
    const items = [
      { required: true, status: "passed" },
      { required: true, status: "failed" },
      { required: true, status: "pending" },
      { required: false, status: "passed" },
      { required: false, status: "failed" },
      { required: false, status: "pending" },
    ];
    const result = computeAcceptanceStatus(items);
    expect(result.summary).toEqual({
      total: 6,
      required: 3,
      passed: 2,
      failed: 2,
      pending: 2,
      requiredPassed: 1,
      requiredFailed: 1,
      requiredPending: 1,
    });
  });

  it("should return passed when the single required item is passed", () => {
    const items = [{ required: true, status: "passed" }];
    const result = computeAcceptanceStatus(items);
    expect(result.status).toBe("passed");
  });

  it("should return failed when the single required item is failed", () => {
    const items = [{ required: true, status: "failed" }];
    const result = computeAcceptanceStatus(items);
    expect(result.status).toBe("failed");
  });

  it("should prioritize failed over passed (failed takes precedence)", () => {
    // If any required is failed, overall is failed regardless of other passed required
    const items = [
      { required: true, status: "passed" },
      { required: true, status: "passed" },
      { required: true, status: "failed" },
    ];
    const result = computeAcceptanceStatus(items);
    expect(result.status).toBe("failed");
  });
});

// ===== wouldCreateCycle (tested indirectly via addTaskDependency) =====

describe("wouldCreateCycle (via addTaskDependency)", () => {
  const prisma = mockPrisma;
  const companyUuid = "company-0000-0000-0000-000000000001";
  const projectUuid = "project-0000-0000-0000-000000000001";

  function makeTaskMock(uuid: string) {
    return { uuid, companyUuid, projectUuid, status: "open" };
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should allow adding dependency in a linear chain (A -> B -> C, add C -> A is new dep not cycle from C perspective)", async () => {
    // Existing edges: A depends on B, B depends on C
    // We want to add: A depends on C (no cycle since C does not reach A)
    const A = "aaaa0000-0000-0000-0000-000000000001";
    const B = "bbbb0000-0000-0000-0000-000000000002";
    const C = "cccc0000-0000-0000-0000-000000000003";

    prisma.task.findFirst
      .mockResolvedValueOnce(makeTaskMock(A))  // task lookup
      .mockResolvedValueOnce(makeTaskMock(C)); // dependsOn lookup

    // Existing dependency edges
    prisma.taskDependency.findMany.mockResolvedValue([
      { taskUuid: A, dependsOnUuid: B },
      { taskUuid: B, dependsOnUuid: C },
    ]);

    prisma.taskDependency.create.mockResolvedValue({
      taskUuid: A,
      dependsOnUuid: C,
      createdAt: new Date(),
    });

    // addTaskDependency(companyUuid, taskUuid=A, dependsOnUuid=C)
    // wouldCreateCycle checks: from C, can we reach A via existing edges?
    // C has no outgoing edges, so no cycle
    const result = await addTaskDependency(companyUuid, A, C);
    expect(result.taskUuid).toBe(A);
    expect(result.dependsOnUuid).toBe(C);
  });

  it("should detect a simple cycle (A -> B, adding B -> A)", async () => {
    const A = "aaaa0000-0000-0000-0000-000000000001";
    const B = "bbbb0000-0000-0000-0000-000000000002";

    prisma.task.findFirst
      .mockResolvedValueOnce(makeTaskMock(B))  // task lookup (taskUuid=B)
      .mockResolvedValueOnce(makeTaskMock(A)); // dependsOn lookup (dependsOnUuid=A)

    // Existing: A depends on B
    prisma.taskDependency.findMany.mockResolvedValue([
      { taskUuid: A, dependsOnUuid: B },
    ]);

    // addTaskDependency(companyUuid, taskUuid=B, dependsOnUuid=A)
    // wouldCreateCycle checks: from A, can we reach B? A -> B via existing edge, yes!
    await expect(addTaskDependency(companyUuid, B, A)).rejects.toThrow(
      "Adding this dependency would create a cycle"
    );
  });

  it("should detect a cycle in a diamond graph", async () => {
    // Diamond: A -> B, A -> C, B -> D, C -> D
    // Adding D -> A would create a cycle
    const A = "aaaa0000-0000-0000-0000-000000000001";
    const B = "bbbb0000-0000-0000-0000-000000000002";
    const C = "cccc0000-0000-0000-0000-000000000003";
    const D = "dddd0000-0000-0000-0000-000000000004";

    prisma.task.findFirst
      .mockResolvedValueOnce(makeTaskMock(D))
      .mockResolvedValueOnce(makeTaskMock(A));

    prisma.taskDependency.findMany.mockResolvedValue([
      { taskUuid: A, dependsOnUuid: B },
      { taskUuid: A, dependsOnUuid: C },
      { taskUuid: B, dependsOnUuid: D },
      { taskUuid: C, dependsOnUuid: D },
    ]);

    // addTaskDependency(companyUuid, taskUuid=D, dependsOnUuid=A)
    // wouldCreateCycle(startUuid=A, targetUuid=D): from A, follow edges:
    // A -> B -> D (found!), cycle detected
    await expect(addTaskDependency(companyUuid, D, A)).rejects.toThrow(
      "Adding this dependency would create a cycle"
    );
  });

  it("should reject self-loop (A -> A)", async () => {
    const A = "aaaa0000-0000-0000-0000-000000000001";

    // addTaskDependency checks self-dependency before prisma calls
    await expect(addTaskDependency(companyUuid, A, A)).rejects.toThrow(
      "A task cannot depend on itself"
    );
  });

  it("should allow dependency when no cycle exists in diamond", async () => {
    // Diamond: A -> B, A -> C, B -> D, C -> D
    // Adding A -> D is fine (D cannot reach A)
    const A = "aaaa0000-0000-0000-0000-000000000001";
    const B = "bbbb0000-0000-0000-0000-000000000002";
    const C = "cccc0000-0000-0000-0000-000000000003";
    const D = "dddd0000-0000-0000-0000-000000000004";

    prisma.task.findFirst
      .mockResolvedValueOnce(makeTaskMock(A))
      .mockResolvedValueOnce(makeTaskMock(D));

    prisma.taskDependency.findMany.mockResolvedValue([
      { taskUuid: A, dependsOnUuid: B },
      { taskUuid: A, dependsOnUuid: C },
      { taskUuid: B, dependsOnUuid: D },
      { taskUuid: C, dependsOnUuid: D },
    ]);

    prisma.taskDependency.create.mockResolvedValue({
      taskUuid: A,
      dependsOnUuid: D,
      createdAt: new Date(),
    });

    // wouldCreateCycle(startUuid=D, targetUuid=A): from D, can we reach A?
    // D has no outgoing edges, so no cycle
    const result = await addTaskDependency(companyUuid, A, D);
    expect(result.taskUuid).toBe(A);
  });

  it("should detect a longer cycle (A -> B -> C -> D, adding D -> A)", async () => {
    const A = "aaaa0000-0000-0000-0000-000000000001";
    const B = "bbbb0000-0000-0000-0000-000000000002";
    const C = "cccc0000-0000-0000-0000-000000000003";
    const D = "dddd0000-0000-0000-0000-000000000004";

    prisma.task.findFirst
      .mockResolvedValueOnce(makeTaskMock(D))
      .mockResolvedValueOnce(makeTaskMock(A));

    prisma.taskDependency.findMany.mockResolvedValue([
      { taskUuid: A, dependsOnUuid: B },
      { taskUuid: B, dependsOnUuid: C },
      { taskUuid: C, dependsOnUuid: D },
    ]);

    // addTaskDependency(companyUuid, D, A): wouldCreateCycle(A, D)
    // A -> B -> C -> D (found!), cycle
    await expect(addTaskDependency(companyUuid, D, A)).rejects.toThrow(
      "Adding this dependency would create a cycle"
    );
  });
});
