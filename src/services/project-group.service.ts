import { prisma } from "@/lib/prisma";
import { eventBus } from "@/lib/event-bus";
import type { AuthContext } from "@/types/auth";
import { accessibleProjectWhere, computeProjectAccess, isProjectMemberRole, isProjectVisibility, levelAtLeast, membershipPrincipal, ProjectAccessDeniedError, ProjectNotFoundError, type ProjectVisibility, type ProjectMemberRole } from "@/services/project-access.service";
import { ApiError } from "@/lib/api-handler";
import { accessibleGroupWhere, getGroupAccess, groupAccessPresentation, requireGroupOperation, GroupNotFoundError, type GroupAccessResult } from "@/services/project-group-access.service";
import { assertAccessConfirmation } from "@/services/project-access-preview.service";
import { getGroupVisibilityPreview, getProjectGroupMovePreview } from "@/services/project-group-preview.service";
import { auditGroup, groupAuth, lockGroups, lockProjects, materializeGroupGrants, publishGroupAccess } from "@/services/project-group-mutation.service";
export { getGroupVisibilityPreview, getProjectGroupMovePreview } from "@/services/project-group-preview.service";

async function groupProjectWhere(companyUuid: string, auth?: AuthContext) {
  if (auth && auth.companyUuid !== companyUuid) throw new ProjectNotFoundError();
  return accessibleProjectWhere(auth ?? { type: "agent", actorUuid: "", companyUuid });
}

// ============================================================
// Interfaces
// ============================================================

export interface ProjectGroupCreateParams {
  companyUuid: string;
  name: string;
  description?: string | null;
  visibility?: ProjectVisibility;
  auth?: AuthContext;
}

export interface ProjectGroupUpdateParams {
  companyUuid: string;
  groupUuid: string;
  name?: string;
  description?: string | null;
  visibility?: ProjectVisibility;
  initializeAccess?: boolean;
  confirmationToken?: string;
  auth?: AuthContext;
}

