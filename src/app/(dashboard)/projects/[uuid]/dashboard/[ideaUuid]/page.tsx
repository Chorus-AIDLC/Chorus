import { DashboardContent } from "../dashboard-content";

interface PageProps {
  params: Promise<{ uuid: string; ideaUuid: string }>;
}

export default async function DashboardIdeaPage({ params }: PageProps) {
  const { uuid: projectUuid, ideaUuid } = await params;
  return <DashboardContent projectUuid={projectUuid} initialSelectedIdeaUuid={ideaUuid} />;
}
