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

  const project = await getProject(auth.companyUuid, projectUuid, auth);
  if (!project) {
    redirect("/projects");
  }

  const trackerData = await getTrackerGroups(auth.companyUuid, projectUuid, auth);
  const stats = await getProjectStats(auth.companyUuid, projectUuid, auth);
  if (!stats) {
    redirect("/projects");
  }
  const { activities } = await listActivitiesWithActorNames({
    companyUuid: auth.companyUuid,
    projectUuid,
    skip: 0,
    take: 5,
  });

  return {
    project,
    trackerData,
    stats,
    activities,
    currentUserUuid: auth.actorUuid,
  };
}
