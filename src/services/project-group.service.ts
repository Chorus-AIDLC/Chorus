import { prisma } from "@/lib/prisma";
import { eventBus } from "@/lib/event-bus";
import { getActorName } from "@/lib/uuid-resolver";
import {
  type AnyAuth,
  getAccessibleProjectUuids,
  getAccessibleGroupUuids,
  canAccessGroup,
  canManageGroup,
  applyProjectFilter,
  ALL_PROJECTS,
} from "@/lib/authz/project-access";

// ============================================================
// Interfaces
// ============================================================

export interface ProjectGroupCreateParams {
  companyUuid: string;
  name: string;
  description?: string | null;
  /** Visibility for the new group (default "private"). */
  visibility?: "shared" | "private";
  /** Owner of the group (the acting human or agent). */
  ownerType?: "user" | "agent" | null;
  ownerUuid?: string | null;
  /** Initial members (besides the owner, who is always added). */
  memberUuids?: { memberType: "user" | "agent"; memberUuid: string }[];
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
  visibility: "shared" | "private";
  ownerType: "user" | "agent" | null;
  ownerUuid: string | null;
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
    visibility: "shared" | "private";
    ownerType: "user" | "agent" | null;
    ownerUuid: string | null;
    /** Whether the requesting actor owns (can manage) this group. */
    isOwner: boolean;
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
  const {
    companyUuid,
    name,
    description,
    visibility = "private",
    ownerType = null,
    ownerUuid = null,
    memberUuids = [],
  } = params;

  const group = await prisma.projectGroup.create({
    data: {
      companyUuid,
      name,
      description: description ?? "",
      visibility,
      ownerType,
      ownerUuid,
    },
  });

  // Seed members: the owner (if any) plus any explicitly provided members,
  // de-duplicated on (memberType, memberUuid). Mirrors createProject.
  const seed = new Map<string, { memberType: "user" | "agent"; memberUuid: string }>();
  if (ownerType && ownerUuid) {
    seed.set(`${ownerType}:${ownerUuid}`, { memberType: ownerType, memberUuid: ownerUuid });
  }
  for (const m of memberUuids) {
    seed.set(`${m.memberType}:${m.memberUuid}`, m);
  }
  if (seed.size > 0) {
    await prisma.projectGroupMember.createMany({
      data: [...seed.values()].map((m) => ({
        companyUuid,
        projectGroupUuid: group.uuid,
        memberType: m.memberType,
        memberUuid: m.memberUuid,
      })),
    });
  }

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
    visibility: group.visibility as "shared" | "private",
    ownerType: (group.ownerType as "user" | "agent" | null) ?? null,
    ownerUuid: group.ownerUuid ?? null,
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
    visibility: updated.visibility as "shared" | "private",
    ownerType: (updated.ownerType as "user" | "agent" | null) ?? null,
    ownerUuid: updated.ownerUuid ?? null,
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
  groupUuid: string,
  auth: AnyAuth
): Promise<ProjectGroupDetailResponse | null> {
  // Inaccessible group => looks like it does not exist.
  if (!(await canAccessGroup(auth, groupUuid))) return null;

  const group = await prisma.projectGroup.findFirst({
    where: { uuid: groupUuid, companyUuid },
  });
  if (!group) return null;

  const accessible = await getAccessibleProjectUuids(auth);
  const projects = await prisma.project.findMany({
    where: applyProjectFilter({ groupUuid, companyUuid }, accessible, "uuid"),
    select: { uuid: true, name: true, description: true },
    orderBy: { updatedAt: "desc" },
  });

  return {
    uuid: group.uuid,
    name: group.name,
    description: group.description,
    projectCount: projects.length,
    visibility: group.visibility as "shared" | "private",
    ownerType: (group.ownerType as "user" | "agent" | null) ?? null,
    ownerUuid: group.ownerUuid ?? null,
    projects,
    createdAt: group.createdAt.toISOString(),
    updatedAt: group.updatedAt.toISOString(),
  };
}

