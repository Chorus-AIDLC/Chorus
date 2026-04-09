// src/services/project.service.ts
// Project Service Layer (ARCHITECTURE.md §3.1 Service Layer)
// UUID-Based Architecture: All operations use UUIDs

import { prisma } from "@/lib/prisma";
import { eventBus } from "@/lib/event-bus";

export interface ProjectListParams {
  companyUuid: string;
  skip: number;
  take: number;
}

export interface ProjectCreateParams {
  companyUuid: string;
  name: string;
  description?: string | null;
  groupUuid?: string | null;
}

export interface ProjectUpdateParams {
  name?: string;
  description?: string | null;
}

// List projects query
export async function listProjects({ companyUuid, skip, take }: ProjectListParams) {
  const [projects, total] = await Promise.all([
    prisma.project.findMany({
      where: { companyUuid },
      skip,
      take,
      orderBy: { updatedAt: "desc" },
      select: {
        uuid: true,
        name: true,
        description: true,
        groupUuid: true,
        createdAt: true,
        updatedAt: true,
        _count: {
          select: {
            ideas: true,
            documents: true,
            tasks: true,
            proposals: true,
          },
        },
      },
    }),
    prisma.project.count({ where: { companyUuid } }),
  ]);

  return { projects, total };
}

// Get project details
export async function getProject(companyUuid: string, uuid: string) {
  return prisma.project.findFirst({
    where: { uuid, companyUuid },
    select: {
      uuid: true,
      name: true,
      description: true,
      groupUuid: true,
      createdAt: true,
      updatedAt: true,
      _count: {
        select: {
          ideas: true,
          documents: true,
          tasks: true,
          proposals: true,
          activities: true,
        },
      },
    },
  });
}

// Verify if project exists
export async function projectExists(companyUuid: string, projectUuid: string): Promise<boolean> {
  const project = await prisma.project.findFirst({
    where: { uuid: projectUuid, companyUuid },
    select: { uuid: true },
  });
  return !!project;
}

// Get basic project info by UUID
export async function getProjectByUuid(companyUuid: string, uuid: string) {
  return prisma.project.findFirst({
    where: { uuid, companyUuid },
    select: { uuid: true, name: true },
  });
}

// Get project UUIDs by group UUID
export async function getProjectUuidsByGroup(companyUuid: string, groupUuid: string): Promise<string[]> {
  const projects = await prisma.project.findMany({
    where: {
      companyUuid,
      groupUuid,
    },
    select: { uuid: true },
  });
  return projects.map((p) => p.uuid);
}