export interface ProjectGroupResponse {
  uuid: string;
  name: string;
  description: string | null;
  projectCount: number;
  visibility: string;
  accessLevel: string;
  explicitRole: ProjectMemberRole | null;
  canManage: boolean;
  canCreateProject: boolean;
  accessInitialized: boolean;
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
    visibility: string;
    accessLevel: string;
    explicitRole: ProjectMemberRole | null;
    canManage: boolean;
    canCreateProject: boolean;
    accessInitialized: boolean;
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
    visibility: string;
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

function accessFields(access: GroupAccessResult) {
  return {
    visibility: access.group!.visibility, accessLevel: access.level, explicitRole: access.explicitRole,
    canManage: access.canManage, canCreateProject: access.canCreateProject,
    accessInitialized: access.accessInitialized,
  };
}

export async function createProjectGroup(params: ProjectGroupCreateParams, auth?: AuthContext): Promise<ProjectGroupResponse> {
  const actor = groupAuth(params.companyUuid, auth ?? params.auth);
  const principal = membershipPrincipal(actor);
  const visibility = params.visibility ?? "public";
  if (!isProjectVisibility(visibility)) throw new ApiError("BAD_REQUEST", "Invalid visibility", 400);
  if (visibility === "private" && !principal) throw new ApiError("BAD_REQUEST", "A private group requires an owner", 400);
  const group = await prisma.$transaction(async (tx) => {
    if (principal && !await tx.user.findFirst({ where: { companyUuid: params.companyUuid, uuid: principal }, select: { uuid: true } })) {
      throw new ApiError("NOT_FOUND", "Creator not found in this company", 404);
    }
    const created = await tx.projectGroup.create({ data: {
      companyUuid: params.companyUuid, name: params.name, description: params.description ?? "",
      visibility, createdByUuid: principal, accessVersion: principal ? 1 : 0,
    } });
    if (principal) await tx.projectGroupMember.create({ data: {
      companyUuid: params.companyUuid, groupUuid: created.uuid, userUuid: principal,
      role: "admin", addedByUuid: principal,
    } });
    await auditGroup(tx, actor, created.uuid, [], "group_created", { visibility });
    return created;
  });
  eventBus.emitChange({ companyUuid: params.companyUuid, projectUuid: "", entityType: "project_group", entityUuid: group.uuid, action: "created", actorUuid: actor.actorUuid });
  return {
    uuid: group.uuid, name: group.name, description: group.description, projectCount: 0,
    visibility, accessLevel: principal ? "admin" : "editor", explicitRole: principal ? "admin" : null, canManage: true, canCreateProject: true,
    accessInitialized: !!principal, createdAt: group.createdAt.toISOString(), updatedAt: group.updatedAt.toISOString(),
  };
}

export async function updateProjectGroup(params: ProjectGroupUpdateParams, auth?: AuthContext): Promise<ProjectGroupResponse | null> {
  const actor = groupAuth(params.companyUuid, auth ?? params.auth);
  if (params.visibility !== undefined && !isProjectVisibility(params.visibility)) throw new ApiError("BAD_REQUEST", "Invalid visibility", 400);
  const access = await getGroupAccess(actor, params.groupUuid);
  if (!access.group) return null;
  const changed = await prisma.$transaction(async (tx) => {
    await lockGroups(tx, params.companyUuid, [params.groupUuid]);
    const current = await requireGroupOperation(actor, params.groupUuid, "manage_group", tx);
    const projects = await tx.project.findMany({ where: { companyUuid: params.companyUuid, groupUuid: params.groupUuid }, select: { uuid: true }, orderBy: { uuid: "asc" } });
    const projectUuids = projects.map((p) => p.uuid);
    await lockProjects(tx, params.companyUuid, projectUuids);
    if (params.initializeAccess) {
      if (current.accessInitialized) throw new ApiError("CONFLICT", "Group access is already initialized", 409);
      const principal = membershipPrincipal(actor);
      if (!principal) throw new ApiError("BAD_REQUEST", "Access initialization requires an owner", 400);
      if (!await tx.user.findFirst({ where: { companyUuid: params.companyUuid, uuid: principal }, select: { uuid: true } })) throw new ApiError("NOT_FOUND", "User not found", 404);
      // Becoming group Admin grants Admin to every child, including public ones.
      // Require an explicit common child Admin rather than public editor access.
      for (const project of projects) {
        const child = await computeProjectAccess(actor, project.uuid, tx);
        if (!child.project) throw new ProjectNotFoundError();
        if (!levelAtLeast(child.level, "admin")) throw new ProjectAccessDeniedError("Initialization requires Admin on every child project");
      }
      await tx.projectGroupMember.create({ data: { companyUuid: params.companyUuid, groupUuid: params.groupUuid, userUuid: principal, role: "admin", addedByUuid: principal } });
    }
    let accessChanged = !!params.initializeAccess;
    if (params.visibility !== undefined) {
      // Validate supplied tokens even when another conversion already committed.
      const preview = await getGroupVisibilityPreview(actor, params.groupUuid, params.visibility, tx);
      assertAccessConfirmation(preview.confirmationToken, params.confirmationToken);
      accessChanged ||= params.visibility !== current.visibility;
      if (params.visibility === "private" && params.visibility !== current.visibility) {
        await tx.project.updateMany({ where: { companyUuid: params.companyUuid, groupUuid: params.groupUuid, visibility: "public" }, data: { visibility: "private" } });
      }
    }
    await tx.projectGroup.update({ where: { uuid: params.groupUuid }, data: {
      ...(params.name !== undefined ? { name: params.name } : {}),
      ...(params.description !== undefined ? { description: params.description } : {}),
      ...(params.visibility !== undefined ? { visibility: params.visibility } : {}),
      ...(accessChanged ? { accessVersion: { increment: 1 } } : {}),
    } });
    await auditGroup(tx, actor, params.groupUuid, projectUuids, params.initializeAccess ? "group_access_initialized" : "group_updated", {
      ...(params.visibility !== undefined ? { beforeVisibility: current.visibility, visibility: params.visibility } : {}),
      ...(params.name !== undefined ? { name: params.name } : {}),
      ...(params.description !== undefined ? { description: params.description } : {}),
    });
    return { accessChanged, projectUuids };
  });
  if (changed.accessChanged) publishGroupAccess(actor, params.groupUuid, changed.projectUuids);
  else eventBus.emitChange({ companyUuid: params.companyUuid, projectUuid: "", entityType: "project_group", entityUuid: params.groupUuid, action: "updated", actorUuid: actor.actorUuid });
  return getProjectGroup(params.companyUuid, params.groupUuid, actor);
}

export async function deleteProjectGroup(companyUuid: string, groupUuid: string, deleteProjects = false, auth?: AuthContext): Promise<boolean> {
  const actor = groupAuth(companyUuid, auth);
  if (!(await getGroupAccess(actor, groupUuid)).group) return false;
  const projectUuids = await prisma.$transaction(async (tx) => {
    await lockGroups(tx, companyUuid, [groupUuid]);
    await requireGroupOperation(actor, groupUuid, "delete_group", tx);
    const projects = await tx.project.findMany({ where: { companyUuid, groupUuid }, orderBy: { uuid: "asc" } });
    await lockProjects(tx, companyUuid, projects.map((p) => p.uuid));
    for (const project of projects) {
      const access = await computeProjectAccess(actor, project.uuid, tx);
      if (!access.project) throw new ProjectNotFoundError();
      if (!levelAtLeast(access.level, project.visibility === "private" ? "admin" : "editor")) throw new ProjectAccessDeniedError();
      if (!deleteProjects) await materializeGroupGrants(tx, actor, groupUuid, project.uuid);
    }
    await auditGroup(tx, actor, groupUuid, projects.map((p) => p.uuid), "group_deleted", { deleteProjects });
    if (deleteProjects) await tx.project.deleteMany({ where: { companyUuid, groupUuid } });
    else await tx.project.updateMany({ where: { companyUuid, groupUuid }, data: { groupUuid: null } });
    await tx.projectGroup.delete({ where: { uuid: groupUuid } });
    return projects.map((p) => p.uuid);
  });
  publishGroupAccess(actor, groupUuid, projectUuids);
  eventBus.emitChange({ companyUuid, projectUuid: "", entityType: "project_group", entityUuid: groupUuid, action: "deleted", actorUuid: actor.actorUuid });
  return true;
}

export async function getProjectGroup(
  companyUuid: string,
  groupUuid: string,
  auth?: AuthContext,
): Promise<ProjectGroupDetailResponse | null> {
  const projectWhere = await groupProjectWhere(companyUuid, auth);
  const actor = auth ?? { type: "agent" as const, actorUuid: "", companyUuid };
  const access = await getGroupAccess(actor, groupUuid);
  const group = access.group;
  if (!group) return null;

  const projects = await prisma.project.findMany({
    where: { ...projectWhere, groupUuid },
    select: { uuid: true, name: true, description: true },
    orderBy: { updatedAt: "desc" },
  });

  return {
    uuid: group.uuid,
    name: group.name,
    description: group.description,
    projectCount: projects.length,
    ...accessFields(access),
    projects,
    createdAt: group.createdAt.toISOString(),
    updatedAt: group.updatedAt.toISOString(),
  };
}

export async function listProjectGroups(
  companyUuid: string,
  auth?: AuthContext,
): Promise<{ groups: ProjectGroupResponse[]; total: number; ungroupedCount: number }> {
  const projectWhere = await groupProjectWhere(companyUuid, auth);
  const groups = await prisma.projectGroup.findMany({
    where: await accessibleGroupWhere(auth ?? { type: "agent", actorUuid: "", companyUuid }),
    orderBy: { createdAt: "asc" },
  });

  // Batch count projects per group
  const groupUuids = groups.map((g) => g.uuid);
  const projectCounts =
    groupUuids.length > 0
      ? await prisma.project.groupBy({
          by: ["groupUuid"],
          where: { ...projectWhere, groupUuid: { in: groupUuids } },
          _count: { _all: true },
        })
      : [];

  const countMap = new Map(
    projectCounts.map((pc) => [pc.groupUuid, pc._count._all])
  );

  const principal = auth ? membershipPrincipal(auth) : null;
  const members = groupUuids.length ? await prisma.projectGroupMember.findMany({
    where: { companyUuid, groupUuid: { in: groupUuids }, OR: [
      { role: "admin" }, ...(principal ? [{ userUuid: principal }] : []),
    ] }, select: { groupUuid: true, userUuid: true, role: true },
  }) : [];
  const result: ProjectGroupResponse[] = groups.flatMap((g) => {
    const role = members.find((m) => m.groupUuid === g.uuid && m.userUuid === principal)?.role;
    const explicitRole = isProjectMemberRole(role) ? role : null;
    if (g.visibility === "private" && !explicitRole && !countMap.get(g.uuid)) return [];
    const presentation = groupAccessPresentation(g, explicitRole, members.some((m) => m.groupUuid === g.uuid && m.role === "admin"));
    return [{
    uuid: g.uuid,
    name: g.name,
    description: g.description,
    projectCount: countMap.get(g.uuid) ?? 0,
    ...accessFields(presentation),
    createdAt: g.createdAt.toISOString(),
    updatedAt: g.updatedAt.toISOString(),
    }];
  });

  // Count ungrouped projects
  const ungroupedCount = await prisma.project.count({
    where: { ...projectWhere, groupUuid: null },
  });

  return { groups: result, total: result.length, ungroupedCount };
}

// ============================================================
// Project ↔ Group
// ============================================================

export async function moveProjectToGroup(
  companyUuid: string, projectUuid: string, targetGroupUuid: string | null,
  auth?: AuthContext, confirmationToken?: string,
): Promise<{ uuid: string; name: string; groupUuid: string | null; visibility: string } | null> {
  const actor = groupAuth(companyUuid, auth);
  // Authorization and preview are recomputed after acquiring the entire lock set.
  const initial = await computeProjectAccess(actor, projectUuid);
  if (!initial.project) throw new ProjectNotFoundError();
  const result = await prisma.$transaction(async (tx) => {
    await lockGroups(tx, companyUuid, [initial.project!.groupUuid, targetGroupUuid]);
    await lockProjects(tx, companyUuid, [projectUuid]);
    const locked = await tx.project.findFirst({ where: { companyUuid, uuid: projectUuid } });
    if (!locked) throw new ProjectNotFoundError();
    if (locked.groupUuid !== initial.project!.groupUuid) throw new ApiError("CONFLICT", "Project group changed; review a fresh access preview", 409);
    const preview = await getProjectGroupMovePreview(actor, projectUuid, targetGroupUuid, tx);
    if (preview.requiresConfirmation || confirmationToken !== undefined) assertAccessConfirmation(preview.confirmationToken, confirmationToken);
    if (locked.groupUuid === targetGroupUuid) return locked;
    if (!targetGroupUuid && locked.groupUuid) await materializeGroupGrants(tx, actor, locked.groupUuid, projectUuid);
    const updated = await tx.project.update({ where: { uuid: projectUuid }, data: { groupUuid: targetGroupUuid, visibility: preview.visibility } });
    for (const uuid of [...new Set([locked.groupUuid, targetGroupUuid].filter((u): u is string => !!u))]) {
      // Legacy assignments may reference a missing or another company's group.
      // The locked preview still validates the destination and project authority;
      // only actual groups in this company have versions and protected audits.
      const changed = await tx.projectGroup.updateMany({
        where: { companyUuid, uuid }, data: { accessVersion: { increment: 1 } },
      });
      if (changed.count === 0) {
        if (uuid === targetGroupUuid) throw new GroupNotFoundError();
        continue;
      }
      await auditGroup(tx, actor, uuid, [], "project_moved", {
        projectUuid, sourceGroupUuid: locked.groupUuid, groupUuid: targetGroupUuid, visibility: preview.visibility,
      });
    }
    await tx.activity.create({ data: {
      companyUuid, projectUuid, targetType: "project", targetUuid: projectUuid,
      actorType: actor.type === "agent" ? "agent" : "user", actorUuid: actor.actorUuid,
      action: "project_group_changed", value: { groupUuid: targetGroupUuid, visibility: preview.visibility },
    } });
    return updated;
  });
  const refreshGroupUuid = targetGroupUuid ?? initial.project.groupUuid ?? "";
  publishGroupAccess(actor, refreshGroupUuid, [projectUuid]);
  if (initial.project.groupUuid && initial.project.groupUuid !== refreshGroupUuid) {
    // The destination publication already refreshes child access. Refresh the
    // source sidebar too, without duplicating the child's access-change event.
    publishGroupAccess(actor, initial.project.groupUuid, []);
  }
  return { uuid: result.uuid, name: result.name, groupUuid: result.groupUuid, visibility: result.visibility };
}

// ============================================================
// Dashboard (aggregated stats)
// ============================================================

export async function getGroupDashboard(
  companyUuid: string,
  groupUuid: string,
  auth?: AuthContext,
): Promise<GroupDashboardResponse | null> {
  const projectWhere = await groupProjectWhere(companyUuid, auth);
  const actor = auth ?? { type: "agent" as const, actorUuid: "", companyUuid };
  const access = await getGroupAccess(actor, groupUuid);
  const group = access.group;
  if (!group) return null;

  // Get all projects in this group
  const projects = await prisma.project.findMany({
    where: { ...projectWhere, groupUuid },
    select: { uuid: true, name: true, visibility: true },
  });

  const projectUuids = projects.map((p) => p.uuid);

  if (projectUuids.length === 0) {
    return {
      group: { uuid: group.uuid, name: group.name, description: group.description, ...accessFields(access) },
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
      visibility: p.visibility ?? "public",
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
    group: { uuid: group.uuid, name: group.name, description: group.description, ...accessFields(access) },
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
