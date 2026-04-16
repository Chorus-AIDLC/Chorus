"use server";

import { getServerAuthContext } from "@/lib/auth-server";
import { listActivitiesWithActorNames, type ActivityResponse } from "@/services/activity.service";
import { getIdeaByUuid } from "@/services/idea.service";
import logger from "@/lib/logger";

export async function getIdeaActivitiesAction(
  ideaUuid: string
): Promise<{ activities: ActivityResponse[]; total: number }> {
  const auth = await getServerAuthContext();
  if (!auth) {
    return { activities: [], total: 0 };
  }

  try {
    const idea = await getIdeaByUuid(auth.companyUuid, ideaUuid);
    if (!idea) {
      return { activities: [], total: 0 };
    }

    return await listActivitiesWithActorNames({
      companyUuid: auth.companyUuid,
      projectUuid: idea.projectUuid,
      targetType: "idea",
      targetUuid: ideaUuid,
      skip: 0,
      take: 50,
    });
  } catch (error) {
    logger.error({ err: error }, "Failed to get idea activities");
    return { activities: [], total: 0 };
  }
}
