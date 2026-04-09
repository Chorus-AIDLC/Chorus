import { redirect } from "next/navigation";
import { getServerAuthContext } from "@/lib/auth-server";
import { getProject, getProjectStats } from "@/services/project.service";
import { getTrackerGroups } from "@/services/idea.service";
import { listActivitiesWithActorNames } from "@/services/activity.service";

export async function getDashboardData(projectUuid: string) {
  const auth = await getServerAuthContext();
  if (!auth) {
    redirect("/login");
  }

  const project = await getProject(auth.companyUuid, projectUuid);
  if (!project) {
    redirect("/projects");
  }

  const [trackerData, stats, { activities }] = await Promise.all([
    getTrackerGroups(auth.companyUuid, projectUuid),
    getProjectStats(auth.companyUuid, projectUuid),
    listActivitiesWithActorNames({
      companyUuid: auth.companyUuid,
      projectUuid,
      skip: 0,
      take: 5,
    }),
  ]);

  return {
    project,
    trackerData,
    stats,
    activities,
    currentUserUuid: auth.actorUuid,
  };
}
