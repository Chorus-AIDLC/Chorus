import { getProjectStats } from "@/services/project.service";
import { getTrackerGroups } from "@/services/idea.service";
import { listActivitiesWithActorNames } from "@/services/activity.service";
import { requireProjectPageAccess } from "../access-guard";

export async function getDashboardData(projectUuid: string) {
  // Access gate: unauthenticated → /login, no project access → 404
  const { auth, project, accessLevel } = await requireProjectPageAccess(projectUuid);

  const trackerData = await getTrackerGroups(auth.companyUuid, projectUuid);
  const stats = await getProjectStats(auth.companyUuid, projectUuid);
  const { activities } = await listActivitiesWithActorNames({
    companyUuid: auth.companyUuid,
    projectUuid,
    skip: 0,
    take: 5,
  });

  return {
    project,
    accessLevel,
    trackerData,
    stats,
    activities,
    currentUserUuid: auth.actorUuid,
  };
}
