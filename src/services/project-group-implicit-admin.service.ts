import { prisma } from "@/lib/prisma";
import { eventBus } from "@/lib/event-bus";
import type { ProjectAccessClient } from "@/services/project-access.service";

// Request-scoped only. Transaction clients always read fresh rows after locks;
// long-lived consumers invalidate their request scope before access refreshes.
const firstUsers = new WeakMap<object, Map<string, Promise<string | null>>>();

export function invalidateImplicitGroupAdminCache(request: object): void {
  firstUsers.delete(request);
}

export async function firstCompanyUser(
  companyUuid: string, client: ProjectAccessClient = prisma, request?: object,
): Promise<string | null> {
  const read = async () => (await client.user.findFirst({
    where: { companyUuid }, orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { uuid: true },
  }))?.uuid ?? null;
  if (!request || client !== prisma) return read();
  let companies = firstUsers.get(request);
  if (!companies) {
    companies = new Map();
    firstUsers.set(request, companies);
  }
  let pending = companies.get(companyUuid);
  if (!pending) {
    pending = read();
    companies.set(companyUuid, pending);
    pending.catch(() => companies!.delete(companyUuid));
  }
  return pending;
}

/** A computed fallback, never a stored membership or a public editor floor. */
export async function implicitGroupAdmin(
  companyUuid: string, groupUuid: string, client: ProjectAccessClient = prisma, request?: object,
): Promise<string | null> {
  const group = await client.projectGroup.findFirst({
    where: { companyUuid, uuid: groupUuid }, select: { uuid: true },
  });
  if (!group) return null;
  const admin = await client.projectGroupMember.findFirst({
    where: { companyUuid, groupUuid, role: "admin" }, select: { userUuid: true },
  });
  return admin ? null : firstCompanyUser(companyUuid, client, request);
}

/** Project fallback is unnecessary when a live group supplies its own Admin. */
export async function implicitProjectAdmin(
  companyUuid: string, projectUuid: string, client: ProjectAccessClient = prisma, request?: object,
): Promise<string | null> {
  const project = await client.project.findFirst({
    where: { companyUuid, uuid: projectUuid }, select: { uuid: true, groupUuid: true },
  });
  if (!project) return null;
  const admin = await client.projectMember.findFirst({
    where: { companyUuid, projectUuid, role: "admin" }, select: { userUuid: true },
  });
  if (admin) return null;
  if (project.groupUuid && await client.projectGroup.findFirst({
    where: { companyUuid, uuid: project.groupUuid }, select: { uuid: true },
  })) return null;
  return firstCompanyUser(companyUuid, client, request);
}

// Batch orphan detection also covers old missing/foreign group references
// without relying on relationMode's nullable-relation SQL optimizations.
export async function implicitProjectAdminUuids(companyUuid: string): Promise<string[]> {
  const projects = await prisma.project.findMany({
    where: { companyUuid, members: { none: { companyUuid, role: "admin" } } },
    select: { uuid: true, groupUuid: true },
  });
  const groupUuids = [...new Set(projects.map((project) => project.groupUuid).filter((uuid): uuid is string => !!uuid))];
  const groups = groupUuids.length ? await prisma.projectGroup.findMany({
    where: { companyUuid, uuid: { in: groupUuids } }, select: { uuid: true },
  }) : [];
  const liveGroups = new Set(groups.map((group) => group.uuid));
  return projects.filter((project) => !project.groupUuid || !liveGroups.has(project.groupUuid)).map((project) => project.uuid);
}

// No user-deletion API exists today. A live stream also detects a first-user
// change during its heartbeat, including changes made outside this process.
export async function publishImplicitGroupAdminChange(companyUuid: string): Promise<void> {
  const groups = await prisma.projectGroup.findMany({
    where: { companyUuid, members: { none: { companyUuid, role: "admin" } } },
    select: { uuid: true },
  });
  const projects = await prisma.project.findMany({
    where: { companyUuid, groupUuid: { in: groups.map((group) => group.uuid) } },
    select: { uuid: true },
  });
  const automaticProjects = await implicitProjectAdminUuids(companyUuid);
  for (const projectUuid of new Set([...projects.map((project) => project.uuid), ...automaticProjects])) {
    eventBus.emitProjectAccessChanged({ companyUuid, projectUuid, userUuids: [] });
  }
  for (const group of groups) {
    eventBus.emitChange({
      companyUuid, projectUuid: "", entityType: "project_group", entityUuid: group.uuid, action: "updated",
    });
  }
}
