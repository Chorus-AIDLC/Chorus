"use client";

// Subtle read-only hint shown at the top of every project page for Viewers.
// Reads the level from ProjectAccessProvider; renders nothing for editors /
// admins (and when no provider is mounted, which defaults to "editor").
// Theming: semantic tokens only (secondary / border / muted-foreground) so it
// adapts to light + dark with no hardcoded hex.

import { Eye } from "lucide-react";
import { useTranslations } from "next-intl";
import { useProjectAccessLevel } from "@/contexts/project-access-context";

export function ProjectReadOnlyBanner() {
  const t = useTranslations();
  const level = useProjectAccessLevel();
  if (level !== "viewer") return null;

  return (
    <div
      role="status"
      data-testid="project-read-only-banner"
      className="flex shrink-0 items-center gap-2 border-b border-border bg-secondary px-4 py-2 text-xs text-muted-foreground md:px-8"
    >
      <Eye className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span>{t("projectAccess.viewerBanner")}</span>
    </div>
  );
}
