// src/services/assignment.service.ts
// Assignment Service Layer - Agent self-service queries (PRD §5.4)
// UUID-Based Architecture: All operations use UUIDs

import { prisma } from "@/lib/prisma";
import type { AuthContext } from "@/types/auth";
import { isAgent } from "@/lib/auth";
import { formatAssignee, formatCreatedBy } from "@/lib/uuid-resolver";

// ===== Type Definitions =====

// Claimed Idea response format
export interface AssignedIdeaResponse {
  uuid: string;
  title: string;
  content: string | null;
  status: string;
  assignee: { type: string; uuid: string; name: string } | null;
  assignedAt: string | null;
  project: { uuid: string; name: string };
  createdAt: string;
  updatedAt: string;
}

// Claimed Task response format
export interface AssignedTaskResponse {
  uuid: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  assignee: { type: string; uuid: string; name: string } | null;
  assignedAt: string | null;
  project: { uuid: string; name: string };
  createdAt: string;
  updatedAt: string;
}

// Available Idea response format
export interface AvailableIdeaResponse {
  uuid: string;
  title: string;
  content: string | null;
  status: string;
  createdBy: { type: string; uuid: string; name: string } | null;
  createdAt: string;
}

// Available Task response format
export interface AvailableTaskResponse {
  uuid: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  createdBy: { type: string; uuid: string; name: string } | null;
  createdAt: string;
}

// My assignments response
export interface MyAssignmentsResponse {
  ideas: AssignedIdeaResponse[];
  tasks: AssignedTaskResponse[];
}

// Available items response
export interface AvailableItemsResponse {
  ideas: AvailableIdeaResponse[];
  tasks: AvailableTaskResponse[];
}

// ===== Internal Helper Functions =====

// Get assignment conditions for the current user/Agent
function getAssignmentConditions(auth: AuthContext) {
  const conditions: Array<{ assigneeType: string; assigneeUuid: string }> = [];

  if (isAgent(auth)) {
    // Directly claimed by Agent
    conditions.push({ assigneeType: "agent", assigneeUuid: auth.actorUuid });
    // Claimed by Agent's Owner ("Assign to myself")
    if (auth.ownerUuid) {
      conditions.push({ assigneeType: "user", assigneeUuid: auth.ownerUuid });
    }
  } else {
    // Directly claimed by user
    conditions.push({ assigneeType: "user", assigneeUuid: auth.actorUuid });
  }

  return conditions;
}

// Format claimed Idea
async function formatAssignedIdea(idea: {
  uuid: string;
  title: string;
  content: string | null;
  status: string;
  assigneeType: string | null;
  assigneeUuid: string | null;
  assignedAt: Date | null;
  project: { uuid: string; name: string };
  createdAt: Date;
  updatedAt: Date;
}): Promise<AssignedIdeaResponse> {
  const assignee = await formatAssignee(idea.assigneeType, idea.assigneeUuid);

  return {
    uuid: idea.uuid,
    title: idea.title,
    content: idea.content,
    status: idea.status,
    assignee,
    assignedAt: idea.assignedAt?.toISOString() ?? null,
    project: idea.project,
    createdAt: idea.createdAt.toISOString(),
    updatedAt: idea.updatedAt.toISOString(),
  };
}

// Format claimed Task
async function formatAssignedTask(task: {
  uuid: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  assigneeType: string | null;
  assigneeUuid: string | null;
  assignedAt: Date | null;
  project: { uuid: string; name: string };
  createdAt: Date;
  updatedAt: Date;
}): Promise<AssignedTaskResponse> {
  const assignee = await formatAssignee(task.assigneeType, task.assigneeUuid);

  return {
    uuid: task.uuid,
    title: task.title,
    description: task.description,
    status: task.status,
    priority: task.priority,
    assignee,
    assignedAt: task.assignedAt?.toISOString() ?? null,
    project: task.project,
    createdAt: task.createdAt.toISOString(),
    updatedAt: task.updatedAt.toISOString(),
  };
}

