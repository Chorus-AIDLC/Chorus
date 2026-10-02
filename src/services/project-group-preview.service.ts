import { prisma } from "@/lib/prisma";
import { ApiError } from "@/lib/api-handler";
import type { AuthContext } from "@/types/auth";
import {
  computeProjectAccess, isProjectVisibility, levelAtLeast, membershipPrincipal,
  ProjectAccessDeniedError, ProjectNotFoundError, resolveInheritedAccessLevel,
  type ProjectAccessClient, type ProjectVisibility,
} from "@/services/project-access.service";
import { GroupNotFoundError, requireGroupOperation } from "@/services/project-group-access.service";
import { accessConfirmationToken, roleRaises, type AccessRoleChange } from "@/services/project-access-preview.service";

export interface GroupProjectAccessImpact {
  projectUuid: string;
  name: string;
  fromVisibility: string;
  visibility: string;
  companyAccess: "opened" | "closed" | "unchanged";
  changes: AccessRoleChange[];
}
export interface GroupVisibilityPreview {
  groupUuid: string;
  fromVisibility: string;
  visibility: ProjectVisibility;
  companyAccess: "opened" | "closed" | "unchanged";
  projects: GroupProjectAccessImpact[];
  confirmationToken: string;
}
export interface ProjectGroupMovePreview extends GroupProjectAccessImpact {
  sourceGroupUuid: string | null;
  groupUuid: string | null;
  requiresConfirmation: boolean;
  confirmationToken: string;
}

function companyAccess(before: string, after: string): GroupProjectAccessImpact["companyAccess"] {
  return before === after ? "unchanged" : after === "public" ? "opened" : "closed";
}

export async function getGroupVisibilityPreview(
  auth: AuthContext, groupUuid: string, visibility: ProjectVisibility, client: ProjectAccessClient = prisma,
): Promise<GroupVisibilityPreview> {
  if (!isProjectVisibility(visibility)) throw new ApiError("BAD_REQUEST", "Invalid visibility", 400);
  const group = await requireGroupOperation(auth, groupUuid, "change_visibility", client);
  const [projects, inherited, users] = await Promise.all([
    client.project.findMany({ where: { companyUuid: auth.companyUuid, groupUuid }, orderBy: { uuid: "asc" }, select: { uuid: true, name: true, visibility: true, groupUuid: true } }),
    client.projectGroupMember.findMany({ where: { companyUuid: auth.companyUuid, groupUuid }, select: { userUuid: true, role: true }, orderBy: { userUuid: "asc" } }),
    client.user.findMany({ where: { companyUuid: auth.companyUuid }, select: { uuid: true, name: true, email: true }, orderBy: { uuid: "asc" } }),
  ]);
  const direct = await client.projectMember.findMany({
    where: { companyUuid: auth.companyUuid, projectUuid: { in: projects.map((p) => p.uuid) } },
    select: { projectUuid: true, userUuid: true, role: true }, orderBy: [{ projectUuid: "asc" }, { userUuid: "asc" }],
  });
  const groupRoles = new Map(inherited.map((m) => [m.userUuid, m.role]));
  const impacts = projects.map((p) => {
    const after = visibility === "private" ? "private" : p.visibility;
    const local = new Map(direct.filter((m) => m.projectUuid === p.uuid).map((m) => [m.userUuid, m.role]));
    const changes = users.flatMap((u) => {
      const beforeRole = resolveInheritedAccessLevel(p.visibility, local.get(u.uuid) ?? null, groupRoles.get(u.uuid) ?? null);
      const afterRole = resolveInheritedAccessLevel(after, local.get(u.uuid) ?? null, groupRoles.get(u.uuid) ?? null);
      return beforeRole === afterRole ? [] : [{
        userUuid: u.uuid, name: u.name ?? null, email: u.email ?? null, beforeRole, afterRole,
      }];
    });
    return { projectUuid: p.uuid, name: p.name, fromVisibility: p.visibility, visibility: after, companyAccess: companyAccess(p.visibility, after), changes };
  });
  return {
    groupUuid, fromVisibility: group.visibility, visibility,
    companyAccess: companyAccess(group.visibility, visibility), projects: impacts,
    confirmationToken: accessConfirmationToken({
      operation: "group_visibility", companyUuid: auth.companyUuid,
      principal: membershipPrincipal(auth), actorType: auth.type, actorUuid: auth.actorUuid,
      group: { uuid: group.uuid, visibility: group.visibility, accessVersion: group.accessVersion },
      visibility, projects, direct, inherited, users: users.map(({ uuid }) => ({ uuid })),
    }),
  };
}

