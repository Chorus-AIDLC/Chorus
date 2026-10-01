// src/services/project.service.ts
// Project Service Layer (ARCHITECTURE.md §3.1 Service Layer)
// UUID-Based Architecture: All operations use UUIDs

import { prisma } from "@/lib/prisma";
import { eventBus } from "@/lib/event-bus";
import * as activityService from "@/services/activity.service";
import {
  accessibleProjectWhere,
  accessibleProjectUuids,
  ProjectNotFoundError,
  type ProjectVisibility,
} from "@/services/project-access.service";
import type { AuthContext } from "@/types/auth";

export interface ProjectListParams {
  companyUuid: string;
  skip: number;
  take: number;
  auth?: AuthContext;
}

export interface ProjectCreateParams {
  companyUuid: string;
  name: string;
  description?: string | null;
  groupUuid?: string | null;
  visibility?: ProjectVisibility;
  // Creator User UUID (agents pass their owner). Becomes the project's first admin member.
  createdByUuid?: string | null;
  // Actor recorded on the project "created" Activity (the user, or the agent itself).
  actor?: { type: "user" | "agent"; uuid: string };
}

// Shared by every project-creation path (Access core: creator auto-admin).
// Must run inside the creating transaction.
export type ProjectDbClient = Omit<typeof prisma, "$connect" | "$disconnect" | "$on" | "$transaction" | "$extends">;

export async function initProjectAccess(
  tx: ProjectDbClient,
  params: { companyUuid: string; projectUuid: string; createdByUuid?: string | null },
) {
  if (!params.createdByUuid) return;
  await tx.projectMember.create({
    data: {
      companyUuid: params.companyUuid,
      projectUuid: params.projectUuid,
      userUuid: params.createdByUuid,
      role: "admin",
      addedByUuid: params.createdByUuid,
    },
  });
}

// Projects had no creation Activity before access control; log one so the
// creator is auditable from now on. Written inside the creating transaction;
// call the returned publish() after commit.
export async function logProjectCreated(
  tx: ProjectDbClient,
  params: {
    companyUuid: string;
    projectUuid: string;
    visibility: string;
    actor?: { type: "user" | "agent"; uuid: string };
  },
): Promise<() => void> {
  if (!params.actor) return () => {};
  const { publish } = await activityService.createActivityInTx(tx, {
    companyUuid: params.companyUuid,
    projectUuid: params.projectUuid,
    targetType: "project",
    targetUuid: params.projectUuid,
    actorType: params.actor.type,
    actorUuid: params.actor.uuid,
    action: "created",
    value: { visibility: params.visibility },
  });
  return publish;
}

export interface ProjectUpdateParams {
  name?: string;
  description?: string | null;
}

// List projects query
export async function listProjects({ companyUuid, skip, take, auth }: ProjectListParams) {
  if (auth && auth.companyUuid !== companyUuid) throw new ProjectNotFoundError();
  const where = await accessibleProjectWhere(
    auth ?? { type: "agent", actorUuid: "", companyUuid },
  );
  const [projects, total] = await Promise.all([
    prisma.project.findMany({
      where,
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
    prisma.project.count({ where }),
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
export async function createProject({
  companyUuid,
  name,
  description,
  groupUuid,
  visibility = "public",
  createdByUuid,
  actor,
}: ProjectCreateParams) {
  if (visibility === "private" && !createdByUuid) {
    // Nobody could ever access it — reject at the service layer, not just in callers.
    throw new Error("A private project requires a creator");
  }
  const create = (client: ProjectDbClient) =>
    client.project.create({
      data: { companyUuid, name, description, groupUuid: groupUuid ?? null, visibility, createdByUuid: createdByUuid ?? null },
      select: {
        uuid: true,
        name: true,
        description: true,
        groupUuid: true,
        visibility: true,
        createdAt: true,
        updatedAt: true,
      },
    });
  // Project, creator membership and creation Activity commit together.
  let publishCreated = () => {};
  const project = createdByUuid || actor
    ? await prisma.$transaction(async (tx) => {
        const created = await create(tx);
        await initProjectAccess(tx, { companyUuid, projectUuid: created.uuid, createdByUuid });
        publishCreated = await logProjectCreated(tx, { companyUuid, projectUuid: created.uuid, visibility, actor });
        return created;
      })
    : await create(prisma);
  publishCreated();

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
export async function getCompanyOverviewStats(companyUuid: string, auth?: AuthContext) {
  if (auth && auth.companyUuid !== companyUuid) throw new ProjectNotFoundError();
  const projectUuids = await accessibleProjectUuids(
    auth ?? { type: "agent", actorUuid: "", companyUuid },
  );
  const where = { companyUuid, projectUuid: { in: projectUuids } };
  const [projectCount, taskCount, openProposalCount, ideaCount] = await Promise.all([
    prisma.project.count({ where: { companyUuid, uuid: { in: projectUuids } } }),
    prisma.task.count({ where }),
    prisma.proposal.count({ where: { ...where, status: "pending" } }),
    prisma.idea.count({ where }),
  ]);

  return {
    projects: projectCount,
    tasks: taskCount,
    openProposals: openProposalCount,
    ideas: ideaCount,
  };
}

// Get project list with task completion stats (for Projects list page)
export async function listProjectsWithStats({ companyUuid, skip, take, auth }: ProjectListParams) {
  const { projects, total } = await listProjects({ companyUuid, skip, take, auth });

  // Batch query completed task count for each project
  const projectUuids = projects.map((p) => p.uuid);
  const doneCounts = await prisma.task.groupBy({
    by: ["projectUuid"],
    where: { companyUuid, projectUuid: { in: projectUuids }, status: { in: ["done", "closed"] } },
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
