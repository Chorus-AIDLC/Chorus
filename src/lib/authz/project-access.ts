// src/lib/authz/project-access.ts
// Project visibility access control — the SINGLE source of truth for whether an
// actor may read or write a given project (and, by cascade, its ideas, proposals,
// documents, tasks, activity, comments, notifications and search hits).
//
// Semantics:
//   - super_admin  => sees/manages everything (ALL sentinel; canAccess/canManage true)
//   - user | agent => may access a project when it is SHARED, or they OWN it, or
//                     they are a ProjectMember of it, OR they own / are a member of
//                     the project's GROUP (dynamic two-level union — see below).
//                     Membership is the ONLY way into a private project — the
//                     permission bitset (incl. project:admin) does NOT widen access.
//
// Two-level inheritance (dynamic union):
//   A project's effective accessors = (project owner + ProjectMembers)
//                                     ∪ (its group's owner + ProjectGroupMembers).
//   ⚠️ TWO DISTINCT group-sets — do NOT conflate:
//     • PROJECT-UNION set (getAccessibleProjectUuids / canAccessProject group
//       fallthrough): groups the actor OWNS or is a MEMBER of — NOT shared groups.
//       A shared group must not turn its PRIVATE projects company-wide; that would
//       break "项目级 > 项目组" (the project's own visibility flag is authoritative).
//     • GROUP-VISIBILITY set (getAccessibleGroupUuids / canAccessGroup): shared ∪
//       owned ∪ member groups — used ONLY to decide which GROUPS an actor may
//       see/open, never for project access.
//   The union only ADDS accessors; it never removes or downgrades a project.
//
// The optional AgentAuthContext.projectUuids[] (default-header convenience) is
// intentionally ignored here — it is not an access grant.

import { prisma } from "@/lib/prisma";
import type { AuthContext, SuperAdminAuthContext } from "@/types/auth";

/** Sentinel returned by getAccessibleProjectUuids for actors who see all projects. */
export const ALL_PROJECTS = "ALL" as const;
export type AccessibleProjects = string[] | typeof ALL_PROJECTS;

export type AnyAuth = AuthContext | SuperAdminAuthContext;

function isSuperAdmin(auth: AnyAuth): auth is SuperAdminAuthContext {
  return auth.type === "super_admin";
}

/**
 * UUIDs of groups the actor OWNS or is a ProjectGroupMember of. This is the
 * "project-union" group-set — it deliberately EXCLUDES shared groups, because a
 * shared group must not pull its private projects into company-wide view.
 * Used by getAccessibleProjectUuids + canAccessProject for project inheritance.
 */
async function getOwnedOrMemberGroupUuids(
  companyUuid: string,
  type: string,
  actorUuid: string,
): Promise<string[]> {
  const [ownedGroups, groupMemberships] = await Promise.all([
    prisma.projectGroup.findMany({
      where: { companyUuid, ownerType: type, ownerUuid: actorUuid },
      select: { uuid: true },
    }),
    prisma.projectGroupMember.findMany({
      where: { companyUuid, memberType: type, memberUuid: actorUuid },
      select: { projectGroupUuid: true },
    }),
  ]);
  const set = new Set<string>();
  for (const g of ownedGroups) set.add(g.uuid);
  for (const m of groupMemberships) set.add(m.projectGroupUuid);
  return [...set];
}

/**
 * Whether the actor owns or is a member of the given group (shared-agnostic —
 * does NOT return true merely because the group is shared). This is the gate
 * used for PROJECT inheritance; for group visibility use canAccessGroup.
 */
