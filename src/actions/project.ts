"use server";

// Server Actions for Project mutations
// Uses Service layer for database operations

import { revalidatePath } from "next/cache";
import { getServerAuthContext } from "@/lib/auth-server";
import * as projectService from "@/services/project.service";

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
  description?: string
): Promise<ActionSuccess<{ uuid: string }> | ActionError> {
  const auth = await getServerAuthContext();

  if (!auth) {
    return { success: false, error: "Unauthorized" };
  }

  const project = await projectService.createProject({
    companyUuid: auth.companyUuid,
    name,
    description,
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

  const deleted = await projectService.deleteProject(auth.companyUuid, uuid);
  if (!deleted) {
    return { success: false, error: "Project not found" };
  }

  // Revalidate projects list
  revalidatePath("/projects");

  return { success: true, data: null };
}