// Create project
export async function createProject({ companyUuid, name, description, groupUuid }: ProjectCreateParams) {
  const project = await prisma.project.create({
    data: { companyUuid, name, description, groupUuid: groupUuid ?? null },
    select: {
      uuid: true,
      name: true,
      description: true,
      groupUuid: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  eventBus.emitChange({
    companyUuid,
    projectUuid: project.uuid,
    entityType: "project",
    entityUuid: project.uuid,
    action: "created",
  });

  return project;
}

// Update project (scoped by companyUuid for multi-tenancy defense-in-depth)
export async function updateProject(companyUuid: string, uuid: string, data: ProjectUpdateParams) {
  // Verify ownership atomically before updating
  const project = await prisma.project.findFirst({
    where: { uuid, companyUuid },
    select: { uuid: true },
  });
  if (!project) return null;

  return prisma.project.update({
    where: { uuid: project.uuid },
    data,
    select: {
      uuid: true,
      name: true,
      description: true,
      createdAt: true,
      updatedAt: true,
    },
  });
}

// Delete project (scoped by companyUuid for multi-tenancy defense-in-depth)
export async function deleteProject(companyUuid: string, uuid: string) {
  const project = await prisma.project.findFirst({
    where: { uuid, companyUuid },
    select: { uuid: true },
  });
  if (!project) return false;

  await prisma.project.delete({ where: { uuid: project.uuid } });

  eventBus.emitChange({
    companyUuid,
    projectUuid: uuid,
    entityType: "project",
    entityUuid: uuid,
    action: "deleted",
  });

  return true;
}

// Get company-level overview stats (for Projects list page)
export async function getCompanyOverviewStats(companyUuid: string) {
  const [projectCount, taskCount, openProposalCount, ideaCount] = await Promise.all([
    prisma.project.count({ where: { companyUuid } }),
    prisma.task.count({ where: { companyUuid } }),
    prisma.proposal.count({ where: { companyUuid, status: "pending" } }),
    prisma.idea.count({ where: { companyUuid } }),
  ]);

  return {
    projects: projectCount,
    tasks: taskCount,
    openProposals: openProposalCount,
    ideas: ideaCount,
  };
}

// Get project list with task completion stats (for Projects list page)
export async function listProjectsWithStats({ companyUuid, skip, take }: ProjectListParams) {
  const { projects, total } = await listProjects({ companyUuid, skip, take });

  // Batch query completed task count for each project
  const projectUuids = projects.map((p) => p.uuid);
  const doneCounts = await prisma.task.groupBy({
    by: ["projectUuid"],
    where: { companyUuid, projectUuid: { in: projectUuids }, status: "done" },
    _count: true,
  });
  const doneMap = new Map(doneCounts.map((d) => [d.projectUuid, d._count]));

  return {
    projects: projects.map((p) => ({
      ...p,
      tasksDone: doneMap.get(p.uuid) || 0,
    })),
    total,
  };
}

// Get project statistics (for Dashboard)
export async function getProjectStats(companyUuid: string, projectUuid: string) {
  const [ideasStats, tasksStats, proposalsStats, documentsCount] = await Promise.all([
    // Ideas stats
    prisma.idea.groupBy({
      by: ["status"],
      where: { projectUuid, companyUuid },
      _count: true,
    }),
    // Tasks stats
    prisma.task.groupBy({
      by: ["status"],
      where: { projectUuid, companyUuid },
      _count: true,
    }),
    // Proposals stats
    prisma.proposal.groupBy({
      by: ["status"],
      where: { projectUuid, companyUuid },
      _count: true,
    }),
    // Documents total count
    prisma.document.count({
      where: { projectUuid, companyUuid },
    }),
  ]);

  // Parse Ideas stats
  const ideaStatusMap = new Map(ideasStats.map((s) => [s.status, s._count]));
  const ideasTotal = ideasStats.reduce((sum, s) => sum + s._count, 0);
  const ideasOpen = ideaStatusMap.get("open") || 0;

  // Parse Tasks stats (per-status for pipeline visualization)
  const taskStatusMap = new Map(tasksStats.map((s) => [s.status, s._count]));
  const tasksTotal = tasksStats.reduce((sum, s) => sum + s._count, 0);
  const tasksInProgress = taskStatusMap.get("in_progress") || 0;
  const tasksTodo = (taskStatusMap.get("open") || 0) + (taskStatusMap.get("assigned") || 0);
  const tasksToVerify = taskStatusMap.get("to_verify") || 0;
  const tasksDone = (taskStatusMap.get("done") || 0) + (taskStatusMap.get("closed") || 0);

  // Parse Proposals stats
  const proposalStatusMap = new Map(proposalsStats.map((s) => [s.status, s._count]));
  const proposalsTotal = proposalsStats.reduce((sum, s) => sum + s._count, 0);
  const proposalsPending = proposalStatusMap.get("pending") || 0;

  return {
    ideas: { total: ideasTotal, open: ideasOpen },
    tasks: { total: tasksTotal, inProgress: tasksInProgress, todo: tasksTodo, toVerify: tasksToVerify, done: tasksDone },
    proposals: { total: proposalsTotal, pending: proposalsPending },
    documents: { total: documentsCount },
  };
}
