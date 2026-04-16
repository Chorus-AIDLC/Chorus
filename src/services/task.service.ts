// src/services/task.service.ts
// Task Service Layer (ARCHITECTURE.md §3.1 Service Layer)
// UUID-Based Architecture: All operations use UUIDs

import { prisma } from "@/lib/prisma";
import { formatAssigneeComplete, formatCreatedBy, batchGetActorNames, batchFormatCreatedBy } from "@/lib/uuid-resolver";
import { eventBus } from "@/lib/event-bus";
import { AlreadyClaimedError, NotClaimedError, isPrismaNotFound } from "@/lib/errors";
import { batchCommentCounts } from "@/services/comment.service";
import * as mentionService from "@/services/mention.service";
import * as activityService from "@/services/activity.service";
import logger from "@/lib/logger";

// ===== Type Definitions =====

export interface TaskListParams {
  companyUuid: string;
  projectUuid: string;
  skip: number;
  take: number;
  status?: string;
  priority?: string;
  proposalUuids?: string[];
}

export interface TaskCreateParams {
  companyUuid: string;
  projectUuid: string;
  title: string;
  description?: string | null;
  priority?: string;
  storyPoints?: number | null;
  acceptanceCriteria?: string | null;  // acceptance criteria
  proposalUuid?: string | null;
  createdByUuid: string;
}

export interface TaskClaimParams {
  taskUuid: string;
  companyUuid: string;
  assigneeType: string;
  assigneeUuid: string;
  assignedByUuid?: string | null;
}

export interface TaskUpdateParams {
  title?: string;
  description?: string | null;
  status?: string;
  priority?: string;
  storyPoints?: number | null;
  acceptanceCriteria?: string | null;  // acceptance criteria
}

// Dependency summary info
export interface TaskDependencyInfo {
  uuid: string;
  title: string;
  status: string;
}

// API response format
export interface AcceptanceCriterionResponse {
  uuid: string;
  description: string;
  required: boolean;
  devStatus: string;  // pending | passed | failed
  devEvidence: string | null;
  devMarkedByType: string | null;
  devMarkedBy: string | null;
  devMarkedAt: string | null;
  status: string;  // pending | passed | failed
  evidence: string | null;
  markedByType: string | null;
  markedBy: string | null;
  markedAt: string | null;
  sortOrder: number;
}

export interface AcceptanceSummary {
  total: number;
  required: number;
  passed: number;
  failed: number;
  pending: number;
  requiredPassed: number;
  requiredFailed: number;
  requiredPending: number;
}

export interface TaskResponse {
  uuid: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  storyPoints: number | null;
  acceptanceCriteria: string | null;  // acceptance criteria (Markdown, legacy)
  acceptanceCriteriaItems: AcceptanceCriterionResponse[];
  acceptanceStatus: string;  // not_started | in_progress | passed | failed
  acceptanceSummary: AcceptanceSummary;
  assignee: {
    type: string;
    uuid: string;
    name: string;
    assignedAt: string | null;
    assignedBy: { type: string; uuid: string; name: string } | null;
  } | null;
  proposalUuid: string | null;
  project?: { uuid: string; name: string };
  createdBy: { type: string; uuid: string; name: string } | null;
  dependsOn: TaskDependencyInfo[];
  dependedBy: TaskDependencyInfo[];
  commentCount: number;
  createdAt: string;
  updatedAt: string;
}

// Task status transition rules (ARCHITECTURE.md §7.2)
export const TASK_STATUS_TRANSITIONS: Record<string, string[]> = {
  open: ["assigned", "closed"],
  assigned: ["open", "in_progress", "closed"],
  in_progress: ["to_verify", "closed"],
  to_verify: ["done", "in_progress", "closed"],
  done: ["closed"],
  closed: [],
};

// Validate whether a status transition is valid
export function isValidTaskStatusTransition(from: string, to: string): boolean {
  const allowed = TASK_STATUS_TRANSITIONS[from] || [];
  return allowed.includes(to);
}

// ===== Acceptance Criteria Helpers =====

const emptySummary: AcceptanceSummary = {
  total: 0, required: 0, passed: 0, failed: 0, pending: 0,
  requiredPassed: 0, requiredFailed: 0, requiredPending: 0,
};

export function computeAcceptanceStatus(
  items: Array<{ required: boolean; status: string }>,
): { status: string; summary: AcceptanceSummary } {
  if (items.length === 0) {
    return { status: "not_started", summary: { ...emptySummary } };
  }

  const summary: AcceptanceSummary = { ...emptySummary, total: items.length };
  for (const item of items) {
    if (item.required) summary.required++;
    if (item.status === "passed") {
      summary.passed++;
      if (item.required) summary.requiredPassed++;
    } else if (item.status === "failed") {
      summary.failed++;
      if (item.required) summary.requiredFailed++;
    } else {
      summary.pending++;
      if (item.required) summary.requiredPending++;
    }
  }

  if (summary.requiredFailed > 0) return { status: "failed", summary };
  if (summary.requiredPassed === summary.required && summary.required > 0) return { status: "passed", summary };
  if (summary.passed > 0 || summary.failed > 0) return { status: "in_progress", summary };
  return { status: "not_started", summary };
}

