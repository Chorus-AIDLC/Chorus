// src/app/(dashboard)/projects/[uuid]/graph/page.tsx
// Server Component - project resource graph route shell.
// The canvas itself (force-directed knowledge graph) lands in a sibling task;
// this page wires the route + page chrome + empty-state placeholder. The page
// mounts within the project-scoped RealtimeProvider via the dashboard layout
// so presence is available to the canvas once it arrives.

import { redirect } from "next/navigation";
import { getServerAuthContext } from "@/lib/auth-server";
import { projectExists } from "@/services/project.service";
import { ResourceGraphPlaceholder } from "./resource-graph-placeholder";

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

  return <ResourceGraphPlaceholder projectUuid={projectUuid} />;
}
