"use server";

import { getServerAuthContext } from "@/lib/auth-server";
import { listActivitiesWithActorNames, type ActivityResponse } from "@/services/activity.service";
import { getTaskByUuid } from "@/services/task.service";
import logger from "@/lib/logger";

export async function getTaskActivitiesAction(
  taskUuid: string
): Promise<{ activities: ActivityResponse[]; total: number }> {
  const auth = await getServerAuthContext();
  if (!auth) {
    return { activities: [], total: 0 };
  }

  try {
    // Validate task exists
    const task = await getTaskByUuid(auth.companyUuid, taskUuid);
    if (!task) {
      return { activities: [], total: 0 };
    }

    return await listActivitiesWithActorNames({
      companyUuid: auth.companyUuid,
      projectUuid: task.projectUuid,
      targetType: "task",
      targetUuid: taskUuid,
      skip: 0,
      take: 50,
    });
  } catch (error) {
    logger.error({ err: error }, "Failed to get task activities");
    return { activities: [], total: 0 };
  }
}
