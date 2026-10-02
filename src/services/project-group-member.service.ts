import { prisma } from "@/lib/prisma";
import { ApiError } from "@/lib/api-handler";
import type { AuthContext } from "@/types/auth";
import { isProjectMemberRole, membershipPrincipal, type ProjectMemberRole } from "@/services/project-access.service";
import { requireGroupOperation } from "@/services/project-group-access.service";
import { auditGroup, lockGroups, publishGroupAccess } from "@/services/project-group-mutation.service";
import { implicitGroupAdmin } from "@/services/project-group-implicit-admin.service";

export async function listGroupMembers(auth: AuthContext, groupUuid: string) {
  const group = await requireGroupOperation(auth, groupUuid, "read_members");
  const members = await prisma.projectGroupMember.findMany({
    where: { companyUuid: auth.companyUuid, groupUuid }, orderBy: { createdAt: "asc" },
  });
  const automaticAdmin = await implicitGroupAdmin(auth.companyUuid, groupUuid);
  const users = await prisma.user.findMany({
    where: { companyUuid: auth.companyUuid, uuid: { in: [...new Set([
      ...members.map((m) => m.userUuid), ...(automaticAdmin ? [automaticAdmin] : []),
    ])] } },
    select: { uuid: true, name: true, email: true },
  });
  const byUuid = new Map(users.map((u) => [u.uuid, u]));
  const rows = members.map((m) => ({
    uuid: m.uuid, userUuid: m.userUuid, role: m.userUuid === automaticAdmin ? "admin" : m.role,
    name: byUuid.get(m.userUuid)?.name ?? null, email: byUuid.get(m.userUuid)?.email ?? "",
    addedByUuid: m.addedByUuid, createdAt: m.createdAt.toISOString(), updatedAt: m.updatedAt.toISOString(),
    ...(m.userUuid === automaticAdmin ? {
      implicit: true, automaticAdmin: true, directRole: m.role as ProjectMemberRole | null, effectiveRole: "admin",
    } : {}),
  }));
  if (automaticAdmin && !members.some((m) => m.userUuid === automaticAdmin)) {
    rows.unshift({
      uuid: `implicit:${groupUuid}:${automaticAdmin}`, userUuid: automaticAdmin, role: "admin",
      name: byUuid.get(automaticAdmin)?.name ?? null, email: byUuid.get(automaticAdmin)?.email ?? "",
      addedByUuid: null, createdAt: group.createdAt.toISOString(), updatedAt: group.updatedAt.toISOString(),
      implicit: true, automaticAdmin: true, directRole: null, effectiveRole: "admin",
    });
  }
  return rows;
}

async function mutateMember(auth: AuthContext, groupUuid: string, userUuid: string, role: ProjectMemberRole | null, create: boolean) {
  if (role !== null && !isProjectMemberRole(role)) throw new ApiError("BAD_REQUEST", "Invalid member role", 400);
  await requireGroupOperation(auth, groupUuid, "manage_members");
  const out = await prisma.$transaction(async (tx) => {
    await lockGroups(tx, auth.companyUuid, [groupUuid]);
    await requireGroupOperation(auth, groupUuid, "manage_members", tx);
    const automaticAdmin = await implicitGroupAdmin(auth.companyUuid, groupUuid, tx);
    const user = await tx.user.findFirst({ where: { uuid: userUuid, companyUuid: auth.companyUuid }, select: { uuid: true } });
    if (!user) throw new ApiError("NOT_FOUND", "User not found in this company", 404);
    const existing = await tx.projectGroupMember.findUnique({ where: { groupUuid_userUuid: { groupUuid, userUuid } } });
    if (automaticAdmin === userUuid && role !== "admin") {
      throw new ApiError("BAD_REQUEST", "Cannot remove or demote the automatic group Admin", 400);
    }
    if (!create && !existing) throw new ApiError("NOT_FOUND", "Group member not found", 404);
    if (create && existing) throw new ApiError("CONFLICT", "Group member already exists", 409);
    if (existing?.role === "admin" && role !== "admin") {
      const count = await tx.projectGroupMember.count({ where: { companyUuid: auth.companyUuid, groupUuid, role: "admin" } });
      if (count <= 1) throw new ApiError("BAD_REQUEST", "Cannot remove or demote the last group Admin", 400);
    }
    const result = role === null
      ? await tx.projectGroupMember.delete({ where: { groupUuid_userUuid: { groupUuid, userUuid } } })
      : create
        ? await tx.projectGroupMember.create({ data: { companyUuid: auth.companyUuid, groupUuid, userUuid, role, addedByUuid: membershipPrincipal(auth) } })
        : await tx.projectGroupMember.update({ where: { groupUuid_userUuid: { groupUuid, userUuid } }, data: { role } });
    await tx.projectGroup.update({ where: { uuid: groupUuid }, data: { accessVersion: { increment: 1 } } });
    const projects = await tx.project.findMany({ where: { companyUuid: auth.companyUuid, groupUuid }, select: { uuid: true } });
    const projectUuids = projects.map((p) => p.uuid);
    await auditGroup(tx, auth, groupUuid, projectUuids, role === null ? "group_member_removed" : "group_member_changed", { userUuid, beforeRole: existing?.role ?? null, role });
    // The first explicit Admin ends the fallback across every child project.
    const userUuids = [...new Set([userUuid, ...(automaticAdmin && role === "admin" ? [automaticAdmin] : [])])];
    return { result, projectUuids, userUuids };
  });
  publishGroupAccess(auth, groupUuid, out.projectUuids, out.userUuids);
  return { ...out.result, createdAt: out.result.createdAt.toISOString(), updatedAt: out.result.updatedAt.toISOString() };
}

export function addGroupMember(auth: AuthContext, groupUuid: string, userUuid: string, role: ProjectMemberRole) {
  return mutateMember(auth, groupUuid, userUuid, role, true);
}
export function updateGroupMember(auth: AuthContext, groupUuid: string, userUuid: string, role: ProjectMemberRole) {
  return mutateMember(auth, groupUuid, userUuid, role, false);
}
export async function removeGroupMember(auth: AuthContext, groupUuid: string, userUuid: string) {
  await mutateMember(auth, groupUuid, userUuid, null, false);
  return { removed: true };
}
