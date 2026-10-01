import { DashboardContent } from "./dashboard-content";
import { requireProjectPageAccess, canViewEntityInProject } from "../access-guard";

interface PageProps {
  params: Promise<{ uuid: string }>;
  searchParams: Promise<{ panel?: string }>;
}

export default async function DashboardPage({ params, searchParams }: PageProps) {
  const { uuid: projectUuid } = await params;
  const { panel } = await searchParams;

  // Only preselect an idea that belongs to this project and is visible to the caller;
  // otherwise drop the selection (the dashboard itself stays reachable).
  let initialSelectedIdeaUuid: string | undefined;
  if (panel) {
    const { auth } = await requireProjectPageAccess(projectUuid);
    if (await canViewEntityInProject(auth, "idea", panel, projectUuid)) {
      initialSelectedIdeaUuid = panel;
    }
  }

  return <DashboardContent projectUuid={projectUuid} initialSelectedIdeaUuid={initialSelectedIdeaUuid} />;
}