async function isGroupOwnerOrMember(
  auth: AuthContext,
  groupUuid: string,
): Promise<boolean> {
  const { companyUuid, actorUuid, type } = auth;
  const group = await prisma.projectGroup.findFirst({
    where: { uuid: groupUuid, companyUuid },
    select: { ownerType: true, ownerUuid: true },
  });
  if (!group) return false;
  if (group.ownerType === type && group.ownerUuid === actorUuid) return true;
  const membership = await prisma.projectGroupMember.findUnique({
    where: {
      projectGroupUuid_memberType_memberUuid: {
        projectGroupUuid: groupUuid,
        memberType: type,
        memberUuid: actorUuid,
      },
    },
    select: { id: true },
  });
  return membership !== null;
}

/**
 * Returns the set of project UUIDs the actor may access within their company,
 * or the ALL_PROJECTS sentinel for super admins (meaning "do not filter").
 *
 * For users/agents the set is: all SHARED projects of the company, plus any
 * PRIVATE project they own, plus any project they are a member of.
 */
export async function getAccessibleProjectUuids(
  auth: AnyAuth,
): Promise<AccessibleProjects> {
  if (isSuperAdmin(auth)) return ALL_PROJECTS;

  const { companyUuid, actorUuid, type } = auth;

  // Shared projects + projects owned by this actor, in one query.
  const visibleProjects = await prisma.project.findMany({
    where: {
      companyUuid,
      OR: [{ visibility: "shared" }, { ownerType: type, ownerUuid: actorUuid }],
    },
    select: { uuid: true },
  });

  // Private projects this actor is an explicit member of.
  const memberships = await prisma.projectMember.findMany({
    where: { companyUuid, memberType: type, memberUuid: actorUuid },
    select: { projectUuid: true },
  });

  const uuids = new Set<string>();
  for (const p of visibleProjects) uuids.add(p.uuid);
  for (const m of memberships) uuids.add(m.projectUuid);

  // Dynamic two-level union: add every project belonging to a group the actor
  // OWNS or is a MEMBER of (shared groups excluded — see module header).
  const unionGroupUuids = await getOwnedOrMemberGroupUuids(companyUuid, type, actorUuid);
  if (unionGroupUuids.length > 0) {
    const groupProjects = await prisma.project.findMany({
      where: { companyUuid, groupUuid: { in: unionGroupUuids } },
      select: { uuid: true },
    });
    for (const p of groupProjects) uuids.add(p.uuid);
  }

  return [...uuids];
}

/**
 * Whether the actor may access (read OR write) the given project.
 * Used by every single-entity read and every mutation that targets a project
 * or a project-scoped entity. Returns false for an unknown/cross-company project.
 */
export async function canAccessProject(
  auth: AnyAuth,
  projectUuid: string,
): Promise<boolean> {
  if (isSuperAdmin(auth)) return true;
  if (!projectUuid) return false;

  const { companyUuid, actorUuid, type } = auth;

  const project = await prisma.project.findFirst({
    where: { uuid: projectUuid, companyUuid },
    select: { visibility: true, ownerType: true, ownerUuid: true, groupUuid: true },
  });
  if (!project) return false;

  if (project.visibility === "shared") return true;
  if (project.ownerType === type && project.ownerUuid === actorUuid) return true;

  const membership = await prisma.projectMember.findUnique({
    where: {
      projectUuid_memberType_memberUuid: {
        projectUuid,
        memberType: type,
        memberUuid: actorUuid,
      },
    },
    select: { id: true },
  });
  if (membership !== null) return true;

  // Two-level inheritance: a member/owner of the project's GROUP inherits access
  // (shared groups don't count — isGroupOwnerOrMember is shared-agnostic).
  if (project.groupUuid && (await isGroupOwnerOrMember(auth, project.groupUuid))) {
    return true;
  }

  return false;
}

/**
 * Whether the actor may MANAGE the project — change visibility, manage members,
 * or delete it. Restricted to the owner (or super admin). Plain members cannot
 * manage.
 */
