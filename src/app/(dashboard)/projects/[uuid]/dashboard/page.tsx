import { DashboardContent } from "./dashboard-content";

interface PageProps {
  params: Promise<{ uuid: string }>;
  searchParams: Promise<{ panel?: string }>;
}

export default async function DashboardPage({ params, searchParams }: PageProps) {
  const { uuid: projectUuid } = await params;
  const { panel } = await searchParams;
  return <DashboardContent projectUuid={projectUuid} initialSelectedIdeaUuid={panel} />;
}
