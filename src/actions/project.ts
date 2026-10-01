"use server";

// Server Actions for Project mutations
// Uses Service layer for database operations

import { revalidatePath } from "next/cache";
import { getServerAuthContext } from "@/lib/auth-server";
import * as projectService from "@/services/project.service";
import { isProjectVisibility, type ProjectVisibility } from "@/services/project-access.service";
import { denyUnlessProjectOperation } from "@/lib/project-access-action";

// Error response type
export interface ActionError {
  success: false;
  error: string;
}

// Success response type
export interface ActionSuccess<T> {
  success: true;
  data: T;
}

// Create project action
export async function createProject(
  name: string,
  description?: string,
  visibility: ProjectVisibility = "public"
): Promise<ActionSuccess<{ uuid: string }> | ActionError> {
  const auth = await getServerAuthContext();

  if (!auth) {
    return { success: false, error: "Unauthorized" };
  }
  if (!isProjectVisibility(visibility)) {
    return { success: false, error: "Invalid visibility" };
  }

  const project = await projectService.createProject({
    companyUuid: auth.companyUuid,
    name,
    description,
    visibility,
    createdByUuid: auth.actorUuid,
    actor: { type: "user", uuid: auth.actorUuid },
  });

  // Revalidate projects list
  revalidatePath("/projects");

  return { success: true, data: { uuid: project.uuid } };
}

// Update project action
export async function updateProject(
  uuid: string,
  data: { name?: string; description?: string }
): Promise<ActionSuccess<{ uuid: string }> | ActionError> {
  const auth = await getServerAuthContext();

  if (!auth) {
    return { success: false, error: "Unauthorized" };
  }
  const denied = await denyUnlessProjectOperation(auth, uuid, "manage_project");
  if (denied) return denied;

  const project = await projectService.updateProject(auth.companyUuid, uuid, data);
  if (!project) {
    return { success: false, error: "Project not found" };
  }

  // Revalidate
  revalidatePath("/projects");
  revalidatePath(`/projects/${uuid}/dashboard`);

  return { success: true, data: { uuid: project.uuid } };
}

// Delete project action
export async function deleteProject(
  uuid: string
): Promise<ActionSuccess<null> | ActionError> {
  const auth = await getServerAuthContext();

  if (!auth) {
    return { success: false, error: "Unauthorized" };
  }
  const denied = await denyUnlessProjectOperation(auth, uuid, "manage_project");
  if (denied) return denied;

  const deleted = await projectService.deleteProject(auth.companyUuid, uuid);
  if (!deleted) {
    return { success: false, error: "Project not found" };
  }

  // Revalidate projects list
  revalidatePath("/projects");

  return { success: true, data: null };
}
