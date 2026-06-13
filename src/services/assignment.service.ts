// src/services/assignment.service.ts
// Assignment Service Layer - Agent self-service queries (PRD §5.4)
// UUID-Based Architecture: All operations use UUIDs

import { prisma } from "@/lib/prisma";
import type { AuthContext } from "@/types/auth";
import { formatCreatedBy } from "@/lib/uuid-resolver";
import {
  buildIdeaTracker,
  buildTaskTracker,
  type IdeaTrackerProject,
  type TaskTrackerProject,
} from "@/services/idea-tracker.service";

// ===== Type Definitions =====

// Available Idea response format
export interface AvailableIdeaResponse {
  uuid: string;
  title: string;
  content: string | null;
  status: string;
  parentUuid: string | null;
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

// My assignments response — 0.7.2: aligned with chorus_checkin.ideaTracker.
// Idea data is grouped by project with derivedStatus + proposal/task counts.
// Task data is similarly grouped, with admin-verified acceptance progress.
export interface MyAssignmentsResponse {
  ideaTracker: Record<string, IdeaTrackerProject>;
  taskTracker: Record<string, TaskTrackerProject>;
}

// Available items response
export interface AvailableItemsResponse {
  ideas: AvailableIdeaResponse[];
  tasks: AvailableTaskResponse[];
}

// ===== Internal Helper Functions =====

// Format available Idea
async function formatAvailableIdea(idea: {
  uuid: string;
  title: string;
  content: string | null;
  status: string;
  parentUuid: string | null;
  createdByUuid: string;
  createdAt: Date;
}): Promise<AvailableIdeaResponse> {
  const createdBy = await formatCreatedBy(idea.createdByUuid);

  return {
    uuid: idea.uuid,
    title: idea.title,
    content: idea.content,
    status: idea.status,
    parentUuid: idea.parentUuid ?? null,
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

/**
 * Get the agent's idea + task trackers, grouped by project. Aligned 1:1 with
 * chorus_checkin.ideaTracker (no maxIdeas cap here — checkin returns at most
 * 10 for compactness; my_assignments returns the full set).
 *
 * BREAKING (Chorus 0.7.2): the previous flat `{ ideas: [], tasks: [] }` shape
 * is replaced by `{ ideaTracker, taskTracker }`.
 */
export async function getMyAssignments(
  auth: AuthContext,
  projectUuids?: string[],
): Promise<MyAssignmentsResponse> {
  const [ideaTracker, taskTracker] = await Promise.all([
    buildIdeaTracker(auth, { projectUuids }),
    buildTaskTracker(auth, { projectUuids }),
  ]);

  return { ideaTracker, taskTracker };
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
            parentUuid: true,
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