function formatCriterionResponse(
  c: { uuid: string; description: string; required: boolean; devStatus: string; devEvidence: string | null; devMarkedByType: string | null; devMarkedBy: string | null; devMarkedAt: Date | null; status: string; evidence: string | null; markedByType: string | null; markedBy: string | null; markedAt: Date | null; sortOrder: number },
): AcceptanceCriterionResponse {
  return {
    uuid: c.uuid,
    description: c.description,
    required: c.required,
    devStatus: c.devStatus,
    devEvidence: c.devEvidence,
    devMarkedByType: c.devMarkedByType,
    devMarkedBy: c.devMarkedBy,
    devMarkedAt: c.devMarkedAt?.toISOString() ?? null,
    status: c.status,
    evidence: c.evidence,
    markedByType: c.markedByType,
    markedBy: c.markedBy,
    markedAt: c.markedAt?.toISOString() ?? null,
    sortOrder: c.sortOrder,
  };
}

// ===== Internal Helper Functions =====

// Format a single Task into API response format
async function formatTaskResponse(
  task: {
    uuid: string;
    title: string;
    description: string | null;
    status: string;
    priority: string;
    storyPoints: number | null;
    acceptanceCriteria: string | null;
    assigneeType: string | null;
    assigneeUuid: string | null;
    assignedAt: Date | null;
    assignedByUuid: string | null;
    proposalUuid: string | null;
    createdByUuid: string;
    createdAt: Date;
    updatedAt: Date;
    project?: { uuid: string; name: string };
    dependsOn?: Array<{ dependsOn: { uuid: string; title: string; status: string } }>;
    dependedBy?: Array<{ task: { uuid: string; title: string; status: string } }>;
    acceptanceCriteriaItems?: Array<{ uuid: string; description: string; required: boolean; devStatus: string; devEvidence: string | null; devMarkedByType: string | null; devMarkedBy: string | null; devMarkedAt: Date | null; status: string; evidence: string | null; markedByType: string | null; markedBy: string | null; markedAt: Date | null; sortOrder: number }>;
  },
  commentCount: number = 0,
): Promise<TaskResponse> {
  const [assignee, createdBy] = await Promise.all([
    formatAssigneeComplete(task.assigneeType, task.assigneeUuid, task.assignedAt, task.assignedByUuid),
    formatCreatedBy(task.createdByUuid),
  ]);

  const dependsOn: TaskDependencyInfo[] = (task.dependsOn || []).map((d) => ({
    uuid: d.dependsOn.uuid,
    title: d.dependsOn.title,
    status: d.dependsOn.status,
  }));

  const dependedBy: TaskDependencyInfo[] = (task.dependedBy || []).map((d) => ({
    uuid: d.task.uuid,
    title: d.task.title,
    status: d.task.status,
  }));

  const criteriaItems = (task.acceptanceCriteriaItems || []).map(formatCriterionResponse);
  const { status: acceptanceStatus, summary: acceptanceSummary } = computeAcceptanceStatus(
    task.acceptanceCriteriaItems || [],
  );

  return {
    uuid: task.uuid,
    title: task.title,
    description: task.description,
    status: task.status,
    priority: task.priority,
    storyPoints: task.storyPoints,
    acceptanceCriteria: task.acceptanceCriteria,
    acceptanceCriteriaItems: criteriaItems,
    acceptanceStatus,
    acceptanceSummary,
    assignee,
    proposalUuid: task.proposalUuid,
    ...(task.project && { project: task.project }),
    createdBy,
    dependsOn,
    dependedBy,
    commentCount,
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString(),
  };
}

// Batch format multiple tasks - 2 batch queries instead of N * (3-4) individual queries
type RawTaskForBatch = {
  uuid: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  storyPoints: number | null;
  acceptanceCriteria: string | null;
  assigneeType: string | null;
  assigneeUuid: string | null;
  assignedAt: Date | null;
  assignedByUuid: string | null;
  proposalUuid: string | null;
  createdByUuid: string;
  createdAt: Date;
  updatedAt: Date;
  project?: { uuid: string; name: string };
  dependsOn?: Array<{ dependsOn: { uuid: string; title: string; status: string } }>;
  dependedBy?: Array<{ task: { uuid: string; title: string; status: string } }>;
  acceptanceCriteriaItems?: Array<{ uuid: string; description: string; required: boolean; devStatus: string; devEvidence: string | null; devMarkedByType: string | null; devMarkedBy: string | null; devMarkedAt: Date | null; status: string; evidence: string | null; markedByType: string | null; markedBy: string | null; markedAt: Date | null; sortOrder: number }>;
};

