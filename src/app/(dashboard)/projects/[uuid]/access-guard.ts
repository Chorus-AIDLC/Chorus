// src/app/(dashboard)/projects/[uuid]/access-guard.ts
// Server-only access guards for project-scoped dashboard pages.
// A project (or sub-entity) the caller cannot see is indistinguishable from one
// that does not exist: both render Next's 404 via notFound().

import { cache } from "react";
import { notFound, redirect } from "next/navigation";
import { getServerAuthContext } from "@/lib/auth-server";
import {
  getProjectAccess,
  requireEntityAccess,
  ProjectNotFoundError,
  type AccessEntityType,
  type ProjectMemberRole,
} from "@/services/project-access.service";
import type { Project } from "@/generated/prisma/client";
import type { UserAuthContext } from "@/types/auth";

export interface ProjectPageAccess {
  auth: UserAuthContext;
  project: Project;
  accessLevel: ProjectMemberRole;
}

/**
 * Resolve the signed-in user and their access level for `projectUuid`.
 * - unauthenticated → redirect("/login")
 * - missing / other company / private non-member → notFound()
 *
 * Wrapped in React `cache` so the project layout and the page share a single
 * lookup within one server render.
 */
export const requireProjectPageAccess = cache(
  async (projectUuid: string): Promise<ProjectPageAccess> => {
    const auth = await getServerAuthContext();
    if (!auth) {
      redirect("/login");
    }

    const { project, level } = await getProjectAccess(auth, projectUuid);
    if (!project || level === "none") {
      notFound();
    }

    return { auth, project, accessLevel: level };
  },
);

/**
 * Check whether a sub-entity is viewable under the given project URL: it must
 * exist in the caller's company, belong to `projectUuid`, and the caller must
 * have at least viewer access to its project.
 */
export async function canViewEntityInProject(
  auth: UserAuthContext,
  entityType: AccessEntityType,
  entityUuid: string,
  projectUuid: string,
): Promise<boolean> {
  try {
    const { projectUuid: entityProjectUuid } = await requireEntityAccess(
      auth,
      entityType,
      entityUuid,
      "viewer",
    );
    return entityProjectUuid === projectUuid;
  } catch (error) {
    if (error instanceof ProjectNotFoundError) return false;
    throw error;
  }
}

/** Same as canViewEntityInProject, but calls notFound() when not viewable. */
export async function requireEntityInProject(
  auth: UserAuthContext,
  entityType: AccessEntityType,
  entityUuid: string,
  projectUuid: string,
): Promise<void> {
  if (!(await canViewEntityInProject(auth, entityType, entityUuid, projectUuid))) {
    notFound();
  }
}
