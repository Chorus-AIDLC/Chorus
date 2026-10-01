"use server";

import { redirect } from "next/navigation";
import { getServerAuthContext } from "@/lib/auth-server";
import {
  getSessionsForTask,
  batchGetWorkerCountsForTasks,
  type TaskSessionInfo,
} from "@/services/session.service";
import logger from "@/lib/logger";
import { denyUnlessEntityAccess } from "@/lib/project-access-action";

export async function getTaskSessionsAction(taskUuid: string): Promise<{
  success: boolean;
  data?: TaskSessionInfo[];
  error?: string;
}> {
  const auth = await getServerAuthContext();
  if (!auth) {
    redirect("/login");
  }
  const denied = await denyUnlessEntityAccess(auth, "task", taskUuid, "viewer");
  if (denied) return denied;

  try {
    const sessions = await getSessionsForTask(auth.companyUuid, taskUuid);
    return { success: true, data: sessions };
  } catch (error) {
    logger.error({ err: error }, "Failed to fetch task sessions");
    return { success: false, error: "Failed to fetch task sessions" };
  }
}

export async function getBatchWorkerCountsAction(taskUuids: string[]): Promise<{
  success: boolean;
  data?: Record<string, number>;
  error?: string;
}> {
  const auth = await getServerAuthContext();
  if (!auth) {
    redirect("/login");
  }
  // Silently drop tasks the caller cannot read (badge counts only).
  const checks = await Promise.all(
    taskUuids.map((uuid) => denyUnlessEntityAccess(auth, "task", uuid, "viewer")),
  );
  const readableTaskUuids = taskUuids.filter((_, i) => !checks[i]);

  try {
    const counts = await batchGetWorkerCountsForTasks(auth.companyUuid, readableTaskUuids);
    return { success: true, data: counts };
  } catch (error) {
    logger.error({ err: error }, "Failed to fetch batch worker counts");
    return { success: false, error: "Failed to fetch batch worker counts" };
  }
}
