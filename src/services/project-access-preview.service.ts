import { createHash, timingSafeEqual } from "node:crypto";
import { prisma } from "@/lib/prisma";
import { ApiError } from "@/lib/api-handler";
import type { AuthContext } from "@/types/auth";
import {
  computeProjectAccess, isProjectVisibility, levelAtLeast, membershipPrincipal,
  ProjectAccessDeniedError, ProjectNotFoundError, resolveInheritedAccessLevel,
  type ProjectAccessClient, type ProjectVisibility, type ProjectMemberRole,
} from "@/services/project-access.service";

export interface AccessRoleChange {
  userUuid: string;
  beforeRole: string;
  afterRole: string;
}

export interface ProjectVisibilityPreview {
  projectUuid: string;
  name: string;
  fromVisibility: string;
  visibility: ProjectVisibility;
  companyAccess: "opened" | "closed" | "unchanged";
  changes: AccessRoleChange[];
  confirmationToken: string;
}

// These generic primitives are also shared by group conversion and movement.
// A token confirms a particular authenticated preview, not authority: every
// mutation must independently re-check its actor's permissions under locks.
export function accessConfirmationToken(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

export function assertAccessConfirmation(expected: string, supplied?: string): void {
  if (typeof supplied !== "string" || !/^[a-f0-9]{64}$/.test(supplied)
    || !timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(supplied, "hex"))) {
    throw new ApiError("CONFLICT", "Access changed or confirmation is missing; review a fresh access preview", 409);
  }
}

// Lock order is group then project everywhere. If a move changed the group
// between the first read and lock acquisition, abort rather than authorize
// against a new group whose membership lock we do not hold.
export async function lockProjectAccess(
  tx: Pick<typeof prisma, "project" | "$queryRaw">,
  companyUuid: string,
  projectUuid: string,
): Promise<void> {
  const before = await tx.project.findFirst({
    where: { companyUuid, uuid: projectUuid }, select: { groupUuid: true },
  });
  if (!before) throw new ProjectNotFoundError();
  const groupUuid = before.groupUuid ?? null;
  if (groupUuid) {
    await tx.$queryRaw`SELECT uuid FROM "ProjectGroup" WHERE uuid = ${groupUuid} AND "companyUuid" = ${companyUuid} FOR UPDATE`;
  }
  await tx.$queryRaw`SELECT uuid FROM "Project" WHERE uuid = ${projectUuid} AND "companyUuid" = ${companyUuid} FOR UPDATE`;
  const after = await tx.project.findFirst({
    where: { companyUuid, uuid: projectUuid }, select: { groupUuid: true },
  });
  if (!after) throw new ProjectNotFoundError();
  if ((after.groupUuid ?? null) !== groupUuid) {
    throw new ApiError("CONFLICT", "Project group changed; retry with a fresh access preview", 409);
  }
}

export async function getProjectVisibilityPreview(
  auth: AuthContext,
  projectUuid: string,
  visibility: ProjectVisibility,
  client: ProjectAccessClient = prisma,
): Promise<ProjectVisibilityPreview> {
  if (!isProjectVisibility(visibility)) throw new ApiError("BAD_REQUEST", "Invalid visibility", 400);
  const { project, level } = await computeProjectAccess(auth, projectUuid, client);
  if (!project) throw new ProjectNotFoundError();
  if (!levelAtLeast(level, "admin")) throw new ProjectAccessDeniedError();
  const group = project.groupUuid ? await client.projectGroup.findFirst({
    where: { companyUuid: auth.companyUuid, uuid: project.groupUuid },
    select: { uuid: true, visibility: true, accessVersion: true },
  }) : null;
  if (visibility === "public" && group?.visibility === "private") {
    throw new ApiError("BAD_REQUEST", "A private group cannot contain public projects", 400);
  }
  const direct = await client.projectMember.findMany({
    where: { companyUuid: auth.companyUuid, projectUuid },
    select: { userUuid: true, role: true }, orderBy: { userUuid: "asc" },
  });
  const inherited = project.groupUuid ? await client.projectGroupMember.findMany({
    where: { companyUuid: auth.companyUuid, groupUuid: project.groupUuid },
    select: { userUuid: true, role: true }, orderBy: { userUuid: "asc" },
  }) : [];
  const users = await client.user.findMany({
    where: { companyUuid: auth.companyUuid }, select: { uuid: true }, orderBy: { uuid: "asc" },
  });
  const localRoles = new Map(direct.map((r) => [r.userUuid, r.role]));
  const groupRoles = new Map(inherited.map((r) => [r.userUuid, r.role]));
  const changes: AccessRoleChange[] = [];
  for (const user of users) {
    const local = localRoles.get(user.uuid) ?? null;
    const groupRole = groupRoles.get(user.uuid) ?? null;
    const beforeRole = resolveInheritedAccessLevel(project.visibility, local, groupRole);
    const afterRole = resolveInheritedAccessLevel(visibility, local, groupRole);
    if (beforeRole !== afterRole) changes.push({ userUuid: user.uuid, beforeRole, afterRole });
  }
  return {
    projectUuid, name: project.name, fromVisibility: project.visibility, visibility,
    companyAccess: project.visibility === visibility ? "unchanged" : visibility === "public" ? "opened" : "closed",
    changes,
    confirmationToken: accessConfirmationToken({
      operation: "project_visibility", companyUuid: auth.companyUuid,
      principal: membershipPrincipal(auth), actorType: auth.type, actorUuid: auth.actorUuid,
      project: { uuid: project.uuid, visibility: project.visibility, groupUuid: project.groupUuid },
      visibility, group, direct, inherited, users,
    }),
  };
}

export function roleRaises(before: string, after: string): boolean {
  return !levelAtLeast(before as ProjectMemberRole | "none", after as ProjectMemberRole | "none");
}
