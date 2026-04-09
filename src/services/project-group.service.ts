import { prisma } from "@/lib/prisma";
import { eventBus } from "@/lib/event-bus";

// ============================================================
// Interfaces
// ============================================================

export interface ProjectGroupCreateParams {
  companyUuid: string;
  name: string;
  description?: string | null;
}

export interface ProjectGroupUpdateParams {
  companyUuid: string;
  groupUuid: string;
  name?: string;
  description?: string | null;
}

export interface ProjectGroupResponse {
  uuid: string;
  name: string;
  description: string | null;
  projectCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectGroupDetailResponse extends ProjectGroupResponse {
  projects: {
    uuid: string;
    name: string;
    description: string | null;
  }[];
}

export interface GroupDashboardResponse {
  group: {
    uuid: string;
    name: string;
    description: string | null;
  };
  stats: {
    projectCount: number;
    totalTasks: number;
    completedTasks: number;
    completionRate: number;
    openIdeas: number;
    activeProposals: number;
  };
  projects: {
    uuid: string;
    name: string;
    taskCount: number;
    completionRate: number;
  }[];
  recentActivity: {
    uuid: string;
    projectUuid: string;
    projectName: string;
    targetType: string;
    targetUuid: string;
    action: string;
    value: unknown;
    actorType: string;
    actorUuid: string;
    createdAt: string;
  }[];
}

// ============================================================
// CRUD
// ============================================================

export async function createProjectGroup(
  params: ProjectGroupCreateParams
): Promise<ProjectGroupResponse> {
  const group = await prisma.projectGroup.create({
    data: {
      companyUuid: params.companyUuid,
      name: params.name,
      description: params.description ?? "",
    },
  });

  eventBus.emitChange({
    companyUuid: params.companyUuid,
    projectUuid: "",
    entityType: "project_group",
    entityUuid: group.uuid,
    action: "created",
  });

  return {
    uuid: group.uuid,
    name: group.name,
    description: group.description,
    projectCount: 0,
    createdAt: group.createdAt.toISOString(),
    updatedAt: group.updatedAt.toISOString(),
  };
}

export async function updateProjectGroup(
  params: ProjectGroupUpdateParams
): Promise<ProjectGroupResponse | null> {
  const existing = await prisma.projectGroup.findFirst({
    where: { uuid: params.groupUuid, companyUuid: params.companyUuid },
  });
  if (!existing) return null;

  const updated = await prisma.projectGroup.update({
    where: { uuid: params.groupUuid },
    data: {
      ...(params.name !== undefined && { name: params.name }),
      ...(params.description !== undefined && { description: params.description }),
    },
  });

  const projectCount = await prisma.project.count({
    where: { groupUuid: params.groupUuid, companyUuid: params.companyUuid },
  });

  return {
    uuid: updated.uuid,
    name: updated.name,
    description: updated.description,
    projectCount,
    createdAt: updated.createdAt.toISOString(),
    updatedAt: updated.updatedAt.toISOString(),
  };
}

export async function deleteProjectGroup(
  companyUuid: string,
  groupUuid: string,
  deleteProjects = false
): Promise<boolean> {
  const existing = await prisma.projectGroup.findFirst({
    where: { uuid: groupUuid, companyUuid },
  });
  if (!existing) return false;

  if (deleteProjects) {
    // Delete all projects in this group (cascade deletes their children)
    await prisma.project.deleteMany({
      where: { groupUuid, companyUuid },
    });
  } else {
    // Unassign all projects from this group (move to ungrouped)
    await prisma.project.updateMany({
      where: { groupUuid, companyUuid },
      data: { groupUuid: null },
    });
  }

  await prisma.projectGroup.delete({
    where: { uuid: groupUuid },
  });

  eventBus.emitChange({
    companyUuid,
    projectUuid: "",
    entityType: "project_group",
    entityUuid: groupUuid,
    action: "deleted",
  });

  return true;
}

export async function getProjectGroup(
  companyUuid: string,
  groupUuid: string
): Promise<ProjectGroupDetailResponse | null> {
  const group = await prisma.projectGroup.findFirst({
    where: { uuid: groupUuid, companyUuid },
  });
  if (!group) return null;

  const projects = await prisma.project.findMany({
    where: { groupUuid, companyUuid },
    select: { uuid: true, name: true, description: true },
    orderBy: { updatedAt: "desc" },
  });

  return {
    uuid: group.uuid,
    name: group.name,
    description: group.description,
    projectCount: projects.length,
    projects,
    createdAt: group.createdAt.toISOString(),
    updatedAt: group.updatedAt.toISOString(),
  };
}

export async function listProjectGroups(
  companyUuid: string
): Promise<{ groups: ProjectGroupResponse[]; total: number; ungroupedCount: number }> {
  const groups = await prisma.projectGroup.findMany({
    where: { companyUuid },
    orderBy: { createdAt: "asc" },
  });

  // Batch count projects per group
  const groupUuids = groups.map((g) => g.uuid);
  const projectCounts =
    groupUuids.length > 0
      ? await prisma.project.groupBy({
          by: ["groupUuid"],
          where: { companyUuid, groupUuid: { in: groupUuids } },
          _count: { _all: true },
        })
      : [];

  const countMap = new Map(
    projectCounts.map((pc) => [pc.groupUuid, pc._count._all])
  );

  const result: ProjectGroupResponse[] = groups.map((g) => ({
    uuid: g.uuid,
    name: g.name,
    description: g.description,
    projectCount: countMap.get(g.uuid) ?? 0,
    createdAt: g.createdAt.toISOString(),
    updatedAt: g.updatedAt.toISOString(),
  }));

  // Count ungrouped projects
  const ungroupedCount = await prisma.project.count({
    where: { companyUuid, groupUuid: null },
  });

  return { groups: result, total: groups.length, ungroupedCount };
}

// ============================================================
// Project ↔ Group
// ============================================================

export async function moveProjectToGroup(
  companyUuid: string,
  projectUuid: string,
  targetGroupUuid: string | null
): Promise<{ uuid: string; name: string; groupUuid: string | null } | null> {
  // Verify project belongs to company
  const project = await prisma.project.findFirst({
    where: { uuid: projectUuid, companyUuid },
  });
  if (!project) return null;

  // Verify target group belongs to company (if not null)
  if (targetGroupUuid) {
    const group = await prisma.projectGroup.findFirst({
      where: { uuid: targetGroupUuid, companyUuid },
    });
    if (!group) return null;
  }

  const updated = await prisma.project.update({
    where: { uuid: projectUuid },
    data: { groupUuid: targetGroupUuid },
  });

  eventBus.emitChange({
    companyUuid,
    projectUuid,
    entityType: "project",
    entityUuid: projectUuid,
    action: "updated",
  });

  return {
    uuid: updated.uuid,
    name: updated.name,
    groupUuid: updated.groupUuid,
  };
}

// ============================================================
// Dashboard (aggregated stats)
// ============================================================

export async function getGroupDashboard(
  companyUuid: string,
  groupUuid: string
): Promise<GroupDashboardResponse | null> {
  const group = await prisma.projectGroup.findFirst({
    where: { uuid: groupUuid, companyUuid },
  });
  if (!group) return null;

  // Get all projects in this group
  const projects = await prisma.project.findMany({
    where: { groupUuid, companyUuid },
    select: { uuid: true, name: true },
  });

  const projectUuids = projects.map((p) => p.uuid);

  if (projectUuids.length === 0) {
    return {
      group: { uuid: group.uuid, name: group.name, description: group.description },
      stats: {
        projectCount: 0,
        totalTasks: 0,
        completedTasks: 0,
        completionRate: 0,
        openIdeas: 0,
        activeProposals: 0,
      },
      projects: [],
      recentActivity: [],
    };
  }

  // Aggregate stats across all projects
  const [totalTasks, completedTasks, openIdeas, activeProposals] =
    await Promise.all([
      prisma.task.count({
        where: { projectUuid: { in: projectUuids }, companyUuid },
      }),
      prisma.task.count({
        where: {
          projectUuid: { in: projectUuids },
          companyUuid,
          status: { in: ["done", "closed"] },
        },
      }),
      prisma.idea.count({
        where: {
          projectUuid: { in: projectUuids },
          companyUuid,
          status: { in: ["open", "elaborating"] },
        },
      }),
      prisma.proposal.count({
        where: {
          projectUuid: { in: projectUuids },
          companyUuid,
          status: { in: ["draft", "pending"] },
        },
      }),
    ]);

  // Per-project stats
  const taskCountsByProject = await prisma.task.groupBy({
    by: ["projectUuid"],
    where: { projectUuid: { in: projectUuids }, companyUuid },
    _count: { _all: true },
  });
  const doneCountsByProject = await prisma.task.groupBy({
    by: ["projectUuid"],
    where: {
      projectUuid: { in: projectUuids },
      companyUuid,
      status: { in: ["done", "closed"] },
    },
    _count: { _all: true },
  });

  const taskCountMap = new Map(
    taskCountsByProject.map((tc) => [tc.projectUuid, tc._count._all])
  );
  const doneCountMap = new Map(
    doneCountsByProject.map((dc) => [dc.projectUuid, dc._count._all])
  );

  const projectStats = projects.map((p) => {
    const tc = taskCountMap.get(p.uuid) ?? 0;
    const dc = doneCountMap.get(p.uuid) ?? 0;
    return {
      uuid: p.uuid,
      name: p.name,
      taskCount: tc,
      completionRate: tc > 0 ? Math.round((dc / tc) * 100) : 0,
    };
  });

  // Recent activity across all projects in the group
  const recentActivity = await prisma.activity.findMany({
    where: { projectUuid: { in: projectUuids }, companyUuid },
    orderBy: { createdAt: "desc" },
    take: 20,
  });

  // Resolve project names for activity
  const projectNameMap = new Map(projects.map((p) => [p.uuid, p.name]));

  return {
    group: { uuid: group.uuid, name: group.name, description: group.description },
    stats: {
      projectCount: projects.length,
      totalTasks,
      completedTasks,
      completionRate:
        totalTasks > 0 ? Math.round((completedTasks / totalTasks) * 100) : 0,
      openIdeas,
      activeProposals,
    },
    projects: projectStats,
    recentActivity: recentActivity.map((a) => ({
      uuid: a.uuid,
      projectUuid: a.projectUuid,
      projectName: projectNameMap.get(a.projectUuid) ?? "Unknown",
      targetType: a.targetType,
      targetUuid: a.targetUuid,
      action: a.action,
      value: a.value,
      actorType: a.actorType,
      actorUuid: a.actorUuid,
      createdAt: a.createdAt.toISOString(),
    })),
  };
}