export async function canManageProject(
  auth: AnyAuth,
  projectUuid: string,
): Promise<boolean> {
  if (isSuperAdmin(auth)) return true;
  if (!projectUuid) return false;

  const { companyUuid, actorUuid, type } = auth;

  const project = await prisma.project.findFirst({
    where: { uuid: projectUuid, companyUuid },
    select: { ownerType: true, ownerUuid: true },
  });
  if (!project) return false;

  return project.ownerType === type && project.ownerUuid === actorUuid;
}

// ===========================================================================
// Group visibility (the GROUP-VISIBILITY set — distinct from project-union).
// These decide which GROUPS an actor may see/open. They DO include shared
// groups, and must NEVER be used for project access (see module header).
// ===========================================================================

/**
 * Project-group UUIDs the actor may see: all SHARED groups of the company, plus
 * any group they own or are a member of. ALL_PROJECTS sentinel for super admins.
 */
export async function getAccessibleGroupUuids(
  auth: AnyAuth,
): Promise<AccessibleProjects> {
  if (isSuperAdmin(auth)) return ALL_PROJECTS;

  const { companyUuid, actorUuid, type } = auth;

  const visibleGroups = await prisma.projectGroup.findMany({
    where: {
      companyUuid,
      OR: [{ visibility: "shared" }, { ownerType: type, ownerUuid: actorUuid }],
    },
    select: { uuid: true },
  });
  const memberships = await prisma.projectGroupMember.findMany({
    where: { companyUuid, memberType: type, memberUuid: actorUuid },
    select: { projectGroupUuid: true },
  });

  const uuids = new Set<string>();
  for (const g of visibleGroups) uuids.add(g.uuid);
  for (const m of memberships) uuids.add(m.projectGroupUuid);
  return [...uuids];
}

/**
 * Whether the actor may access (see/open) the given group: shared → anyone in
 * the company; otherwise owner or ProjectGroupMember. (For PROJECT inheritance
 * use the shared-agnostic internal check, not this.)
 */
export async function canAccessGroup(
  auth: AnyAuth,
  groupUuid: string,
): Promise<boolean> {
  if (isSuperAdmin(auth)) return true;
  if (!groupUuid) return false;

  const { companyUuid, actorUuid, type } = auth;
  const group = await prisma.projectGroup.findFirst({
    where: { uuid: groupUuid, companyUuid },
    select: { visibility: true, ownerType: true, ownerUuid: true },
  });
  if (!group) return false;
  if (group.visibility === "shared") return true;
  if (group.ownerType === type && group.ownerUuid === actorUuid) return true;
  return isGroupOwnerOrMember(auth, groupUuid);
}

/**
 * Whether the actor may MANAGE the group — change visibility, manage members.
 * Restricted to the group owner (or super admin); plain members cannot manage.
 */
export async function canManageGroup(
  auth: AnyAuth,
  groupUuid: string,
): Promise<boolean> {
  if (isSuperAdmin(auth)) return true;
  if (!groupUuid) return false;

  const { companyUuid, actorUuid, type } = auth;
  const group = await prisma.projectGroup.findFirst({
    where: { uuid: groupUuid, companyUuid },
    select: { ownerType: true, ownerUuid: true },
  });
  if (!group) return false;
  return group.ownerType === type && group.ownerUuid === actorUuid;
}

/**
 * Query-injection helper. Given an existing Prisma `where` (already scoped by
 * companyUuid) and an accessible-projects result, returns a `where` that also
 * restricts `projectUuid` to the accessible set — UNLESS the set is the
 * ALL_PROJECTS sentinel, in which case the original `where` is returned
 * unchanged (super admin: no visibility filtering).
 *
 * `projectField` lets callers target a differently-named column (default
 * "projectUuid"), e.g. when filtering the Project table itself by "uuid".
 */
export function applyProjectFilter<T extends Record<string, unknown>>(
  where: T,
  accessible: AccessibleProjects,
  projectField: string = "projectUuid",
): T {
  if (accessible === ALL_PROJECTS) return where;
  return { ...where, [projectField]: { in: accessible } };
}
