// src/__tests__/integration/acceptance-criteria-enforcement.integration.test.ts
//
// Integration checkpoint for the non-empty acceptance-criteria invariant
// (BLOCKER-1 of the "Enforce Non-Empty Acceptance Criteria" change).
//
// Module-level unit tests prove each enforcement point in isolation. This test
// proves the invariant holds SYSTEM-WIDE across BOTH enforcement layers wired
// through the SAME shared helper:
//
//   - proposal-draft layer: the real proposal.service.addTaskDraft / updateTaskDraft
//   - real-task layer:       the real public.ts chorus_create_tasks / chorus_update_task
//
// Critically, `@/lib/acceptance-criteria` is NOT mocked — the real helper runs in
// both call sites, so a regression that unwired the helper from either layer would
// fail here. prisma and peripheral services are stubbed; the AC store is an
// in-memory map so we can assert rows actually land / get replaced.

import { describe, it, expect, vi, beforeEach } from "vitest";

// ===== In-memory acceptance-criterion store =====

type AcRow = { taskUuid: string; description: string; required: boolean; sortOrder: number };
const acStore: AcRow[] = [];

// ===== Hoisted mocks =====

const { mockPrisma, mockEventBus, mockFormatCreatedBy, mockFormatReview, proposalStore } = vi.hoisted(() => {
  const proposalStore = { current: null as Record<string, unknown> | null };
  const mockPrisma = {
    proposal: {
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    acceptanceCriterion: {
      createMany: vi.fn(),
      deleteMany: vi.fn(),
    },
  };
  return {
    mockPrisma,
    mockEventBus: { emitChange: vi.fn() },
    mockFormatCreatedBy: vi.fn().mockResolvedValue({ type: "agent", uuid: "actor-uuid", name: "Agent" }),
    mockFormatReview: vi.fn().mockResolvedValue(null),
    proposalStore,
  };
});

// task.service is imported by BOTH proposal.service (createTasksFromProposal) and
// public.ts (createTask, getTaskByUuid, ...). One mock satisfies both.
const mockTaskService = vi.hoisted(() => ({
  createTask: vi.fn(),
  getTaskByUuid: vi.fn(),
  updateTask: vi.fn(),
  isValidTaskStatusTransition: vi.fn(),
  checkDependenciesResolved: vi.fn(),
  addTaskDependency: vi.fn(),
  removeTaskDependency: vi.fn(),
  createTasksFromProposal: vi.fn(),
  createAcceptanceCriteria: vi.fn(),
  replaceAcceptanceCriteria: vi.fn(),
}));

const mockProjectService = vi.hoisted(() => ({
  projectExists: vi.fn().mockResolvedValue(true),
  getProjectByUuid: vi.fn(),
}));

const mockActivityService = vi.hoisted(() => ({ createActivity: vi.fn() }));
const mockSessionService = vi.hoisted(() => ({ getSession: vi.fn(), heartbeatSession: vi.fn() }));

vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("@/generated/prisma/client", () => ({ Prisma: { JsonNull: "DbNull", InputJsonValue: {} } }));
vi.mock("@/lib/event-bus", () => ({ eventBus: mockEventBus }));
vi.mock("@/lib/uuid-resolver", () => ({ formatCreatedBy: mockFormatCreatedBy, formatReview: mockFormatReview }));
vi.mock("@/services/task.service", () => mockTaskService);
vi.mock("@/services/project.service", () => ({ ...mockProjectService, projectExists: mockProjectService.projectExists }));
vi.mock("@/services/activity.service", () => mockActivityService);
vi.mock("@/services/session.service", () => mockSessionService);
vi.mock("@/services/document.service", () => ({ createDocumentFromProposal: vi.fn() }));
// Peripheral services public.ts imports but this test never exercises.
vi.mock("@/services/idea.service", () => ({}));
vi.mock("@/services/comment.service", () => ({}));
vi.mock("@/services/assignment.service", () => ({}));
vi.mock("@/services/notification.service", () => ({}));
vi.mock("@/services/elaboration.service", () => ({}));
vi.mock("@/services/project-group.service", () => ({}));
vi.mock("@/services/mention.service", () => ({}));
vi.mock("@/services/search.service", () => ({}));
vi.mock("@/services/checkin.service", () => ({}));

// Real modules under test — NOT mocked.
import { addTaskDraft, updateTaskDraft } from "@/services/proposal.service";
import { registerPublicTools } from "@/mcp/tools/public";
import { normalizeAcceptanceCriteria } from "@/lib/acceptance-criteria";
import type { AgentAuthContext } from "@/types/auth";

// ===== Capture public tool handlers =====

type ToolHandler = (params: Record<string, unknown>) => Promise<unknown>;
const toolHandlers: Record<string, ToolHandler> = {};
const fakeMcpServer = {
  registerTool: (name: string, _meta: unknown, handler: ToolHandler) => {
    toolHandlers[name] = handler;
  },
};

const AUTH: AgentAuthContext = {
  type: "agent",
  companyUuid: "company-1",
  actorUuid: "agent-1",
  ownerUuid: "owner-1",
  roles: ["admin"],
  permissions: [],
  agentName: "Integration Agent",
};

const COMPANY = "company-1";

function isError(result: unknown): boolean {
  return (result as { isError?: boolean }).isError === true;
}

beforeEach(() => {
  vi.clearAllMocks();
  acStore.length = 0;
  proposalStore.current = null;
  Object.keys(toolHandlers).forEach((k) => delete toolHandlers[k]);
  registerPublicTools(fakeMcpServer as never, AUTH);

  // prisma.proposal: a single draft proposal whose taskDrafts live in proposalStore.
  mockPrisma.proposal.findFirst.mockImplementation(async () => proposalStore.current);
  mockPrisma.proposal.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => {
    proposalStore.current = { ...(proposalStore.current as object), ...data };
    return { ...(proposalStore.current as object), project: { uuid: "project-1", name: "P" } };
  });

  // prisma.acceptanceCriterion: real-ish in-memory behavior (proposal.service path).
  mockPrisma.acceptanceCriterion.createMany.mockImplementation(async ({ data }: { data: AcRow[] }) => {
    acStore.push(...data);
    return { count: data.length };
  });
  mockPrisma.acceptanceCriterion.deleteMany.mockImplementation(async ({ where }: { where: { taskUuid: string } }) => {
    for (let i = acStore.length - 1; i >= 0; i--) {
      if (acStore[i].taskUuid === where.taskUuid) acStore.splice(i, 1);
    }
    return { count: 0 };
  });

  // task.service AC fns are mocked here (real-task layer) — wire them to acStore
  // so cross-layer assertions stay meaningful. The real transactional behavior of
  // replaceAcceptanceCriteria is covered by its own unit test in task.service.test.ts.
  mockTaskService.createAcceptanceCriteria.mockImplementation(async (taskUuid: string, items: { description: string; required: boolean }[]) => {
    items.forEach((item, index) => acStore.push({ taskUuid, description: item.description, required: item.required, sortOrder: index }));
    return [];
  });
  mockTaskService.replaceAcceptanceCriteria.mockImplementation(async (_companyUuid: string, taskUuid: string, items: { description: string; required?: boolean }[]) => {
    const normalized = normalizeAcceptanceCriteria(items);
    for (let i = acStore.length - 1; i >= 0; i--) {
      if (acStore[i].taskUuid === taskUuid) acStore.splice(i, 1);
    }
    normalized.forEach((item, index) => acStore.push({ taskUuid, description: item.description, required: item.required, sortOrder: index }));
    return [];
  });

  mockProjectService.projectExists.mockResolvedValue(true);
});

