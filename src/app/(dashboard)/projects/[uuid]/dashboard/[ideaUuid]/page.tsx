import { redirect } from "next/navigation";
import { requireProjectPageAccess, requireEntityInProject } from "../../access-guard";

interface PageProps {
  params: Promise<{ uuid: string; ideaUuid: string }>;
  searchParams: Promise<{ tab?: string }>;
}

// Redirect path-based deep links to query-param format for consistency
export default async function DashboardIdeaRedirect({ params, searchParams }: PageProps) {
  const { uuid, ideaUuid } = await params;
  const { tab } = await searchParams;

  // The idea must belong to this project and be visible to the caller → else 404
  const { auth } = await requireProjectPageAccess(uuid);
  await requireEntityInProject(auth, "idea", ideaUuid, uuid);

  const tabParam = tab ? `&tab=${tab}` : "";
  redirect(`/projects/${uuid}/dashboard?panel=${ideaUuid}${tabParam}`);
}
