"use server";

import { redirect } from "next/navigation";
import { getServerAuthContext } from "@/lib/auth-server";
import { deleteProject } from "@/services/project.service";
import {
  CwdServiceError,
  type ProjectAgentCwdMutations,
  updateProjectWithAgentCwds,
} from "@/services/project-agent-cwd.service";
import { revalidatePath } from "next/cache";
import { getActiveSessionsForProject, type TaskSessionInfo } from "@/services/session.service";
import logger from "@/lib/logger";

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
    logger.error({ err: error }, "Failed to delete project");
    return { success: false, error: "Failed to delete project" };
  }

  redirect("/projects");
}

export async function updateProjectAction(
  projectUuid: string,
  data: {
    name?: string;
    description?: string | null;
    agentCwds: ProjectAgentCwdMutations;
  },
): Promise<
  | { success: true; data: Awaited<ReturnType<typeof updateProjectWithAgentCwds>> }
  | { success: false; error: { code: string; message: string; agentUuid?: string } }
> {
  const auth = await getServerAuthContext();
  if (!auth) {
    return { success: false, error: { code: "UNAUTHORIZED", message: "Unauthorized" } };
  }

  try {
    const updated = await updateProjectWithAgentCwds({
      companyUuid: auth.companyUuid,
      userUuid: auth.actorUuid,
      projectUuid,
      ...data,
    });
    revalidatePath(`/projects/${projectUuid}/dashboard`);
    return { success: true, data: updated };
  } catch (error) {
    if (error instanceof CwdServiceError) {
      return {
        success: false,
        error: {
          code: error.code,
          message: error.message,
          ...(error.agentUuid ? { agentUuid: error.agentUuid } : {}),
        },
      };
    }
    logger.error({ err: error }, "Failed to update project");
    return {
      success: false,
      error: { code: "INTERNAL_ERROR", message: "Failed to update project" },
    };
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
    logger.error({ err: error }, "Failed to fetch active sessions");
    return { success: false, error: "Failed to fetch active sessions" };
  }
}