export async function listProjectGroups(
  companyUuid: string,
  auth: AnyAuth
): Promise<{ groups: ProjectGroupResponse[]; total: number; ungroupedCount: number }> {
  const allGroups = await prisma.projectGroup.findMany({
    where: { companyUuid },
    orderBy: { createdAt: "asc" },
  });

  // Visibility gate: keep only groups the actor may see — shared groups, groups
  // they OWN, or groups they are a member of (super_admin => ALL). A freshly
  // created empty group is still returned to its creator because they are its
  // owner; another user's PRIVATE group is filtered out. The accessible-GROUP
  // set (not the accessible-project set) is authoritative here.
  const accessibleGroups = await getAccessibleGroupUuids(auth);
  const groups =
    accessibleGroups === ALL_PROJECTS
      ? allGroups
      : allGroups.filter((g) => accessibleGroups.includes(g.uuid));

  const accessible = await getAccessibleProjectUuids(auth);

  // Batch count ACCESSIBLE projects per group.
  const groupUuids = groups.map((g) => g.uuid);
  const projectCounts =
    groupUuids.length > 0
      ? await prisma.project.groupBy({
          by: ["groupUuid"],
          where: applyProjectFilter(
            { companyUuid, groupUuid: { in: groupUuids } },
            accessible,
            "uuid"
          ),
          _count: { _all: true },
        })
      : [];

  const countMap = new Map(
    projectCounts.map((pc) => [pc.groupUuid, pc._count._all])
  );

  // The list is already visibility-filtered above (accessibleGroups). The
  // per-group projectCount still reflects only the projects the actor can
  // access within each visible group.
  const result: ProjectGroupResponse[] = groups.map((g) => ({
    uuid: g.uuid,
    name: g.name,
    description: g.description,
    projectCount: countMap.get(g.uuid) ?? 0,
    visibility: g.visibility as "shared" | "private",
    ownerType: (g.ownerType as "user" | "agent" | null) ?? null,
    ownerUuid: g.ownerUuid ?? null,
    createdAt: g.createdAt.toISOString(),
    updatedAt: g.updatedAt.toISOString(),
  }));

  // Count ungrouped projects the actor can access.
  const ungroupedCount = await prisma.project.count({
    where: applyProjectFilter({ companyUuid, groupUuid: null }, accessible, "uuid"),
  });

  return { groups: result, total: result.length, ungroupedCount };
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
  groupUuid: string,
  auth: AnyAuth
): Promise<GroupDashboardResponse | null> {
  // Inaccessible group => looks like it does not exist.
  if (!(await canAccessGroup(auth, groupUuid))) return null;

  const group = await prisma.projectGroup.findFirst({
    where: { uuid: groupUuid, companyUuid },
  });
  if (!group) return null;

  // The actor owns the group iff they can manage it (owner or super_admin).
  const isOwner = await canManageGroup(auth, groupUuid);
  const groupInfo = {
    uuid: group.uuid,
    name: group.name,
    description: group.description,
    visibility: group.visibility as "shared" | "private",
    ownerType: (group.ownerType as "user" | "agent" | null) ?? null,
    ownerUuid: group.ownerUuid ?? null,
    isOwner,
  };

  // Get all ACCESSIBLE projects in this group. All downstream stats derive from
  // this list, so filtering here cascades the visibility boundary through the
  // entire dashboard.
  const accessible = await getAccessibleProjectUuids(auth);
  const projects = await prisma.project.findMany({
    where: applyProjectFilter({ groupUuid, companyUuid }, accessible, "uuid"),
    select: { uuid: true, name: true },
  });

  const projectUuids = projects.map((p) => p.uuid);

  if (projectUuids.length === 0) {
    return {
      group: groupInfo,
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
    group: groupInfo,
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

// ============================================================
// Visibility & Membership (mirrors project.service)
// ============================================================

export interface ProjectGroupMemberResponse {
  uuid: string;
  memberType: "user" | "agent";
  memberUuid: string;
  /** Resolved display name for the member (null if unresolvable). */
  name: string | null;
  role: string;
  createdAt: string;
}

// Set a group's visibility ("shared" | "private"). Scoped by companyUuid.
// Returns null if the group does not exist within the company.
export async function setGroupVisibility(
  companyUuid: string,
  groupUuid: string,
  visibility: "shared" | "private",
) {
  const group = await prisma.projectGroup.findFirst({
    where: { uuid: groupUuid, companyUuid },
    select: { uuid: true },
  });
  if (!group) return null;

  const updated = await prisma.projectGroup.update({
    where: { uuid: group.uuid },
    data: { visibility },
    select: { uuid: true, visibility: true },
  });

  eventBus.emitChange({
    companyUuid,
    projectUuid: "",
    entityType: "project_group",
    entityUuid: groupUuid,
    action: "updated",
  });

  return updated;
}

// List members of a group. Scoped by companyUuid.
export async function listGroupMembers(
  companyUuid: string,
  groupUuid: string,
): Promise<ProjectGroupMemberResponse[]> {
  const members = await prisma.projectGroupMember.findMany({
    where: { companyUuid, projectGroupUuid: groupUuid },
    orderBy: { createdAt: "asc" },
    select: {
      uuid: true,
      memberType: true,
      memberUuid: true,
      role: true,
      createdAt: true,
    },
  });
  return Promise.all(
    members.map(async (m) => ({
      uuid: m.uuid,
      memberType: m.memberType as "user" | "agent",
      memberUuid: m.memberUuid,
      name: await getActorName(m.memberType, m.memberUuid),
      role: m.role,
      createdAt: m.createdAt.toISOString(),
    })),
  );
}

// Add a member (user or agent) to a group. Idempotent on the unique key.
export async function addGroupMember(
  companyUuid: string,
  groupUuid: string,
  memberType: "user" | "agent",
  memberUuid: string,
): Promise<ProjectGroupMemberResponse | null> {
  const group = await prisma.projectGroup.findFirst({
    where: { uuid: groupUuid, companyUuid },
    select: { uuid: true },
  });
  if (!group) return null;

  const existing = await prisma.projectGroupMember.findUnique({
    where: {
      projectGroupUuid_memberType_memberUuid: {
        projectGroupUuid: groupUuid,
        memberType,
        memberUuid,
      },
    },
    select: { uuid: true, memberType: true, memberUuid: true, role: true, createdAt: true },
  });

  const member =
    existing ??
    (await prisma.projectGroupMember.create({
      data: { companyUuid, projectGroupUuid: groupUuid, memberType, memberUuid },
      select: { uuid: true, memberType: true, memberUuid: true, role: true, createdAt: true },
    }));

  eventBus.emitChange({
    companyUuid,
    projectUuid: "",
    entityType: "project_group",
    entityUuid: groupUuid,
    action: "updated",
  });

  return {
    uuid: member.uuid,
    memberType: member.memberType as "user" | "agent",
    memberUuid: member.memberUuid,
    name: await getActorName(member.memberType, member.memberUuid),
    role: member.role,
    createdAt: member.createdAt.toISOString(),
  };
}

// Remove a member from a group. Returns false if the group or member is not
// found. The owner cannot be removed (they retain access via ownership).
export async function removeGroupMember(
  companyUuid: string,
  groupUuid: string,
  memberType: "user" | "agent",
  memberUuid: string,
): Promise<boolean> {
  const group = await prisma.projectGroup.findFirst({
    where: { uuid: groupUuid, companyUuid },
    select: { uuid: true, ownerType: true, ownerUuid: true },
  });
  if (!group) return false;

  // Do not remove the owner's membership row.
  if (group.ownerType === memberType && group.ownerUuid === memberUuid) {
    return false;
  }

  const existing = await prisma.projectGroupMember.findUnique({
    where: {
      projectGroupUuid_memberType_memberUuid: {
        projectGroupUuid: groupUuid,
        memberType,
        memberUuid,
      },
    },
    select: { id: true },
  });
  if (!existing) return false;

  await prisma.projectGroupMember.delete({
    where: {
      projectGroupUuid_memberType_memberUuid: {
        projectGroupUuid: groupUuid,
        memberType,
        memberUuid,
      },
    },
  });

  eventBus.emitChange({
    companyUuid,
    projectUuid: "",
    entityType: "project_group",
    entityUuid: groupUuid,
    action: "updated",
  });

  return true;
}
