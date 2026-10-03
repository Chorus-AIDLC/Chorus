// src/app/(dashboard)/projects/[uuid]/layout.tsx
// Server Component — project access gate for every /projects/[uuid]/** page.
// Unauthenticated → /login; no access (missing, other company, private non-member) → 404.
// The sidebar/nav lives in the parent (dashboard) layout; this renders children unchanged.
//
// It also provides the caller's access level to client components below via
// ProjectAccessProvider (UX only — the server enforces writes). Viewers get a
// read-only hint banner above the page; editors/admins see the page unchanged.

import type { ReactNode } from "react";
import { requireProjectPageAccess } from "./access-guard";
import { ProjectAccessProvider } from "@/contexts/project-access-context";
import { ProjectReadOnlyBanner } from "@/components/project-read-only-banner";

interface ProjectLayoutProps {
  children: ReactNode;
  params: Promise<{ uuid: string }>;
}

export default async function ProjectLayout({ children, params }: ProjectLayoutProps) {
  const { uuid: projectUuid } = await params;
  const { accessLevel } = await requireProjectPageAccess(projectUuid);

  if (accessLevel !== "viewer") {
    return <ProjectAccessProvider accessLevel={accessLevel}>{children}</ProjectAccessProvider>;
  }

  // Viewer: banner + page in a flex column so full-height pages (h-full) keep
  // filling the remaining space instead of overflowing by the banner height.
  return (
    <ProjectAccessProvider accessLevel={accessLevel}>
      <div className="flex min-h-0 flex-1 flex-col">
        <ProjectReadOnlyBanner />
        <div className="flex min-h-0 flex-1 flex-col">{children}</div>
      </div>
    </ProjectAccessProvider>
  );
}
