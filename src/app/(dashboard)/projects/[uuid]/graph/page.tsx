// src/app/(dashboard)/projects/[uuid]/graph/page.tsx
// Server Component - project resource graph route shell.
// Mounts the ResourceGraph client component within the project-scoped
// RealtimeProvider supplied by the dashboard layout, so the canvas has
// presence available when the next task wires the highlight in.

import { Suspense } from "react";
import { redirect } from "next/navigation";
import { getServerAuthContext } from "@/lib/auth-server";
import { projectExists } from "@/services/project.service";
import { ResourceGraph } from "./resource-graph";

interface PageProps {
  params: Promise<{ uuid: string }>;
}

export default async function GraphPage({ params }: PageProps) {
  const auth = await getServerAuthContext();
  if (!auth) {
    redirect("/login");
  }

  const { uuid: projectUuid } = await params;

  // Validate project exists within the caller's company.
  const exists = await projectExists(auth.companyUuid, projectUuid);
  if (!exists) {
    redirect("/projects");
  }

  // ResourceGraph reads useSearchParams() (via usePanelUrl) so node clicks
  // can open side panels by syncing the URL. Next 15 requires a Suspense
  // boundary above any useSearchParams() consumer — otherwise the whole
  // route opts into full client-side rendering with a build warning. The
  // fallback fills the same flex cell so the static layout above streams
  // with no jump.
  return (
    <Suspense fallback={<div className="h-full" />}>
      <ResourceGraph
        projectUuid={projectUuid}
        currentUserUuid={auth.actorUuid}
      />
    </Suspense>
  );
}
