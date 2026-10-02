import { prisma } from "@/lib/prisma";
import { eventBus } from "@/lib/event-bus";
import { ApiError } from "@/lib/api-handler";
import type { AuthContext } from "@/types/auth";
import type { Prisma } from "@/generated/prisma/client";
import { invalidateProjectAccessCache, levelAtLeast, membershipPrincipal, resolveInheritedAccessLevel } from "@/services/project-access.service";
import { implicitGroupAdmin } from "@/services/project-group-implicit-admin.service";

export type GroupDbClient = Omit<typeof prisma, "$connect" | "$disconnect" | "$on" | "$transaction" | "$extends">;

export async function lockGroups(tx: GroupDbClient, companyUuid: string, groupUuids: (string | null)[]) {
  for (const uuid of [...new Set(groupUuids.filter((u): u is string => !!u))].sort()) {
    await tx.$queryRaw`SELECT uuid FROM "ProjectGroup" WHERE uuid = ${uuid} AND "companyUuid" = ${companyUuid} FOR UPDATE`;
  }
}

export async function lockProjects(tx: GroupDbClient, companyUuid: string, projectUuids: string[]) {
  for (const uuid of [...new Set(projectUuids)].sort()) {
    await tx.$queryRaw`SELECT uuid FROM "Project" WHERE uuid = ${uuid} AND "companyUuid" = ${companyUuid} FOR UPDATE`;
  }
}

// Keep the complete audit in the protected group stream. Child-project readers
// may see group basics, but must not infer the group's roster or role changes.
export async function auditGroup(
  tx: GroupDbClient, auth: AuthContext, groupUuid: string, projectUuids: string[],
  action: string, value: Record<string, unknown>,
) {
  await tx.comment.create({ data: {
    companyUuid: auth.companyUuid, targetType: "project_group", targetUuid: groupUuid,
    authorType: auth.type === "agent" ? "agent" : "user", authorUuid: auth.actorUuid,
    content: JSON.stringify({ action, ...value }),
  } });
  if (!["group_updated", "group_deleted"].includes(action)) return;
  for (const projectUuid of projectUuids) {
    await tx.activity.create({ data: {
      companyUuid: auth.companyUuid, projectUuid, targetType: "project_group", targetUuid: groupUuid,
      actorType: auth.type === "agent" ? "agent" : "user", actorUuid: auth.actorUuid, action, value: value as Prisma.InputJsonObject,
    } });
  }
}

export function publishGroupAccess(auth: AuthContext, groupUuid: string, projectUuids: string[], userUuids: string[] = []) {
  invalidateProjectAccessCache(auth);
  for (const projectUuid of projectUuids) {
    eventBus.emitProjectAccessChanged({ companyUuid: auth.companyUuid, projectUuid, userUuids });
    eventBus.emitChange({
      companyUuid: auth.companyUuid, projectUuid, entityType: "project",
      entityUuid: projectUuid, action: "updated", actorUuid: auth.actorUuid,
    });
  }
  eventBus.emitChange({
    companyUuid: auth.companyUuid, projectUuid: "", entityType: "project_group",
    entityUuid: groupUuid, action: "updated", actorUuid: auth.actorUuid,
  });
}

export async function materializeGroupGrants(tx: GroupDbClient, auth: AuthContext, groupUuid: string, projectUuid: string) {
  const [direct, inherited, automaticAdmin] = await Promise.all([
    tx.projectMember.findMany({ where: { companyUuid: auth.companyUuid, projectUuid } }),
    tx.projectGroupMember.findMany({ where: { companyUuid: auth.companyUuid, groupUuid } }),
    implicitGroupAdmin(auth.companyUuid, groupUuid, tx),
  ]);
  const roles = new Map(direct.map((r) => [r.userUuid, r.role]));
  for (const member of inherited) {
    const role = resolveInheritedAccessLevel("private", roles.get(member.userUuid) ?? null, member.role);
    if (role !== "none") roles.set(member.userUuid, role);
  }
  // Called only by authorized detach/delete transactions: preserve the lazy
  // group grant as a direct project grant when inheritance is being removed.
  if (automaticAdmin) roles.set(automaticAdmin, "admin");
  if (![...roles.values()].some((r) => r === "admin")) {
    throw new ApiError("BAD_REQUEST", "Detaching must retain a project Admin", 400);
  }
  for (const [userUuid, role] of roles) {
    const current = direct.find((r) => r.userUuid === userUuid);
    if (current && levelAtLeast(current.role as "viewer" | "editor" | "admin", role as "viewer" | "editor" | "admin")) continue;
    await tx.projectMember.upsert({
      where: { projectUuid_userUuid: { projectUuid, userUuid } },
      create: { companyUuid: auth.companyUuid, projectUuid, userUuid, role, addedByUuid: membershipPrincipal(auth) },
      update: { role },
    });
  }
}

export function groupAuth(companyUuid: string, auth?: AuthContext): AuthContext {
  if (!auth || auth.companyUuid !== companyUuid) {
    throw new ApiError("FORBIDDEN", "Authenticated company actor is required", 403);
  }
  return auth;
}
