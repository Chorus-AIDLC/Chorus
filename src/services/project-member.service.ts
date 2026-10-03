// src/services/project-member.service.ts
// Project membership & visibility management (Tech Design D3).
// All mutations require a project admin (requireProjectOperation), on
// public and private projects alike, so nobody can promote themselves and then
// lock a public project down.
//
// Every mutation runs in ONE transaction that (1) locks the project row, (2)
// re-checks the actor's authority, the target membership and the admin count
// against committed state, and (3) writes the change together with its Activity
// row. Cache invalidation and realtime events are published only after commit,
// so a failed audit write can never leave an unannounced access change behind.

import { prisma } from "@/lib/prisma";
import { eventBus } from "@/lib/event-bus";
import { ApiError } from "@/lib/api-handler";
import * as activityService from "@/services/activity.service";
import {
  invalidateProjectAccessCache,
  isProjectMemberRole,
  isProjectVisibility,
  levelAtLeast,
  membershipPrincipal,
  requiredLevelForOperation,
  requireProjectAccess,
  requireProjectOperation,
  resolveInheritedAccessLevel,
  computeProjectAccess,
  ProjectAccessDeniedError,
  ProjectNotFoundError,
  type ProjectMemberRole,
  type ProjectOperation,
  type ProjectVisibility,
} from "@/services/project-access.service";
import type { AuthContext } from "@/types/auth";
import { lockProjectAccess, getProjectVisibilityPreview, assertAccessConfirmation } from "@/services/project-access-preview.service";
import { implicitGroupAdmin, implicitProjectAdmin } from "@/services/project-group-implicit-admin.service";

export class LastAdminError extends ApiError {
  constructor() {
    super("BAD_REQUEST", "A project must keep at least one admin", 400);
    this.name = "LastAdminError";
  }
}

export interface ProjectMemberResponse {
  uuid: string;
  userUuid: string;
  name: string | null;
  email: string | null;
  role: ProjectMemberRole;
  createdAt: string;
  source?: "project" | "group" | "both";
  directRole?: ProjectMemberRole | null;
  inheritedRole?: ProjectMemberRole | null;
  effectiveRole?: ProjectMemberRole;
  implicit?: boolean;
  automaticAdmin?: boolean;
}

type MemberDbClient = Omit<typeof prisma, "$connect" | "$disconnect" | "$on" | "$transaction" | "$extends">;

function badRequest(message: string): ApiError {
  return new ApiError("BAD_REQUEST", message, 400);
}

function memberNotFound(): ApiError {
  return new ApiError("NOT_FOUND", "Member not found", 404);
}

// Serialises membership writes per project (same row-lock pattern as
// lockResearchProject) so concurrent changes are applied one at a time.
// Re-check, under the project lock, that the actor may still perform `op`
// (a concurrent demotion of the actor must not be bypassed).
async function assertOperationUnderLock(
  tx: MemberDbClient,
  auth: AuthContext,
  projectUuid: string,
  op: ProjectOperation,
): Promise<{ visibility: string }> {
  const { project, level } = await computeProjectAccess(auth, projectUuid, tx);
  if (!project) throw new ProjectNotFoundError("project");
  if (level === "none") throw new ProjectNotFoundError("project");
  if (!levelAtLeast(level, requiredLevelForOperation(op, project.visibility))) {
    throw new ProjectAccessDeniedError("Only project admins can perform this action");
  }
  return project;
}

async function assertAdminRemains(tx: MemberDbClient, projectUuid: string): Promise<void> {
  const admins = await tx.projectMember.count({ where: { projectUuid, role: "admin" } });
  if (admins > 0) return;
  const project = await tx.project.findFirst({ where: { uuid: projectUuid }, select: { companyUuid: true, groupUuid: true } });
  const group = project?.groupUuid ? await tx.projectGroup.findFirst({
    where: { companyUuid: project.companyUuid, uuid: project.groupUuid }, select: { uuid: true },
  }) : null;
  const inheritedAdmins = group && project ? await tx.projectGroupMember.count({
    where: { companyUuid: project.companyUuid, groupUuid: group.uuid, role: "admin" },
  }) : 0;
  if (inheritedAdmins) return;
  if (group && project && await implicitGroupAdmin(project.companyUuid, group.uuid, tx)) return;
  // Do not count a project fallback that would appear only after this explicit
  // Admin was removed: the last explicit local Admin must remain protected.
  throw new LastAdminError();
}