async function formatTaskResponsesBatch(
  tasks: RawTaskForBatch[],
  commentCounts: Record<string, number>,
): Promise<TaskResponse[]> {
  if (tasks.length === 0) return [];

  // Collect all unique actors for batch resolution
  const actors: Array<{ type: string; uuid: string }> = [];
  const createdByUuids: string[] = [];

  for (const task of tasks) {
    if (task.assigneeType && task.assigneeUuid) {
      actors.push({ type: task.assigneeType, uuid: task.assigneeUuid });
    }
    if (task.assignedByUuid) {
      actors.push({ type: "user", uuid: task.assignedByUuid });
    }
    createdByUuids.push(task.createdByUuid);
  }

  // 2 batch queries instead of N * (3-4) individual queries
  const [actorNames, createdByMap] = await Promise.all([
    batchGetActorNames(actors),
    batchFormatCreatedBy(createdByUuids),
  ]);

  // Build responses synchronously from lookup maps
  return tasks.map((task) => {
    let assignee: TaskResponse["assignee"] = null;
    if (task.assigneeType && task.assigneeUuid) {
      const assigneeName = actorNames.get(task.assigneeUuid);
      if (assigneeName) {
        let assignedBy: { type: string; uuid: string; name: string } | null = null;
        if (task.assignedByUuid) {
          const assignedByName = actorNames.get(task.assignedByUuid);
          if (assignedByName) {
            assignedBy = { type: "user", uuid: task.assignedByUuid, name: assignedByName };
          }
        }
        assignee = {
          type: task.assigneeType,
          uuid: task.assigneeUuid,
          name: assigneeName,
          assignedAt: task.assignedAt?.toISOString() ?? null,
          assignedBy,
        };
      }
    }

    const createdBy = createdByMap.get(task.createdByUuid) ?? null;

    const dependsOn: TaskDependencyInfo[] = (task.dependsOn || []).map((d) => ({
      uuid: d.dependsOn.uuid,
      title: d.dependsOn.title,
      status: d.dependsOn.status,
    }));

    const dependedBy: TaskDependencyInfo[] = (task.dependedBy || []).map((d) => ({
      uuid: d.task.uuid,
      title: d.task.title,
      status: d.task.status,
    }));

    const criteriaItems = (task.acceptanceCriteriaItems || []).map(formatCriterionResponse);
    const { status: acceptanceStatus, summary: acceptanceSummary } = computeAcceptanceStatus(
      task.acceptanceCriteriaItems || [],
    );

    return {
      uuid: task.uuid,
      title: task.title,
      description: task.description,
      status: task.status,
      priority: task.priority,
      storyPoints: task.storyPoints,
      acceptanceCriteria: task.acceptanceCriteria,
      acceptanceCriteriaItems: criteriaItems,
      acceptanceStatus,
      acceptanceSummary,
      assignee,
      proposalUuid: task.proposalUuid,
      ...(task.project && { project: task.project }),
      createdBy,
      dependsOn,
      dependedBy,
      commentCount: commentCounts[task.uuid] ?? 0,
      createdAt: task.createdAt.toISOString(),
      updatedAt: task.updatedAt.toISOString(),
    };
  });
}

// ===== Dependency relation include template =====

const dependencyInclude = {
  dependsOn: {
    select: {
      dependsOn: { select: { uuid: true, title: true, status: true } },
    },
  },
  dependedBy: {
    select: {
      task: { select: { uuid: true, title: true, status: true } },
    },
  },
  acceptanceCriteriaItems: {
    orderBy: { sortOrder: "asc" as const },
  },
} as const;

// ===== Service Methods =====

// List tasks query
export async function listTasks({
  companyUuid,
  projectUuid,
  skip,
  take,
  status,
  priority,
  proposalUuids,
}: TaskListParams): Promise<{ tasks: TaskResponse[]; total: number }> {
  const where = {
    projectUuid,
    companyUuid,
    ...(status && { status }),
    ...(priority && { priority }),
    ...(proposalUuids && proposalUuids.length > 0 && { proposalUuid: { in: proposalUuids } }),
  };

  const [rawTasks, total] = await Promise.all([
    prisma.task.findMany({
      where,
      skip,
      take,
      orderBy: [{ priority: "desc" }, { createdAt: "desc" }],
      select: {
        uuid: true,
        title: true,
        description: true,
        status: true,
        priority: true,
        storyPoints: true,
        acceptanceCriteria: true,
        assigneeType: true,
        assigneeUuid: true,
        assignedAt: true,
        assignedByUuid: true,
        proposalUuid: true,
        createdByUuid: true,
        createdAt: true,
        updatedAt: true,
        ...dependencyInclude,
      },
    }),
    prisma.task.count({ where }),
  ]);

  // Batch-fetch comment counts for all tasks in one query
  const commentCounts = await batchCommentCounts(
    companyUuid,
    "task",
    rawTasks.map((t) => t.uuid),
  );

  // Batch format: 2 queries total instead of N * (3-4)
  const tasks = await formatTaskResponsesBatch(rawTasks, commentCounts);
  return { tasks, total };
}

// Get Task details
export async function getTask(
  companyUuid: string,
  uuid: string
): Promise<TaskResponse | null> {
  const task = await prisma.task.findFirst({
    where: { uuid, companyUuid },
    include: {
      project: { select: { uuid: true, name: true } },
      ...dependencyInclude,
    },
  });

  if (!task) return null;

  const commentCount = await prisma.comment.count({
    where: { companyUuid, targetType: "task", targetUuid: uuid },
  });

  return formatTaskResponse(task, commentCount);
}

