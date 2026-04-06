"use server";

import { redirect } from "next/navigation";
import { getServerAuthContext } from "@/lib/auth-server";
import { deleteProject, updateProject } from "@/services/project.service";
import { revalidatePath } from "next/cache";
import { getActiveSessionsForProject, type TaskSessionInfo } from "@/services/session.service";

export async function deleteProjectAction(projectUuid: string) {
  const auth = await getServerAuthContext();
  if (!auth) {
    return { success: false, error: "Unauthorized" };
  }

  try {
    const deleted = await deleteProject(auth.companyUuid, projectUuid);
    if (!deleted) {
      return { success: false, error: "Project not found" };
    }
  } catch (error) {
    console.error("Failed to delete project:", error);
    return { success: false, error: "Failed to delete project" };
  }

  redirect("/projects");
}

export async function updateProjectAction(
  projectUuid: string,
  data: { name?: string; description?: string | null }
) {
  const auth = await getServerAuthContext();
  if (!auth) {
    return { success: false, error: "Unauthorized" };
  }

  try {
    const updated = await updateProject(auth.companyUuid, projectUuid, data);
    if (!updated) {
      return { success: false, error: "Project not found" };
    }
    revalidatePath(`/projects/${projectUuid}/dashboard`);
    return { success: true, data: updated };
  } catch (error) {
    console.error("Failed to update project:", error);
    return { success: false, error: "Failed to update project" };
  }
}

export async function getProjectActiveSessionsAction(projectUuid: string): Promise<{
  success: boolean;
  data?: TaskSessionInfo[];
  error?: string;
}> {
  const auth = await getServerAuthContext();
  if (!auth) {
    return { success: false, error: "Unauthorized" };
  }

  try {
    const sessions = await getActiveSessionsForProject(auth.companyUuid, projectUuid);
    return { success: true, data: sessions };
  } catch (error) {
    console.error("Failed to fetch active sessions:", error);
    return { success: false, error: "Failed to fetch active sessions" };
  }
}
