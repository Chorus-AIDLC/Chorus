// src/app/(dashboard)/projects/[uuid]/observability/page.tsx
// Server Component — agent observability dashboard.

import { redirect } from "next/navigation";
import { getServerAuthContext } from "@/lib/auth-server";
import { projectExists } from "@/services/project.service";
import { getAgentObservability } from "@/services/observability.service";
import { AgentObservability } from "./agent-observability";

interface PageProps {
  params: Promise<{ uuid: string }>;
}

export default async function ObservabilityPage({ params }: PageProps) {
  const auth = await getServerAuthContext();
  if (!auth) {
    redirect("/login");
  }

  const { uuid: projectUuid } = await params;

  const exists = await projectExists(auth.companyUuid, projectUuid);
  if (!exists) {
    redirect("/projects");
  }

  const initialData = await getAgentObservability(auth.companyUuid, projectUuid, 7);

  return (
    <AgentObservability
      projectUuid={projectUuid}
      initialData={initialData}
    />
  );
}