// Get raw Task data by UUID (internal use, for permission checks etc.)
export async function getTaskByUuid(companyUuid: string, uuid: string) {
  return prisma.task.findFirst({
    where: { uuid, companyUuid },
  });
}

// Create Task
export async function createTask(params: TaskCreateParams): Promise<TaskResponse> {
  const task = await prisma.task.create({
    data: {
      companyUuid: params.companyUuid,
      projectUuid: params.projectUuid,
      title: params.title,
      description: params.description,
      status: "open",
      priority: params.priority || "medium",
      storyPoints: params.storyPoints,
      acceptanceCriteria: params.acceptanceCriteria,
      proposalUuid: params.proposalUuid,
      createdByUuid: params.createdByUuid,
    },
    select: {
      uuid: true,
      title: true,
      description: true,
      status: true,
      priority: true,
      storyPoints: true,
      acceptanceCriteria: true,
      assigneeType: true,
      assigneeUuid: true,
      assignedAt: true,
      assignedByUuid: true,
      proposalUuid: true,
      createdByUuid: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  eventBus.emitChange({ companyUuid: params.companyUuid, projectUuid: params.projectUuid, entityType: "task", entityUuid: task.uuid, action: "created" });

  return formatTaskResponse(task);
}

// Update Task
export async function updateTask(
  uuid: string,
  data: TaskUpdateParams,
  actorContext?: { actorType: string; actorUuid: string }
): Promise<TaskResponse> {
  // If description is being updated and we have actor context, capture old description for mention diffing
  let oldDescription: string | null = null;
  if (data.description !== undefined && actorContext) {
    const existing = await prisma.task.findUnique({ where: { uuid }, select: { description: true } });
    oldDescription = existing?.description ?? null;
  }

  // If moving FROM to_verify to any status EXCEPT done, reset acceptance criteria
  // Wrapped in transaction to prevent TOCTOU race condition
  const task = await prisma.$transaction(async (tx) => {
    if (data.status && data.status !== "done") {
      const current = await tx.task.findUnique({ where: { uuid }, select: { status: true } });
      if (current?.status === "to_verify") {
        await tx.acceptanceCriterion.updateMany({
          where: { taskUuid: uuid },
          data: {
            status: "pending",
            evidence: null,
            markedByType: null,
            markedBy: null,
            markedAt: null,
            devStatus: "pending",
            devEvidence: null,
            devMarkedByType: null,
            devMarkedBy: null,
            devMarkedAt: null,
          },
        });
      }
    }

    return tx.task.update({
      where: { uuid },
      data,
      include: {
        project: { select: { uuid: true, name: true } },
      },
    });
  });

  eventBus.emitChange({ companyUuid: task.companyUuid, projectUuid: task.project.uuid, entityType: "task", entityUuid: task.uuid, action: "updated" });

  // Process new @mentions in description (append-only: only new mentions)
  if (data.description !== undefined && actorContext && data.description) {
    processNewMentions(
      task.companyUuid,
      task.project.uuid,
      "task",
      task.uuid,
      task.title,
      oldDescription,
      data.description,
      actorContext.actorType,
      actorContext.actorUuid,
    ).catch((err) => logger.error({ err }, "Failed to process task mentions"));
  }

  return formatTaskResponse(task);
}

// Claim Task (atomic: only succeeds if status is "open")
export async function claimTask({
  taskUuid,
  companyUuid,
  assigneeType,
  assigneeUuid,
  assignedByUuid,
}: TaskClaimParams): Promise<TaskResponse> {
  try {
    const task = await prisma.task.update({
      where: { uuid: taskUuid, status: { in: ["open", "assigned"] } },
      data: {
        status: "assigned",
        assigneeType,
        assigneeUuid,
        assignedAt: new Date(),
        assignedByUuid,
      },
      include: {
        project: { select: { uuid: true, name: true } },
      },
    });

    eventBus.emitChange({ companyUuid: task.companyUuid, projectUuid: task.project.uuid, entityType: "task", entityUuid: task.uuid, action: "updated" });

    return formatTaskResponse(task);
  } catch (e: unknown) {
    if (isPrismaNotFound(e)) {
      throw new AlreadyClaimedError("Task");
    }
    throw e;
  }
}

// Release Task (atomic: only succeeds if status is "assigned")
export async function releaseTask(uuid: string): Promise<TaskResponse> {
  try {
    const task = await prisma.task.update({
      where: { uuid, status: "assigned" },
      data: {
        status: "open",
        assigneeType: null,
        assigneeUuid: null,
        assignedAt: null,
        assignedByUuid: null,
      },
      include: {
        project: { select: { uuid: true, name: true } },
      },
    });

    eventBus.emitChange({ companyUuid: task.companyUuid, projectUuid: task.project.uuid, entityType: "task", entityUuid: task.uuid, action: "updated" });

    return formatTaskResponse(task);
  } catch (e: unknown) {
    if (isPrismaNotFound(e)) {
      throw new NotClaimedError("Task");
    }
    throw e;
  }
}

// Delete Task
export async function deleteTask(uuid: string) {
  const task = await prisma.task.delete({ where: { uuid } });
  eventBus.emitChange({ companyUuid: task.companyUuid, projectUuid: task.projectUuid, entityType: "task", entityUuid: task.uuid, action: "deleted" });
  return task;
}

// Batch create Tasks (used for Proposal approval)
// Accepts a task list with draftUuids, returns { tasks, draftToTaskUuidMap }
export async function createTasksFromProposal(
  companyUuid: string,
  projectUuid: string,
  proposalUuid: string,
  createdByUuid: string,
  tasks: Array<{ uuid?: string; title: string; description?: string; priority?: string; storyPoints?: number; acceptanceCriteria?: string }>
): Promise<{ tasks: TaskResponse[]; draftToTaskUuidMap: Map<string, string> }> {
  const draftToTaskUuidMap = new Map<string, string>();

  const createPromises = tasks.map((task) =>
    prisma.task.create({
      data: {
        companyUuid,
        projectUuid,
        title: task.title,
        description: task.description || null,
        status: "open",
        priority: task.priority || "medium",
        storyPoints: task.storyPoints || null,
        acceptanceCriteria: task.acceptanceCriteria || null,
        proposalUuid,
        createdByUuid,
      },
      select: {
        uuid: true,
        title: true,
        description: true,
        status: true,
        priority: true,
        storyPoints: true,
        acceptanceCriteria: true,
        assigneeType: true,
        assigneeUuid: true,
        assignedAt: true,
        assignedByUuid: true,
        proposalUuid: true,
        createdByUuid: true,
        createdAt: true,
        updatedAt: true,
      },
    })
  );

  const rawTasks = await Promise.all(createPromises);

  // Build draftUuid → taskUuid mapping
  for (let i = 0; i < tasks.length; i++) {
    if (tasks[i].uuid) {
      draftToTaskUuidMap.set(tasks[i].uuid!, rawTasks[i].uuid);
    }
  }

  const formattedTasks = await Promise.all(rawTasks.map(formatTaskResponse));
  return { tasks: formattedTasks, draftToTaskUuidMap };
}

// ===== Acceptance Criteria CRUD =====

// Bulk create acceptance criteria for a task (used by proposal approval flow)
export async function createAcceptanceCriteria(
  taskUuid: string,
  items: Array<{ description: string; required?: boolean; sortOrder?: number }>,
): Promise<AcceptanceCriterionResponse[]> {
  if (items.length === 0) return [];

  const createPromises = items.map((item, index) =>
    prisma.acceptanceCriterion.create({
      data: {
        taskUuid,
        description: item.description,
        required: item.required ?? true,
        sortOrder: item.sortOrder ?? index,
      },
    })
  );

  const created = await Promise.all(createPromises);
  return created.map(formatCriterionResponse);
}

// Admin/user marks verification status on acceptance criteria
export async function markAcceptanceCriteria(
  companyUuid: string,
  taskUuid: string,
  criteria: Array<{ uuid: string; status: "passed" | "failed"; evidence?: string }>,
  auth: { type: string; actorUuid: string },
): Promise<{ items: AcceptanceCriterionResponse[]; status: string; summary: AcceptanceSummary }> {
  // Validate task belongs to company
  const task = await prisma.task.findFirst({ where: { uuid: taskUuid, companyUuid } });
  if (!task) throw new Error("Task not found");

  // Pre-validate all criterion UUIDs belong to this task
  const validUuids = new Set(
    (await prisma.acceptanceCriterion.findMany({ where: { taskUuid }, select: { uuid: true } })).map((r) => r.uuid),
  );
  for (const c of criteria) {
    if (!validUuids.has(c.uuid)) throw new Error(`Criterion ${c.uuid} does not belong to task ${taskUuid}`);
  }

  // Update each criterion
  for (const c of criteria) {
    await prisma.acceptanceCriterion.update({
      where: { uuid: c.uuid },
      data: {
        status: c.status,
        evidence: c.evidence ?? null,
        markedByType: auth.type,
        markedBy: auth.actorUuid,
        markedAt: new Date(),
      },
    });
  }

  // Notify UI of criteria change
  eventBus.emitChange({ companyUuid, projectUuid: task.projectUuid, entityType: "task", entityUuid: taskUuid, action: "updated" });

  // Return updated state
  return getAcceptanceStatus(companyUuid, taskUuid);
}

// Dev agent reports self-check on acceptance criteria
export async function reportCriteriaSelfCheck(
  companyUuid: string,
  taskUuid: string,
  criteria: Array<{ uuid: string; devStatus: "passed" | "failed"; devEvidence?: string }>,
  auth: { type: string; actorUuid: string },
): Promise<{ items: AcceptanceCriterionResponse[]; status: string; summary: AcceptanceSummary }> {
  // Validate task belongs to company
  const task = await prisma.task.findFirst({ where: { uuid: taskUuid, companyUuid } });
  if (!task) throw new Error("Task not found");

  // Pre-validate all criterion UUIDs belong to this task
  const validUuids = new Set(
    (await prisma.acceptanceCriterion.findMany({ where: { taskUuid }, select: { uuid: true } })).map((r) => r.uuid),
  );
  for (const c of criteria) {
    if (!validUuids.has(c.uuid)) throw new Error(`Criterion ${c.uuid} does not belong to task ${taskUuid}`);
  }

  // Update each criterion
  for (const c of criteria) {
    await prisma.acceptanceCriterion.update({
      where: { uuid: c.uuid },
      data: {
        devStatus: c.devStatus,
        devEvidence: c.devEvidence ?? null,
        devMarkedByType: auth.type,
        devMarkedBy: auth.actorUuid,
        devMarkedAt: new Date(),
      },
    });
  }

  // Notify UI of criteria change
  eventBus.emitChange({ companyUuid, projectUuid: task.projectUuid, entityType: "task", entityUuid: taskUuid, action: "updated" });

  // Return updated state
  return getAcceptanceStatus(companyUuid, taskUuid);
}

// Reset a single acceptance criterion back to pending (admin/user undo)
export async function resetAcceptanceCriterion(
  companyUuid: string,
  taskUuid: string,
  criterionUuid: string,
): Promise<void> {
  const task = await prisma.task.findFirst({ where: { uuid: taskUuid, companyUuid } });
  if (!task) throw new Error("Task not found");

  // Validate criterion belongs to this task
  const criterion = await prisma.acceptanceCriterion.findFirst({ where: { uuid: criterionUuid, taskUuid } });
  if (!criterion) throw new Error("Criterion not found for this task");

  await prisma.acceptanceCriterion.update({
    where: { uuid: criterionUuid },
    data: {
      status: "pending",
      evidence: null,
      markedByType: null,
      markedBy: null,
      markedAt: null,
    },
  });

  eventBus.emitChange({ companyUuid, projectUuid: task.projectUuid, entityType: "task", entityUuid: taskUuid, action: "updated" });
}

// Get acceptance status for a task
export async function getAcceptanceStatus(
  companyUuid: string,
  taskUuid: string,
): Promise<{ items: AcceptanceCriterionResponse[]; status: string; summary: AcceptanceSummary }> {
  // Validate task belongs to company
  const task = await prisma.task.findFirst({ where: { uuid: taskUuid, companyUuid } });
  if (!task) throw new Error("Task not found");

  const rows = await prisma.acceptanceCriterion.findMany({
    where: { taskUuid },
    orderBy: { sortOrder: "asc" },
  });

  const items = rows.map(formatCriterionResponse);
  const { status, summary } = computeAcceptanceStatus(rows);

  return { items, status, summary };
}

// Check acceptance criteria gate for verify→done transition
export async function checkAcceptanceCriteriaGate(
  taskUuid: string,
): Promise<{ allowed: boolean; reason?: string; summary?: AcceptanceSummary; unresolvedCriteria?: AcceptanceCriterionResponse[] }> {
  const rows = await prisma.acceptanceCriterion.findMany({
    where: { taskUuid },
    orderBy: { sortOrder: "asc" },
  });

  // No criteria rows = backward compat, allow transition
  if (rows.length === 0) {
    return { allowed: true };
  }

  const requiredRows = rows.filter((r) => r.required);
  const allRequiredPassed = requiredRows.every((r) => r.status === "passed");

  if (allRequiredPassed) {
    return { allowed: true };
  }

  const { summary } = computeAcceptanceStatus(rows);

  // Return unresolved criteria — required items that are not passed (these block the gate)
  const unresolved = rows
    .filter((r) => r.required && r.status !== "passed")
    .map(formatCriterionResponse);

  return {
    allowed: false,
    reason: `Not all required acceptance criteria are passed. Required: ${summary.required}, Passed: ${summary.requiredPassed}, Failed: ${summary.requiredFailed}, Pending: ${summary.requiredPending}`,
    summary,
    unresolvedCriteria: unresolved,
  };
}

// ===== Mention Processing (append-only) =====

// Process new @mentions by diffing old vs new content
async function processNewMentions(
  companyUuid: string,
  projectUuid: string,
  sourceType: "task" | "idea",
  sourceUuid: string,
  entityTitle: string,
  oldContent: string | null,
  newContent: string,
  actorType: string,
  actorUuid: string,
): Promise<void> {
  const oldMentions = oldContent ? mentionService.parseMentions(oldContent) : [];
  const newMentions = mentionService.parseMentions(newContent);

  // Find only truly new mentions (not in old set)
  const oldKeys = new Set(oldMentions.map((m) => `${m.type}:${m.uuid}`));
  const brandNewMentions = newMentions.filter((m) => !oldKeys.has(`${m.type}:${m.uuid}`));

  if (brandNewMentions.length === 0) return;

  // Build content with only new mentions for createMentions to process
  // We pass the full new content and let createMentions handle it, but we
  // need to ensure only new mentions create records. We do this by calling
  // createMentions with full new content (it deduplicates internally) and
  // then the records are created. Since this is append-only, we only run
  // when there are truly new mentions detected above.
  await mentionService.createMentions({
    companyUuid,
    sourceType,
    sourceUuid,
    content: newContent,
    actorType,
    actorUuid,
    projectUuid,
    entityTitle,
  });

  // Log activity for each new mention
  for (const mention of brandNewMentions) {
    if (mention.type === actorType && mention.uuid === actorUuid) continue;
    await activityService.createActivity({
      companyUuid,
      projectUuid,
      targetType: sourceType,
      targetUuid: sourceUuid,
      actorType,
      actorUuid,
      action: "mentioned",
      value: {
        mentionedType: mention.type,
        mentionedUuid: mention.uuid,
        mentionedName: mention.displayName,
        sourceType,
        sourceUuid,
      },
    });
  }
}

// ===== Dependency Management =====

// DFS cycle detection: check if targetUuid is reachable from startUuid via existing edges
async function wouldCreateCycle(
  startUuid: string,
  targetUuid: string
): Promise<boolean> {
  // Get all dependency edges within the project
  const allDeps = await prisma.taskDependency.findMany({
    select: { taskUuid: true, dependsOnUuid: true },
  });

  // Build adjacency list: taskUuid depends on dependsOnUuid
  // If adding edge: taskUuid=targetUuid -> dependsOnUuid=startUuid
  // Need to check if startUuid can reach targetUuid via existing edges
  const adjacency = new Map<string, string[]>();
  for (const dep of allDeps) {
    if (!adjacency.has(dep.taskUuid)) {
      adjacency.set(dep.taskUuid, []);
    }
    adjacency.get(dep.taskUuid)!.push(dep.dependsOnUuid);
  }

  // DFS from startUuid following existing edges (taskUuid -> dependsOnUuid)
  const visited = new Set<string>();
  const stack = [startUuid];

  while (stack.length > 0) {
    const current = stack.pop()!;
    if (current === targetUuid) return true;
    if (visited.has(current)) continue;
    visited.add(current);

    const neighbors = adjacency.get(current) || [];
    for (const neighbor of neighbors) {
      if (!visited.has(neighbor)) {
        stack.push(neighbor);
      }
    }
  }

  return false;
}

// Add task dependency
export async function addTaskDependency(
  companyUuid: string,
  taskUuid: string,
  dependsOnUuid: string
): Promise<{ taskUuid: string; dependsOnUuid: string; createdAt: Date }> {
  // Cannot depend on itself
  if (taskUuid === dependsOnUuid) {
    throw new Error("A task cannot depend on itself");
  }

  // Verify both tasks exist and belong to the same project
  const [task, dependsOnTask] = await Promise.all([
    prisma.task.findFirst({ where: { uuid: taskUuid, companyUuid } }),
    prisma.task.findFirst({ where: { uuid: dependsOnUuid, companyUuid } }),
  ]);

  if (!task) throw new Error("Task not found");
  if (!dependsOnTask) throw new Error("Dependency task not found");

  if (task.projectUuid !== dependsOnTask.projectUuid) {
    throw new Error("Tasks must belong to the same project");
  }

  // Cycle detection: if adding the edge taskUuid -> dependsOnUuid,
  // check if dependsOnUuid can reach taskUuid via existing edges (forming a cycle)
  const cycleDetected = await wouldCreateCycle(dependsOnUuid, taskUuid);
  if (cycleDetected) {
    throw new Error("Adding this dependency would create a cycle");
  }

  const dep = await prisma.taskDependency.create({
    data: { taskUuid, dependsOnUuid },
  });

  return { taskUuid: dep.taskUuid, dependsOnUuid: dep.dependsOnUuid, createdAt: dep.createdAt };
}

// Remove task dependency
export async function removeTaskDependency(
  companyUuid: string,
  taskUuid: string,
  dependsOnUuid: string
): Promise<void> {
  // Verify task belongs to this company
  const task = await prisma.task.findFirst({ where: { uuid: taskUuid, companyUuid } });
  if (!task) throw new Error("Task not found");

  await prisma.taskDependency.deleteMany({
    where: { taskUuid, dependsOnUuid },
  });
}

// Get task dependencies
export async function getTaskDependencies(
  companyUuid: string,
  taskUuid: string
): Promise<{ dependsOn: TaskDependencyInfo[]; dependedBy: TaskDependencyInfo[] }> {
  const task = await prisma.task.findFirst({
    where: { uuid: taskUuid, companyUuid },
    include: dependencyInclude,
  });

  if (!task) throw new Error("Task not found");

  return {
    dependsOn: task.dependsOn.map((d) => ({
      uuid: d.dependsOn.uuid,
      title: d.dependsOn.title,
      status: d.dependsOn.status,
    })),
    dependedBy: task.dependedBy.map((d) => ({
      uuid: d.task.uuid,
      title: d.task.title,
      status: d.task.status,
    })),
  };
}

// Get unblocked tasks (all dependencies are resolved)
export async function getUnblockedTasks({
  companyUuid,
  projectUuid,
  proposalUuids,
}: {
  companyUuid: string;
  projectUuid: string;
  proposalUuids?: string[];
}): Promise<{ tasks: TaskResponse[]; total: number }> {
  const where = {
    projectUuid,
    companyUuid,
    status: { in: ["open", "assigned"] },
    ...(proposalUuids && proposalUuids.length > 0 && { proposalUuid: { in: proposalUuids } }),
    // Exclude tasks that have any dependency NOT in done/closed
    NOT: {
      dependsOn: {
        some: {
          dependsOn: {
            status: { notIn: ["done", "closed"] },
          },
        },
      },
    },
  };

  const [rawTasks, total] = await Promise.all([
    prisma.task.findMany({
      where,
      orderBy: [{ priority: "desc" }, { createdAt: "desc" }],
      select: {
        uuid: true,
        title: true,
        description: true,
        status: true,
        priority: true,
        storyPoints: true,
        acceptanceCriteria: true,
        assigneeType: true,
        assigneeUuid: true,
        assignedAt: true,
        assignedByUuid: true,
        proposalUuid: true,
        createdByUuid: true,
        createdAt: true,
        updatedAt: true,
        ...dependencyInclude,
      },
    }),
    prisma.task.count({ where }),
  ]);

  const commentCounts = await batchCommentCounts(
    companyUuid,
    "task",
    rawTasks.map((t) => t.uuid),
  );

  // Batch format: 2 queries total instead of N * (3-4)
  const tasks = await formatTaskResponsesBatch(rawTasks, commentCounts);
  return { tasks, total };
}

// Blocker info for unresolved dependencies
export interface BlockerInfo {
  uuid: string;
  title: string;
  status: string;
  assignee: { type: string; uuid: string; name: string } | null;
  sessionCheckin: { sessionUuid: string; sessionName: string } | null;
}

// Check if all dependencies of a task are resolved (done or closed)
export async function checkDependenciesResolved(
  taskUuid: string
): Promise<{ resolved: boolean; blockers: BlockerInfo[] }> {
  const deps = await prisma.taskDependency.findMany({
    where: { taskUuid },
    select: {
      dependsOn: {
        select: {
          uuid: true,
          title: true,
          status: true,
          assigneeType: true,
          assigneeUuid: true,
        },
      },
    },
  });

  if (deps.length === 0) {
    return { resolved: true, blockers: [] };
  }

  const unresolvedDeps = deps.filter(
    (d) => d.dependsOn.status !== "done" && d.dependsOn.status !== "closed"
  );

  if (unresolvedDeps.length === 0) {
    return { resolved: true, blockers: [] };
  }

  // Get assignee names and session checkins for unresolved deps
  const unresolvedUuids = unresolvedDeps.map((d) => d.dependsOn.uuid);

  const [checkins, actorNames] = await Promise.all([
    prisma.sessionTaskCheckin.findMany({
      where: {
        taskUuid: { in: unresolvedUuids },
        checkoutAt: null,
      },
      select: {
        taskUuid: true,
        sessionUuid: true,
        session: { select: { name: true } },
      },
    }),
    batchGetActorNames(
      unresolvedDeps
        .filter((d) => d.dependsOn.assigneeType && d.dependsOn.assigneeUuid)
        .map((d) => ({ type: d.dependsOn.assigneeType!, uuid: d.dependsOn.assigneeUuid! }))
    ),
  ]);

  // Build checkin lookup by taskUuid
  const checkinMap = new Map<string, { sessionUuid: string; sessionName: string }>();
  for (const c of checkins) {
    checkinMap.set(c.taskUuid, { sessionUuid: c.sessionUuid, sessionName: c.session.name });
  }

  const blockers: BlockerInfo[] = unresolvedDeps.map((d) => {
    const task = d.dependsOn;
    let assignee: BlockerInfo["assignee"] = null;
    if (task.assigneeType && task.assigneeUuid) {
      const name = actorNames.get(task.assigneeUuid);
      if (name) {
        assignee = { type: task.assigneeType, uuid: task.assigneeUuid, name };
      }
    }

    return {
      uuid: task.uuid,
      title: task.title,
      status: task.status,
      assignee,
      sessionCheckin: checkinMap.get(task.uuid) ?? null,
    };
  });

  return { resolved: false, blockers };
}

// Get all task dependencies within a project (for DAG visualization)
export async function getProjectTaskDependencies(
  companyUuid: string,
  projectUuid: string
): Promise<{
  nodes: Array<{ uuid: string; title: string; status: string; priority: string; proposalUuid: string | null }>;
  edges: Array<{ from: string; to: string }>;
}> {
  const [tasks, dependencies] = await Promise.all([
    prisma.task.findMany({
      where: { companyUuid, projectUuid },
      select: { uuid: true, title: true, status: true, priority: true, proposalUuid: true },
    }),
    prisma.taskDependency.findMany({
      where: {
        task: { companyUuid, projectUuid },
      },
      select: { taskUuid: true, dependsOnUuid: true },
    }),
  ]);

  return {
    nodes: tasks.map((t) => ({
      uuid: t.uuid,
      title: t.title,
      status: t.status,
      priority: t.priority,
      proposalUuid: t.proposalUuid ?? null,
    })),
    edges: dependencies.map((d) => ({
      from: d.taskUuid,
      to: d.dependsOnUuid,
    })),
  };
}
