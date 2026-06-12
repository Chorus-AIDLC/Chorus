// src/services/project.service.ts
// Project Service Layer (ARCHITECTURE.md §3.1 Service Layer)
// UUID-Based Architecture: All operations use UUIDs

import { prisma } from "@/lib/prisma";
import { eventBus } from "@/lib/event-bus";
import {
  type AnyAuth,
  getAccessibleProjectUuids,
  canAccessProject,
  applyProjectFilter,
} from "@/lib/authz/project-access";

export interface ProjectListParams {
  companyUuid: string;
  skip: number;
  take: number;
  /** Auth context used to restrict results to projects the actor can access. */
  auth: AnyAuth;
}

export interface ProjectCreateParams {
  companyUuid: string;
  name: string;
  description?: string | null;
  groupUuid?: string | null;
  /** Visibility for the new project (default "private"). */
  visibility?: "shared" | "private";
  /** Owner of the project (the acting human or agent). */
  ownerType?: "user" | "agent" | null;
  ownerUuid?: string | null;
  /** Initial members (besides the owner, who is always added). */
  memberUuids?: { memberType: "user" | "agent"; memberUuid: string }[];
}

export interface ProjectUpdateParams {
  name?: string;
  description?: string | null;
}

// List projects query — restricted to the projects the actor can access.
export async function listProjects({ companyUuid, skip, take, auth }: ProjectListParams) {
  const accessible = await getAccessibleProjectUuids(auth);
  // Filter the Project table by its own `uuid` column against the accessible set.
  const where = applyProjectFilter({ companyUuid }, accessible, "uuid");

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
        visibility: true,
        ownerType: true,
        ownerUuid: true,
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

// Get project details — null if the actor cannot access it.
export async function getProject(companyUuid: string, uuid: string, auth: AnyAuth) {
  if (!(await canAccessProject(auth, uuid))) return null;
  return prisma.project.findFirst({
    where: { uuid, companyUuid },
    select: {
      uuid: true,
      name: true,
      description: true,
      groupUuid: true,
      visibility: true,
      ownerType: true,
      ownerUuid: true,
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

// Verify if project exists AND is accessible to the actor.
export async function projectExists(companyUuid: string, projectUuid: string, auth: AnyAuth): Promise<boolean> {
  if (!(await canAccessProject(auth, projectUuid))) return false;
  const project = await prisma.project.findFirst({
    where: { uuid: projectUuid, companyUuid },
    select: { uuid: true },
  });
  return !!project;
}

// Get basic project info by UUID — null if inaccessible.
export async function getProjectByUuid(companyUuid: string, uuid: string, auth: AnyAuth) {
  if (!(await canAccessProject(auth, uuid))) return null;
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

// Create project. Records owner + visibility (default private) and seeds a
// ProjectMember row for the owner so the owner is always a member.
export async function createProject({
  companyUuid,
  name,
  description,
  groupUuid,
  visibility,
  ownerType = null,
  ownerUuid = null,
  memberUuids = [],
}: ProjectCreateParams) {
  // Resolve the default visibility. When the caller does NOT pass visibility
  // explicitly and the project is being created inside a group, inherit the
  // group's visibility (so a project added to a shared group is shared by
  // default). Otherwise default to "private". An explicit visibility always wins.
  let effectiveVisibility: "shared" | "private" = visibility ?? "private";
  if (visibility === undefined && groupUuid) {
    const group = await prisma.projectGroup.findFirst({
      where: { uuid: groupUuid, companyUuid },
      select: { visibility: true },
    });
    if (group?.visibility === "shared" || group?.visibility === "private") {
      effectiveVisibility = group.visibility;
    }
  }

  const project = await prisma.project.create({
    data: {
      companyUuid,
      name,
      description,
      groupUuid: groupUuid ?? null,
      visibility: effectiveVisibility,
      ownerType,
      ownerUuid,
    },
    select: {
      uuid: true,
      name: true,
      description: true,
      groupUuid: true,
      visibility: true,
      ownerType: true,
      ownerUuid: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  // Seed members: the owner (if any) plus any explicitly provided members,
  // de-duplicated on (memberType, memberUuid).
  const seed = new Map<string, { memberType: "user" | "agent"; memberUuid: string }>();
  if (ownerType && ownerUuid) {
    seed.set(`${ownerType}:${ownerUuid}`, { memberType: ownerType, memberUuid: ownerUuid });
  }
  for (const m of memberUuids) {
    seed.set(`${m.memberType}:${m.memberUuid}`, m);
  }
  if (seed.size > 0) {
    await prisma.projectMember.createMany({
      data: [...seed.values()].map((m) => ({
        companyUuid,
        projectUuid: project.uuid,
        memberType: m.memberType,
        memberUuid: m.memberUuid,
      })),
    });
  }

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

// Get company-level overview stats (for Projects list page) — counts restricted
// to projects the actor can access.
export async function getCompanyOverviewStats(companyUuid: string, auth: AnyAuth) {
  const accessible = await getAccessibleProjectUuids(auth);
  const projectWhere = applyProjectFilter({ companyUuid }, accessible, "uuid");
  // Child-entity counts filter by the accessible projectUuid set.
  const childWhere = applyProjectFilter({ companyUuid }, accessible);
  const proposalWhere = applyProjectFilter({ companyUuid, status: "pending" }, accessible);

  const [projectCount, taskCount, openProposalCount, ideaCount] = await Promise.all([
    prisma.project.count({ where: projectWhere }),
    prisma.task.count({ where: childWhere }),
    prisma.proposal.count({ where: proposalWhere }),
    prisma.idea.count({ where: childWhere }),
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

// Get project statistics (for Dashboard) — null if the actor cannot access it.
export async function getProjectStats(companyUuid: string, projectUuid: string, auth: AnyAuth) {
  if (!(await canAccessProject(auth, projectUuid))) return null;
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

// ============================================================
// Visibility & Membership
// ============================================================

export interface ProjectMemberResponse {
  uuid: string;
  memberType: "user" | "agent";
  memberUuid: string;
  role: string;
  createdAt: string;
}

// Set a project's visibility ("shared" | "private"). Scoped by companyUuid.
// Returns null if the project does not exist within the company.
export async function setProjectVisibility(
  companyUuid: string,
  projectUuid: string,
  visibility: "shared" | "private",
) {
  const project = await prisma.project.findFirst({
    where: { uuid: projectUuid, companyUuid },
    select: { uuid: true },
  });
  if (!project) return null;

  const updated = await prisma.project.update({
    where: { uuid: project.uuid },
    data: { visibility },
    select: { uuid: true, visibility: true },
  });

  eventBus.emitChange({
    companyUuid,
    projectUuid,
    entityType: "project",
    entityUuid: projectUuid,
    action: "updated",
  });

  return updated;
}

// List members of a project. Scoped by companyUuid.
export async function listProjectMembers(
  companyUuid: string,
  projectUuid: string,
): Promise<ProjectMemberResponse[]> {
  const members = await prisma.projectMember.findMany({
    where: { companyUuid, projectUuid },
    orderBy: { createdAt: "asc" },
    select: {
      uuid: true,
      memberType: true,
      memberUuid: true,
      role: true,
      createdAt: true,
    },
  });
  return members.map((m) => ({
    uuid: m.uuid,
    memberType: m.memberType as "user" | "agent",
    memberUuid: m.memberUuid,
    role: m.role,
    createdAt: m.createdAt.toISOString(),
  }));
}

// Add a member (user or agent) to a project. Idempotent on the unique key.
export async function addProjectMember(
  companyUuid: string,
  projectUuid: string,
  memberType: "user" | "agent",
  memberUuid: string,
): Promise<ProjectMemberResponse | null> {
  const project = await prisma.project.findFirst({
    where: { uuid: projectUuid, companyUuid },
    select: { uuid: true },
  });
  if (!project) return null;

  const existing = await prisma.projectMember.findUnique({
    where: {
      projectUuid_memberType_memberUuid: { projectUuid, memberType, memberUuid },
    },
    select: { uuid: true, memberType: true, memberUuid: true, role: true, createdAt: true },
  });

  const member =
    existing ??
    (await prisma.projectMember.create({
      data: { companyUuid, projectUuid, memberType, memberUuid },
      select: { uuid: true, memberType: true, memberUuid: true, role: true, createdAt: true },
    }));

  eventBus.emitChange({
    companyUuid,
    projectUuid,
    entityType: "project",
    entityUuid: projectUuid,
    action: "updated",
  });

  return {
    uuid: member.uuid,
    memberType: member.memberType as "user" | "agent",
    memberUuid: member.memberUuid,
    role: member.role,
    createdAt: member.createdAt.toISOString(),
  };
}

// Remove a member from a project. Returns false if the project or member is
// not found. The owner cannot be removed (they retain access via ownership).
export async function removeProjectMember(
  companyUuid: string,
  projectUuid: string,
  memberType: "user" | "agent",
  memberUuid: string,
): Promise<boolean> {
  const project = await prisma.project.findFirst({
    where: { uuid: projectUuid, companyUuid },
    select: { uuid: true, ownerType: true, ownerUuid: true },
  });
  if (!project) return false;

  // Do not remove the owner's membership row.
  if (project.ownerType === memberType && project.ownerUuid === memberUuid) {
    return false;
  }

  const existing = await prisma.projectMember.findUnique({
    where: {
      projectUuid_memberType_memberUuid: { projectUuid, memberType, memberUuid },
    },
    select: { id: true },
  });
  if (!existing) return false;

  await prisma.projectMember.delete({
    where: {
      projectUuid_memberType_memberUuid: { projectUuid, memberType, memberUuid },
    },
  });

  eventBus.emitChange({
    companyUuid,
    projectUuid,
    entityType: "project",
    entityUuid: projectUuid,
    action: "updated",
  });

  return true;
}