interface LockedMutation<T> {
  result: T;
  activity?: { action: string; value: Record<string, unknown> };
  changedUserUuids?: string[];
}

// Fast-path check (404/403 without opening a transaction), then the locked,
// re-checked transaction. Events are published only after a successful commit.
async function mutateUnderLock<T>(
  auth: AuthContext,
  projectUuid: string,
  op: ProjectOperation,
  fn: (tx: MemberDbClient, project: { visibility: string }) => Promise<LockedMutation<T>>,
): Promise<T> {
  await requireProjectOperation(auth, projectUuid, op);

  const { result, publish, changedUserUuids } = await prisma.$transaction(async (tx) => {
    await lockProjectAccess(tx, auth.companyUuid, projectUuid);
    const project = await assertOperationUnderLock(tx, auth, projectUuid, op);
    const out = await fn(tx, project);
    let publish: (() => void) | undefined;
    if (out.activity) {
      ({ publish } = await activityService.createActivityInTx(tx, {
        companyUuid: auth.companyUuid,
        projectUuid,
        targetType: "project",
        targetUuid: projectUuid,
        actorType: auth.type === "agent" ? "agent" : "user",
        actorUuid: auth.actorUuid,
        action: out.activity.action,
        value: out.activity.value,
      }));
    }
    return { result: out.result, publish, changedUserUuids: out.changedUserUuids };
  });

  if (changedUserUuids) {
    invalidateProjectAccessCache(auth, projectUuid);
    eventBus.emitProjectAccessChanged({ companyUuid: auth.companyUuid, projectUuid, userUuids: changedUserUuids });
    eventBus.emitChange({
      companyUuid: auth.companyUuid,
      projectUuid,
      entityType: "project",
      entityUuid: projectUuid,
      action: "updated",
      actorUuid: auth.actorUuid,
    });
  }
  publish?.();
  return result;
}

