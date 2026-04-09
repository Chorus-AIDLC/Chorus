import { redirect } from "next/navigation";

interface PageProps {
  params: Promise<{ uuid: string; ideaUuid: string }>;
  searchParams: Promise<{ tab?: string }>;
}

// Redirect path-based deep links to query-param format for consistency
export default async function DashboardIdeaRedirect({ params, searchParams }: PageProps) {
  const { uuid, ideaUuid } = await params;
  const { tab } = await searchParams;
  const tabParam = tab ? `&tab=${tab}` : "";
  redirect(`/projects/${uuid}/dashboard?panel=${ideaUuid}${tabParam}`);
}
