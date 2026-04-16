"use server";

import { redirect } from "next/navigation";
import { getServerAuthContext } from "@/lib/auth-server";
import {
  getSessionsForTask,
  batchGetWorkerCountsForTasks,
  type TaskSessionInfo,
} from "@/services/session.service";
import logger from "@/lib/logger";

export async function getTaskSessionsAction(taskUuid: string): Promise<{
  success: boolean;
  data?: TaskSessionInfo[];
  error?: string;
}> {
  const auth = await getServerAuthContext();
  if (!auth) {
    redirect("/login");
  }

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

  try {
    const counts = await batchGetWorkerCountsForTasks(auth.companyUuid, taskUuids);
    return { success: true, data: counts };
  } catch (error) {
    logger.error({ err: error }, "Failed to fetch batch worker counts");
    return { success: false, error: "Failed to fetch batch worker counts" };
  }
}
