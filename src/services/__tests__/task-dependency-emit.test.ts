// src/services/__tests__/task-dependency-emit.test.ts
//
// Verifies that addTaskDependency + removeTaskDependency emit the
// existing `task:updated` change event for BOTH endpoints of the edge.
// This is the live-update plumbing the Project Resource Graph relies on
// to reflect dependency add/remove in real time (AC #3 of the Wave 4
// task #3 "Live structural updates" task). Without these emits, the
// SSE stream stays silent on a pure dependency edit, and the graph
// can't re-fetch the aggregation to show the new/removed depends edge.
//
// We DON'T introduce a new event type — emits ride the existing
// `RealtimeEvent { entityType: "task", action: "updated" }` channel,
// which the SSE route + RealtimeContext already forward to consumers
// of `useRealtimeEntityTypeEvent("task", ...)` (idea-tracker-list,
// kanban-board, the new resource-graph canvas, etc.).

import { describe, it, expect, vi, beforeEach } from "vitest";

const mockPrisma = vi.hoisted(() => ({
  task: {
    findFirst: vi.fn(),
  },
  taskDependency: {
    findMany: vi.fn(),
    create: vi.fn(),
    deleteMany: vi.fn(),
  },
}));
vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));

const mockEventBus = vi.hoisted(() => ({
  emitChange: vi.fn(),
}));
vi.mock("@/lib/event-bus", () => ({ eventBus: mockEventBus }));

vi.mock("@/lib/uuid-resolver", () => ({
  formatAssigneeComplete: vi.fn(),
  formatCreatedBy: vi.fn(),
  batchGetActorNames: vi.fn(),
  batchFormatCreatedBy: vi.fn(),
}));
vi.mock("@/services/comment.service", () => ({ batchCommentCounts: vi.fn() }));
vi.mock("@/services/mention.service", () => ({
  parseMentions: vi.fn().mockReturnValue([]),
  createMentions: vi.fn(),
}));
vi.mock("@/services/activity.service", () => ({ createActivity: vi.fn() }));

import {
  addTaskDependency,
  removeTaskDependency,
} from "@/services/task.service";

const COMPANY = "company-0000-0000-0000-000000000001";
const PROJECT = "project-0000-0000-0000-000000000001";
const TASK_A = "aaaa0000-0000-0000-0000-000000000001";
const TASK_B = "bbbb0000-0000-0000-0000-000000000002";

function taskRow(uuid: string) {
  return { uuid, companyUuid: COMPANY, projectUuid: PROJECT, status: "open" };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("addTaskDependency — emits task:updated for both endpoints", () => {
  it("emits a `task:updated` change event for both the dependent and the dependedOn task", async () => {
    mockPrisma.task.findFirst
      .mockResolvedValueOnce(taskRow(TASK_A)) // taskUuid lookup
      .mockResolvedValueOnce(taskRow(TASK_B)); // dependsOnUuid lookup
    mockPrisma.taskDependency.findMany.mockResolvedValue([]); // no existing edges
    mockPrisma.taskDependency.create.mockResolvedValue({
      taskUuid: TASK_A,
      dependsOnUuid: TASK_B,
      createdAt: new Date(),
    });

    await addTaskDependency(COMPANY, TASK_A, TASK_B);

    // Both emits — once for the dependent (TASK_A) and once for the
    // dependedOn (TASK_B). The Resource Graph subscribes to "task"
    // entity-type events, so either firing the canvas would refetch and
    // pick up the new depends edge; emitting for both lets per-entity
    // subscribers (e.g. a task detail panel watching TASK_B's depended-
    // by list) wake too.
    expect(mockEventBus.emitChange).toHaveBeenCalledTimes(2);
    expect(mockEventBus.emitChange).toHaveBeenCalledWith({
      companyUuid: COMPANY,
      projectUuid: PROJECT,
      entityType: "task",
      entityUuid: TASK_A,
      action: "updated",
    });
    expect(mockEventBus.emitChange).toHaveBeenCalledWith({
      companyUuid: COMPANY,
      projectUuid: PROJECT,
      entityType: "task",
      entityUuid: TASK_B,
      action: "updated",
    });
  });

  it("does not emit when the add throws (e.g. cycle)", async () => {
    // Set up a cycle: A -> B already, adding B -> A would close the loop.
    mockPrisma.task.findFirst
      .mockResolvedValueOnce(taskRow(TASK_B)) // taskUuid=B
      .mockResolvedValueOnce(taskRow(TASK_A)); // dependsOnUuid=A
    mockPrisma.taskDependency.findMany.mockResolvedValue([
      { taskUuid: TASK_A, dependsOnUuid: TASK_B },
    ]);

    await expect(addTaskDependency(COMPANY, TASK_B, TASK_A)).rejects.toThrow(
      /cycle/,
    );

    // No edge was created → no event fires. This pins that the emit sits
    // AFTER the prisma.taskDependency.create call, where it belongs.
    expect(mockEventBus.emitChange).not.toHaveBeenCalled();
  });
});

describe("removeTaskDependency — emits task:updated for both endpoints", () => {
  it("emits for both endpoints when both tasks resolve", async () => {
    mockPrisma.task.findFirst
      .mockResolvedValueOnce(taskRow(TASK_A)) // taskUuid lookup
      .mockResolvedValueOnce(taskRow(TASK_B)); // dependsOnUuid lookup
    mockPrisma.taskDependency.deleteMany.mockResolvedValue({ count: 1 });

    await removeTaskDependency(COMPANY, TASK_A, TASK_B);

    expect(mockEventBus.emitChange).toHaveBeenCalledTimes(2);
    expect(mockEventBus.emitChange).toHaveBeenCalledWith({
      companyUuid: COMPANY,
      projectUuid: PROJECT,
      entityType: "task",
      entityUuid: TASK_A,
      action: "updated",
    });
    expect(mockEventBus.emitChange).toHaveBeenCalledWith({
      companyUuid: COMPANY,
      projectUuid: PROJECT,
      entityType: "task",
      entityUuid: TASK_B,
      action: "updated",
    });
  });

  it("still emits for the surviving task when the dependsOn task is missing (already deleted)", async () => {
    // The depended-on task no longer exists in the caller's company —
    // happens when the row is deleted out from under a stale dependency.
    // The dependency row itself may still be in the table; the cleanup
    // should NOT crash, and we still emit for the surviving endpoint so
    // the Resource Graph reconciles.
    mockPrisma.task.findFirst
      .mockResolvedValueOnce(taskRow(TASK_A)) // taskUuid resolves
      .mockResolvedValueOnce(null); // dependsOn missing
    mockPrisma.taskDependency.deleteMany.mockResolvedValue({ count: 1 });

    await removeTaskDependency(COMPANY, TASK_A, TASK_B);

    expect(mockEventBus.emitChange).toHaveBeenCalledTimes(1);
    expect(mockEventBus.emitChange).toHaveBeenCalledWith({
      companyUuid: COMPANY,
      projectUuid: PROJECT,
      entityType: "task",
      entityUuid: TASK_A,
      action: "updated",
    });
  });
});
