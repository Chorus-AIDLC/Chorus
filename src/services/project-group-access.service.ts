import { prisma } from "@/lib/prisma";
import { ApiError } from "@/lib/api-handler";
import type { Prisma, ProjectGroup } from "@/generated/prisma/client";
import type { AuthContext } from "@/types/auth";
import {
  isProjectMemberRole, levelAtLeast, membershipPrincipal, ProjectAccessDeniedError,
  type ProjectAccessClient, type ProjectAccessLevel, type ProjectMemberRole,
} from "@/services/project-access.service";

export type GroupOperation = "manage_group" | "create_project" | "manage_members" | "change_visibility" | "delete_group" | "read_members";
export interface GroupAccessResult {
  group: ProjectGroup | null;
  level: ProjectAccessLevel;
  explicitRole: ProjectMemberRole | null;
  canManage: boolean;
  canCreateProject: boolean;
  accessInitialized: boolean;
}

export class GroupNotFoundError extends ApiError {
  constructor() { super("NOT_FOUND", "Project group not found", 404); }
}

export function groupAccessPresentation(group: ProjectGroup, explicitRole: ProjectMemberRole | null, accessInitialized: boolean): GroupAccessResult {
  const publicEditing = group.visibility === "public";
  return {
    group,
    level: publicEditing ? (explicitRole === "admin" ? "admin" : "editor") : explicitRole ?? "viewer",
    explicitRole,
    canManage: publicEditing || explicitRole === "admin",
    canCreateProject: publicEditing || (explicitRole !== null && levelAtLeast(explicitRole, "editor")),
    accessInitialized,
  };
}

// The query includes project-only discovery without treating project grants as
// authority over the group or inheriting a public group's implicit editor floor.
export async function accessibleGroupWhere(auth: AuthContext): Promise<Prisma.ProjectGroupWhereInput> {
  const principal = membershipPrincipal(auth);
  return {
    companyUuid: auth.companyUuid,
    OR: [
      { visibility: "public" },
      ...(principal ? [
        { members: { some: { companyUuid: auth.companyUuid, userUuid: principal, role: { in: ["viewer", "editor", "admin"] } } } },
        { projects: { some: { companyUuid: auth.companyUuid, OR: [
          { visibility: "public" },
          { members: { some: { companyUuid: auth.companyUuid, userUuid: principal, role: { in: ["viewer", "editor", "admin"] } } } },
        ] } } },
      ] : [{ projects: { some: { companyUuid: auth.companyUuid, visibility: "public" } } }]),
    ],
  };
}

export async function getGroupAccess(
  auth: AuthContext, groupUuid: string, client: ProjectAccessClient = prisma,
): Promise<GroupAccessResult> {
  const group = await client.projectGroup.findFirst({ where: { uuid: groupUuid, companyUuid: auth.companyUuid } });
  const hidden: GroupAccessResult = {
    group: null, level: "none", explicitRole: null, canManage: false, canCreateProject: false, accessInitialized: false,
  };
  if (!group) return hidden;
  const principal = membershipPrincipal(auth);
  const member = principal ? await client.projectGroupMember.findFirst({
    where: { companyUuid: auth.companyUuid, groupUuid, userUuid: principal }, select: { role: true },
  }) : null;
  const explicitRole = isProjectMemberRole(member?.role) ? member.role : null;
  const accessInitialized = await client.projectGroupMember.count({
    where: { companyUuid: auth.companyUuid, groupUuid, role: "admin" },
  }) > 0;
  if (group.visibility === "private" && !explicitRole) {
    const child = await client.project.findFirst({
      where: { companyUuid: auth.companyUuid, groupUuid, OR: [
        { visibility: "public" },
        ...(principal ? [{ members: { some: { companyUuid: auth.companyUuid, userUuid: principal, role: { in: ["viewer", "editor", "admin"] } } } }] : []),
      ] }, select: { uuid: true },
    });
    if (!child) return hidden;
  }
  return groupAccessPresentation(group, explicitRole, accessInitialized);
}

export async function requireGroupOperation(
  auth: AuthContext, groupUuid: string, operation: GroupOperation, client: ProjectAccessClient = prisma,
): Promise<ProjectGroup & {
  accessLevel: ProjectMemberRole; explicitRole: ProjectMemberRole | null;
  canManage: boolean; canCreateProject: boolean; accessInitialized: boolean;
}> {
  const access = await getGroupAccess(auth, groupUuid, client);
  if (!access.group) throw new GroupNotFoundError();
  const allowed = operation === "manage_group" ? access.canManage
    : operation === "create_project" ? access.canCreateProject
    : operation === "read_members" ? access.explicitRole !== null
    : access.explicitRole === "admin";
  if (!allowed) throw new ProjectAccessDeniedError("Insufficient project group access");
  return {
    ...access.group, accessLevel: access.level as ProjectMemberRole,
    explicitRole: access.explicitRole, canManage: access.canManage,
    canCreateProject: access.canCreateProject, accessInitialized: access.accessInitialized,
  };
}