// Format available Idea
async function formatAvailableIdea(idea: {
  uuid: string;
  title: string;
  content: string | null;
  status: string;
  createdByUuid: string;
  createdAt: Date;
}): Promise<AvailableIdeaResponse> {
  const createdBy = await formatCreatedBy(idea.createdByUuid);

  return {
    uuid: idea.uuid,
    title: idea.title,
    content: idea.content,
    status: idea.status,
    createdBy,
    createdAt: idea.createdAt.toISOString(),
  };
}

// Format available Task
async function formatAvailableTask(task: {
  uuid: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  createdByUuid: string;
  createdAt: Date;
}): Promise<AvailableTaskResponse> {
  const createdBy = await formatCreatedBy(task.createdByUuid);

  return {
    uuid: task.uuid,
    title: task.title,
    description: task.description,
    status: task.status,
    priority: task.priority,
    createdBy,
    createdAt: task.createdAt.toISOString(),
  };
}

// ===== Service Methods =====

// Get my claimed Ideas + Tasks
export async function getMyAssignments(
  auth: AuthContext,
  projectUuids?: string[],
): Promise<MyAssignmentsResponse> {
  const conditions = getAssignmentConditions(auth);

  const [rawIdeas, rawTasks] = await Promise.all([
    // Get claimed Ideas
    prisma.idea.findMany({
      where: {
        companyUuid: auth.companyUuid,
        ...(projectUuids && projectUuids.length > 0 && { projectUuid: { in: projectUuids } }),
        OR: conditions,
        status: { notIn: ["completed", "closed"] },
      },
      select: {
        uuid: true,
        title: true,
        content: true,
        status: true,
        assigneeType: true,
        assigneeUuid: true,
        assignedAt: true,
        project: { select: { uuid: true, name: true } },
        createdAt: true,
        updatedAt: true,
      },
      orderBy: { assignedAt: "desc" },
    }),
    // Get claimed Tasks
    prisma.task.findMany({
      where: {
        companyUuid: auth.companyUuid,
        ...(projectUuids && projectUuids.length > 0 && { projectUuid: { in: projectUuids } }),
        OR: conditions,
        status: { notIn: ["done", "closed"] },
      },
      select: {
        uuid: true,
        title: true,
        description: true,
        status: true,
        priority: true,
        assigneeType: true,
        assigneeUuid: true,
        assignedAt: true,
        project: { select: { uuid: true, name: true } },
        createdAt: true,
        updatedAt: true,
      },
      orderBy: [{ priority: "desc" }, { assignedAt: "desc" }],
    }),
  ]);

  const [ideas, tasks] = await Promise.all([
    Promise.all(rawIdeas.map(formatAssignedIdea)),
    Promise.all(rawTasks.map(formatAssignedTask)),
  ]);

  return { ideas, tasks };
}

// Get available Ideas + Tasks in a project
export async function getAvailableItems(
  companyUuid: string,
  projectUuid: string,
  canClaimIdeas: boolean,
  canClaimTasks: boolean,
  proposalUuids?: string[],
): Promise<AvailableItemsResponse> {
  const baseWhere = { projectUuid, companyUuid, status: "open" };
  const taskWhere = {
    ...baseWhere,
    ...(proposalUuids && proposalUuids.length > 0 && { proposalUuid: { in: proposalUuids } }),
  };

  const [rawIdeas, rawTasks] = await Promise.all([
    canClaimIdeas
      ? prisma.idea.findMany({
          where: baseWhere,
          select: {
            uuid: true,
            title: true,
            content: true,
            status: true,
            createdByUuid: true,
            createdAt: true,
          },
          orderBy: { createdAt: "desc" },
          take: 50,
        })
      : [],
    canClaimTasks
      ? prisma.task.findMany({
          where: taskWhere,
          select: {
            uuid: true,
            title: true,
            description: true,
            status: true,
            priority: true,
            createdByUuid: true,
            createdAt: true,
          },
          orderBy: [{ priority: "desc" }, { createdAt: "desc" }],
          take: 50,
        })
      : [],
  ]);

  const [ideas, tasks] = await Promise.all([
    Promise.all(rawIdeas.map(formatAvailableIdea)),
    Promise.all(rawTasks.map(formatAvailableTask)),
  ]);

  return { ideas, tasks };
}
