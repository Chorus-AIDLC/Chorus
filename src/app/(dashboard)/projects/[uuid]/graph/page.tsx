// src/app/(dashboard)/projects/[uuid]/graph/page.tsx
// Server Component - project resource graph route shell.
// Mounts the ResourceGraph client component within the project-scoped
// RealtimeProvider supplied by the dashboard layout, so the canvas has
// presence available when the next task wires the highlight in.

import { Suspense } from "react";
import { requireProjectPageAccess } from "../access-guard";
import { ResourceGraph } from "./resource-graph";

interface PageProps {
  params: Promise<{ uuid: string }>;
}

export default async function GraphPage({ params }: PageProps) {
  const { uuid: projectUuid } = await params;

  // Access gate: unauthenticated → /login, no project access → 404
  const { auth } = await requireProjectPageAccess(projectUuid);

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
