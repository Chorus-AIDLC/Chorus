// src/lib/authz/project-access.ts
// Project visibility access control — the SINGLE source of truth for whether an
// actor may read or write a given project (and, by cascade, its ideas, proposals,
// documents, tasks, activity, comments, notifications and search hits).
//
// Semantics (Tech Design §3):
//   - super_admin  => sees/manages everything (ALL sentinel; canAccess/canManage true)
//   - user | agent => may access a project when it is SHARED, or they OWN it, or
//                     they are a ProjectMember of it. Membership is the ONLY way
//                     into a private project — the permission bitset (incl.
//                     project:admin) does NOT widen access; it governs *what kind*
//                     of action is allowed, never *which* projects are visible.
//
// The optional AgentAuthContext.projectUuids[] (default-header convenience) is
// intentionally ignored here — it is not an access grant.

import { prisma } from "@/lib/prisma";
import type { AuthContext, SuperAdminAuthContext } from "@/types/auth";

/** Sentinel returned by getAccessibleProjectUuids for actors who see all projects. */
export const ALL_PROJECTS = "ALL" as const;
export type AccessibleProjects = string[] | typeof ALL_PROJECTS;

type AnyAuth = AuthContext | SuperAdminAuthContext;

function isSuperAdmin(auth: AnyAuth): auth is SuperAdminAuthContext {
  return auth.type === "super_admin";
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
    select: { visibility: true, ownerType: true, ownerUuid: true },
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
  return membership !== null;
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
