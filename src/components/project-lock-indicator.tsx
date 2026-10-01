"use client";

// Small lock glyph marking a private project. Shared by the /projects list,
// the project-group dashboard, and the sidebar quick-access rows so the three
// surfaces stay visually identical. Renders nothing for public projects (or
// when visibility is unknown), so public rows are unchanged.
//
// Accessibility: the icon itself is aria-hidden; an sr-only label carries the
// meaning for screen readers, and a tooltip explains it on hover/focus.
// Theming: muted-foreground token only — adapts to light + dark for free.

import { Lock } from "lucide-react";
import { useTranslations } from "next-intl";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

interface ProjectLockIndicatorProps {
  visibility?: string | null;
  /** Icon size classes; defaults to a 12px glyph. */
  iconClassName?: string;
  className?: string;
}

export function ProjectLockIndicator({
  visibility,
  iconClassName = "h-3 w-3",
  className,
}: ProjectLockIndicatorProps) {
  const t = useTranslations();
  if (visibility !== "private") return null;

  const label = t("projectAccess.privateBadge");
  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            data-testid="project-lock-indicator"
            className={cn(
              "inline-flex shrink-0 items-center text-muted-foreground",
              className,
            )}
          >
            <Lock className={iconClassName} aria-hidden="true" />
            <span className="sr-only">{label}</span>
          </span>
        </TooltipTrigger>
        <TooltipContent>{t("projectAccess.privateTooltip")}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