// Any actor who can see the project can see its member list.
export async function listMembers(auth: AuthContext, projectUuid: string): Promise<ProjectMemberResponse[]> {
  const project = await requireProjectAccess(auth, projectUuid, "viewer");
  const [members, automaticProjectAdmin] = await Promise.all([
    prisma.projectMember.findMany({
      where: { projectUuid, companyUuid: auth.companyUuid },
      orderBy: { createdAt: "asc" },
      select: { uuid: true, userUuid: true, role: true, createdAt: true },
    }),
    implicitProjectAdmin(auth.companyUuid, projectUuid),
  ]);
  const users = await prisma.user.findMany({
    where: { companyUuid: auth.companyUuid, uuid: { in: [...new Set([
      ...members.map((m) => m.userUuid), ...(automaticProjectAdmin ? [automaticProjectAdmin] : []),
    ])] } },
    select: { uuid: true, name: true, email: true },
  });
  const byUuid = new Map(users.map((u) => [u.uuid, u]));
  const directRows: ProjectMemberResponse[] = members.map((m) => ({
    uuid: m.uuid,
    userUuid: m.userUuid,
    name: byUuid.get(m.userUuid)?.name ?? null,
    email: byUuid.get(m.userUuid)?.email ?? null,
    role: m.userUuid === automaticProjectAdmin ? "admin" : isProjectMemberRole(m.role) ? m.role : "viewer",
    createdAt: m.createdAt.toISOString(),
    ...(m.userUuid === automaticProjectAdmin ? {
      source: "project" as const, directRole: isProjectMemberRole(m.role) ? m.role : "viewer" as const,
      inheritedRole: null, effectiveRole: "admin" as const, implicit: true, automaticAdmin: true,
    } : {}),
  }));
  if (automaticProjectAdmin && !members.some((m) => m.userUuid === automaticProjectAdmin)) {
    directRows.unshift({
      uuid: `implicit:${projectUuid}:${automaticProjectAdmin}`, userUuid: automaticProjectAdmin,
      name: byUuid.get(automaticProjectAdmin)?.name ?? null, email: byUuid.get(automaticProjectAdmin)?.email ?? null,
      role: "admin", createdAt: project.createdAt.toISOString(), source: "project",
      directRole: null, inheritedRole: null, effectiveRole: "admin", implicit: true, automaticAdmin: true,
    });
  }
  if (!project.groupUuid) return directRows;
  const group = await prisma.projectGroup.findFirst({
    where: { companyUuid: auth.companyUuid, uuid: project.groupUuid }, select: { uuid: true },
  });
  if (!group) return directRows;
  const [inherited, automaticAdmin] = await Promise.all([
    prisma.projectGroupMember.findMany({
      where: { companyUuid: auth.companyUuid, groupUuid: project.groupUuid },
      select: { uuid: true, userUuid: true, role: true, createdAt: true },
    }),
    implicitGroupAdmin(auth.companyUuid, project.groupUuid),
  ]);
  if (automaticAdmin) {
    const existing = inherited.find((m) => m.userUuid === automaticAdmin);
    if (existing) existing.role = "admin";
    else inherited.unshift({
      uuid: `implicit:${project.groupUuid}:${automaticAdmin}`, userUuid: automaticAdmin,
      role: "admin", createdAt: project.createdAt,
    });
  }
  const extraUsers = await prisma.user.findMany({
    where: { companyUuid: auth.companyUuid, uuid: { in: inherited.map((m) => m.userUuid) } },
    select: { uuid: true, name: true, email: true },
  });
  for (const user of extraUsers) byUuid.set(user.uuid, user);
  const byMember = new Map(directRows.map((m) => [m.userUuid, m]));
  const inheritedByUser = new Map(inherited.map((m) => [m.userUuid, m]));
  for (const m of inherited) {
    if (!byMember.has(m.userUuid)) {
      byMember.set(m.userUuid, {
        uuid: `inherited:${m.uuid}`, userUuid: m.userUuid,
        name: byUuid.get(m.userUuid)?.name ?? null, email: byUuid.get(m.userUuid)?.email ?? null,
        role: isProjectMemberRole(m.role) ? m.role : "viewer", createdAt: m.createdAt.toISOString(),
      });
    }
  }
  return [...byMember.values()].map((row) => {
    const groupRow = inheritedByUser.get(row.userUuid);
    const directRow = directRows.find((r) => r.userUuid === row.userUuid);
    const direct = directRow?.directRole === undefined ? directRow?.role ?? null : directRow.directRole;
    const inheritedRole = isProjectMemberRole(groupRow?.role) ? groupRow.role : null;
    const effectiveRole = row.userUuid === automaticProjectAdmin
      ? "admin" : resolveInheritedAccessLevel(project.visibility, direct, inheritedRole) as ProjectMemberRole;
    return { ...row, role: effectiveRole, source: direct && inheritedRole ? "both" : inheritedRole ? "group" : "project",
      directRole: direct, inheritedRole, effectiveRole,
      ...(row.userUuid === automaticAdmin ? { implicit: true, automaticAdmin: true } : {}) };
  });
}

export async function addMember(
  auth: AuthContext,
  projectUuid: string,
  userUuid: string,
  role: ProjectMemberRole,
) {
  if (!isProjectMemberRole(role)) throw badRequest(`Invalid role: ${role}`);

  return mutateUnderLock(auth, projectUuid, "manage_members", async (tx) => {
    const automaticAdmin = await implicitProjectAdmin(auth.companyUuid, projectUuid, tx);
    if (automaticAdmin === userUuid && role !== "admin") {
      throw badRequest("Cannot remove or demote the automatic project Admin");
    }
    const user = await tx.user.findFirst({
      where: { uuid: userUuid, companyUuid: auth.companyUuid },
      select: { uuid: true },
    });
    if (!user) throw badRequest("User not found in this company");

    const existing = await tx.projectMember.findUnique({
      where: { projectUuid_userUuid: { projectUuid, userUuid } },
      select: { uuid: true },
    });
    if (existing) throw new ApiError("CONFLICT", "User is already a member of this project", 409);

    const member = await tx.projectMember.create({
      data: {
        companyUuid: auth.companyUuid,
        projectUuid,
        userUuid,
        role,
        addedByUuid: membershipPrincipal(auth),
      },
      select: { uuid: true, userUuid: true, role: true },
    });
    return {
      result: member,
      activity: { action: "project_member_added", value: { userUuid, role } },
      changedUserUuids: [...new Set([userUuid, ...(automaticAdmin && role === "admin" ? [automaticAdmin] : [])])],
    };
  });
}