export async function getProjectGroupMovePreview(
  auth: AuthContext, projectUuid: string, groupUuid: string | null, client: ProjectAccessClient = prisma,
): Promise<ProjectGroupMovePreview> {
  const { project, level } = await computeProjectAccess(auth, projectUuid, client);
  if (!project) throw new ProjectNotFoundError();
  if (!levelAtLeast(level, project.visibility === "private" ? "admin" : "editor")) throw new ProjectAccessDeniedError();
  const source = project.groupUuid ? await client.projectGroup.findFirst({ where: { companyUuid: auth.companyUuid, uuid: project.groupUuid } }) : null;
  const target = groupUuid ? await client.projectGroup.findFirst({ where: { companyUuid: auth.companyUuid, uuid: groupUuid } }) : null;
  if (groupUuid && !target) throw new GroupNotFoundError();
  if (target) await requireGroupOperation(auth, target.uuid, "create_project", client);
  const privateBoundary = project.visibility === "private" || source?.visibility === "private" || target?.visibility === "private";
  if (privateBoundary) {
    if (source) await requireGroupOperation(auth, source.uuid, "change_visibility", client);
    else if (!levelAtLeast(level, "admin")) throw new ProjectAccessDeniedError();
    if (target) await requireGroupOperation(auth, target.uuid, "change_visibility", client);
  }
  // Ordinary public moves also allow editors; only existing Admin authority
  // permits enriching their role diff with company user identities.
  const includeIdentities = levelAtLeast(level, "admin");
  const [direct, inherited, users] = await Promise.all([
    client.projectMember.findMany({ where: { companyUuid: auth.companyUuid, projectUuid }, select: { userUuid: true, role: true }, orderBy: { userUuid: "asc" } }),
    client.projectGroupMember.findMany({
      where: { companyUuid: auth.companyUuid, groupUuid: { in: [...new Set([source?.uuid, target?.uuid].filter((u): u is string => !!u))] } },
      select: { groupUuid: true, userUuid: true, role: true }, orderBy: [{ groupUuid: "asc" }, { userUuid: "asc" }],
    }),
    client.user.findMany({
      where: { companyUuid: auth.companyUuid },
      select: { uuid: true, ...(includeIdentities ? { name: true, email: true } : {}) },
      orderBy: { uuid: "asc" },
    }),
  ]);
  const local = new Map(direct.map((m) => [m.userUuid, m.role]));
  const beforeGroup = new Map(inherited.filter((m) => m.groupUuid === source?.uuid).map((m) => [m.userUuid, m.role]));
  const afterGroup = new Map(inherited.filter((m) => m.groupUuid === target?.uuid).map((m) => [m.userUuid, m.role]));
  const afterVisibility = target?.visibility === "private" ? "private" : project.visibility;
  const changes = users.flatMap((u) => {
    const beforeRole = resolveInheritedAccessLevel(project.visibility, local.get(u.uuid) ?? null, beforeGroup.get(u.uuid) ?? null);
    // Detach snapshots the explicit maximum; a public floor is never saved.
    const retained = !target && source ? resolveInheritedAccessLevel("private", local.get(u.uuid) ?? null, beforeGroup.get(u.uuid) ?? null) : local.get(u.uuid) ?? null;
    const afterRole = resolveInheritedAccessLevel(afterVisibility, retained, afterGroup.get(u.uuid) ?? null);
    return beforeRole === afterRole ? [] : [{
      userUuid: u.uuid,
      ...(includeIdentities ? { name: u.name ?? null, email: u.email ?? null } : {}),
      beforeRole, afterRole,
    }];
  });
  if (changes.some((c) => roleRaises(c.beforeRole, c.afterRole)) && !levelAtLeast(level, "admin")) {
    throw new ProjectAccessDeniedError("Only source project Admins can confirm a move that expands access");
  }
  return {
    projectUuid, name: project.name, sourceGroupUuid: project.groupUuid, groupUuid,
    fromVisibility: project.visibility, visibility: afterVisibility,
    companyAccess: companyAccess(project.visibility, afterVisibility), changes,
    requiresConfirmation: changes.length > 0 || project.visibility !== afterVisibility || (privateBoundary && project.groupUuid !== groupUuid),
    confirmationToken: accessConfirmationToken({
      operation: "project_group_move", companyUuid: auth.companyUuid,
      principal: membershipPrincipal(auth), actorType: auth.type, actorUuid: auth.actorUuid,
      project: { uuid: project.uuid, name: project.name, visibility: project.visibility, groupUuid: project.groupUuid },
      source: source ? { uuid: source.uuid, visibility: source.visibility, accessVersion: source.accessVersion } : null,
      target: target ? { uuid: target.uuid, visibility: target.visibility, accessVersion: target.accessVersion } : null,
      groupUuid, direct, inherited, users: users.map(({ uuid }) => ({ uuid })),
    }),
  };
}