describe("AC enforcement — cross-layer integration", () => {
  it("proposal layer: addTaskDraft rejects missing AC but accepts a non-empty set", async () => {
    proposalStore.current = { uuid: "prop-1", companyUuid: COMPANY, projectUuid: "project-1", status: "draft", taskDrafts: [], createdByType: "agent", createdByUuid: "agent-1", inputType: "idea", inputUuids: [], description: null, title: "P", reviewedByUuid: null, reviewNote: null, reviewedAt: null, createdAt: new Date("2026-06-02T00:00:00Z"), updatedAt: new Date("2026-06-02T00:00:00Z") };

    // Missing AC → rejected by the shared helper, nothing written.
    await expect(
      addTaskDraft("prop-1", COMPANY, { title: "No AC" }),
    ).rejects.toThrow("acceptance criterion");

    // Non-empty AC (with a blank dropped) → persisted normalized.
    await addTaskDraft("prop-1", COMPANY, {
      title: "With AC",
      acceptanceCriteriaItems: [{ description: "  real  " }, { description: "  " }],
    });
    const drafts = (proposalStore.current as { taskDrafts: Array<{ title: string; acceptanceCriteriaItems: unknown }> }).taskDrafts;
    expect(drafts).toHaveLength(1);
    expect(drafts[0].acceptanceCriteriaItems).toEqual([{ description: "real", required: true }]);
  });

  it("real-task layer: chorus_create_tasks rejects missing AC but persists rows for a non-empty set", async () => {
    // Missing AC → isError, no task created.
    mockTaskService.createTask.mockResolvedValue({ uuid: "task-1", title: "x" });
    const bad = await toolHandlers["chorus_create_tasks"]({
      projectUuid: "project-1",
      tasks: [{ title: "No AC" }],
    });
    expect(isError(bad)).toBe(true);
    expect(mockTaskService.createTask).not.toHaveBeenCalled();
    expect(acStore).toHaveLength(0);

    // Non-empty AC → task created and AC rows landed.
    mockTaskService.createTask.mockResolvedValue({ uuid: "task-1", title: "Good" });
    const ok = await toolHandlers["chorus_create_tasks"]({
      projectUuid: "project-1",
      tasks: [{ title: "Good", acceptanceCriteriaItems: [{ description: "ships" }] }],
    });
    expect(isError(ok)).toBe(false);
    expect(acStore).toEqual([
      expect.objectContaining({ taskUuid: "task-1", description: "ships", required: true, sortOrder: 0 }),
    ]);
  });

  it("real-task layer: chorus_update_task replaces AC with a non-empty set", async () => {
    acStore.push({ taskUuid: "task-1", description: "old", required: true, sortOrder: 0 });
    mockTaskService.getTaskByUuid.mockResolvedValue({
      uuid: "task-1", status: "assigned", projectUuid: "project-1", assigneeType: "agent", assigneeUuid: "agent-1",
    });

    const result = await toolHandlers["chorus_update_task"]({
      taskUuid: "task-1",
      acceptanceCriteriaItems: [{ description: "brand new" }],
    });

    expect(isError(result)).toBe(false);
    // Old row deleted, new row present.
    expect(acStore).toEqual([
      expect.objectContaining({ taskUuid: "task-1", description: "brand new", required: true, sortOrder: 0 }),
    ]);
  });

  it("real-task layer: chorus_update_task rejects an empty AC array and leaves rows intact", async () => {
    acStore.push({ taskUuid: "task-1", description: "keep", required: true, sortOrder: 0 });
    mockTaskService.getTaskByUuid.mockResolvedValue({
      uuid: "task-1", status: "assigned", projectUuid: "project-1", assigneeType: "agent", assigneeUuid: "agent-1",
    });

    const result = await toolHandlers["chorus_update_task"]({ taskUuid: "task-1", acceptanceCriteriaItems: [] });

    expect(isError(result)).toBe(true);
    expect(acStore).toEqual([expect.objectContaining({ description: "keep" })]);
  });

  it("regression: status-only transition is not blocked and does not touch AC", async () => {
    acStore.push({ taskUuid: "task-1", description: "keep", required: true, sortOrder: 0 });
    mockTaskService.getTaskByUuid.mockResolvedValue({
      uuid: "task-1", status: "assigned", projectUuid: "project-1", assigneeType: "agent", assigneeUuid: "agent-1",
    });
    mockTaskService.isValidTaskStatusTransition.mockReturnValue(true);
    mockTaskService.checkDependenciesResolved.mockResolvedValue({ resolved: true, blockers: [] });
    mockTaskService.updateTask.mockResolvedValue({ uuid: "task-1", status: "in_progress" });

    const result = await toolHandlers["chorus_update_task"]({ taskUuid: "task-1", status: "in_progress" });

    expect(isError(result)).toBe(false);
    expect(mockTaskService.updateTask).toHaveBeenCalled();
    expect(mockTaskService.replaceAcceptanceCriteria).not.toHaveBeenCalled();
    expect(acStore).toEqual([expect.objectContaining({ description: "keep" })]);
  });

  it("regression: dependency-only edit is not blocked and does not touch AC", async () => {
    acStore.push({ taskUuid: "task-1", description: "keep", required: true, sortOrder: 0 });
    mockTaskService.getTaskByUuid.mockResolvedValue({
      uuid: "task-1", status: "assigned", projectUuid: "project-1", assigneeType: "agent", assigneeUuid: "agent-1",
    });

    const result = await toolHandlers["chorus_update_task"]({ taskUuid: "task-1", addDependsOn: ["dep-1"] });

    expect(isError(result)).toBe(false);
    expect(mockTaskService.addTaskDependency).toHaveBeenCalledWith(COMPANY, "task-1", "dep-1");
    expect(mockTaskService.replaceAcceptanceCriteria).not.toHaveBeenCalled();
    expect(acStore).toEqual([expect.objectContaining({ description: "keep" })]);
  });

  it("proposal layer: updateTaskDraft preserves AC when omitted (shared invariant, no false rejection)", async () => {
    proposalStore.current = {
      uuid: "prop-1", companyUuid: COMPANY, projectUuid: "project-1", status: "draft",
      taskDrafts: [{ uuid: "td-1", title: "T", acceptanceCriteriaItems: [{ description: "Done", required: true }] }],
      createdByType: "agent", createdByUuid: "agent-1", inputType: "idea", inputUuids: [], description: null, title: "P",
      reviewedByUuid: null, reviewNote: null, reviewedAt: null,
      createdAt: new Date("2026-06-02T00:00:00Z"), updatedAt: new Date("2026-06-02T00:00:00Z"),
    };

    await updateTaskDraft("prop-1", COMPANY, "td-1", { title: "Renamed" });

    const drafts = (proposalStore.current as { taskDrafts: Array<{ title: string; acceptanceCriteriaItems: unknown }> }).taskDrafts;
    expect(drafts[0].title).toBe("Renamed");
    expect(drafts[0].acceptanceCriteriaItems).toEqual([{ description: "Done", required: true }]);
  });
});