export async function updateMemberRole(
  auth: AuthContext,
  projectUuid: string,
  userUuid: string,
  role: ProjectMemberRole,
) {
  if (!isProjectMemberRole(role)) throw badRequest(`Invalid role: ${role}`);

  return mutateUnderLock(auth, projectUuid, "manage_members", async (tx) => {
    const automaticAdmin = await implicitProjectAdmin(auth.companyUuid, projectUuid, tx);
    if (automaticAdmin === userUuid && role !== "admin") {
      throw badRequest("Cannot remove or demote the automatic project Admin");
    }
    const member = await tx.projectMember.findUnique({
      where: { projectUuid_userUuid: { projectUuid, userUuid } },
      select: { uuid: true, role: true },
    });
    if (!member) throw memberNotFound();
    if (member.role === role) return { result: { uuid: member.uuid, userUuid, role } };

    const updated = await tx.projectMember.update({
      where: { uuid: member.uuid },
      data: { role },
      select: { uuid: true, userUuid: true, role: true },
    });
    if (member.role === "admin") await assertAdminRemains(tx, projectUuid);
    return {
      result: updated,
      activity: {
        action: "project_member_role_changed",
        value: { userUuid, fromRole: member.role, toRole: role },
      },
      changedUserUuids: [...new Set([userUuid, ...(automaticAdmin && role === "admin" ? [automaticAdmin] : [])])],
    };
  });
}

export async function removeMember(auth: AuthContext, projectUuid: string, userUuid: string) {
  return mutateUnderLock(auth, projectUuid, "manage_members", async (tx) => {
    if (await implicitProjectAdmin(auth.companyUuid, projectUuid, tx) === userUuid) {
      throw badRequest("Cannot remove or demote the automatic project Admin");
    }
    const member = await tx.projectMember.findUnique({
      where: { projectUuid_userUuid: { projectUuid, userUuid } },
      select: { uuid: true, role: true },
    });
    if (!member) throw memberNotFound();

    await tx.projectMember.delete({ where: { uuid: member.uuid } });
    if (member.role === "admin") await assertAdminRemains(tx, projectUuid);
    return {
      result: { uuid: member.uuid, userUuid },
      activity: { action: "project_member_removed", value: { userUuid, role: member.role } },
      changedUserUuids: [userUuid],
    };
  });
}

// public ↔ private. Membership rows are kept on private → public (dormant).
export async function setVisibility(
  auth: AuthContext, projectUuid: string, visibility: ProjectVisibility, confirmationToken?: string,
  settings: { name?: string; description?: string | null } = {},
) {
  if (!isProjectVisibility(visibility)) throw badRequest(`Invalid visibility: ${visibility}`);
  const principal = membershipPrincipal(auth);
  if (visibility === "private" && !principal) {
    throw badRequest("An agent without an owner cannot make a project private");
  }

  return mutateUnderLock(auth, projectUuid, "change_visibility", async (tx, project) => {
    // A concurrent transition can make the requested visibility a no-op.
    // Validate the supplied preview before that branch can apply settings.
    if (confirmationToken !== undefined || project.visibility !== visibility || Object.keys(settings).length) {
      const preview = await getProjectVisibilityPreview(auth, projectUuid, visibility, tx);
      assertAccessConfirmation(preview.confirmationToken, confirmationToken);
    }
    if (project.visibility === visibility) {
      if (Object.keys(settings).length) {
        await tx.project.update({ where: { uuid: projectUuid }, data: settings });
      }
      return { result: { uuid: projectUuid, visibility } };
    }
    await tx.project.update({ where: { uuid: projectUuid }, data: { ...settings, visibility } });
    const current = await tx.project.findFirst({ where: { uuid: projectUuid, companyUuid: auth.companyUuid }, select: { groupUuid: true } });
    if (visibility === "private" && principal && !current?.groupUuid
      && !await implicitProjectAdmin(auth.companyUuid, projectUuid, tx)) {
      // Actor is already an admin (checked under lock); upsert is a safety net
      // so a private project can never be left without an admin.
      await tx.projectMember.upsert({
        where: { projectUuid_userUuid: { projectUuid, userUuid: principal } },
        create: {
          companyUuid: auth.companyUuid,
          projectUuid,
          userUuid: principal,
          role: "admin",
          addedByUuid: principal,
        },
        update: { role: "admin" },
      });
    }
    return {
      result: { uuid: projectUuid, visibility },
      activity: {
        action: "project_visibility_changed",
        value: { fromVisibility: project.visibility, toVisibility: visibility },
      },
      changedUserUuids: [],
    };
  });
}
