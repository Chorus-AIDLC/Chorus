// src/app/(dashboard)/projects/[uuid]/graph/page.tsx
// Server Component - project resource graph route shell.
// Mounts the ResourceGraph client component within the project-scoped
// RealtimeProvider supplied by the dashboard layout, so the canvas has
// presence available when the next task wires the highlight in.

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

  return <ResourceGraph projectUuid={projectUuid} />;
}
