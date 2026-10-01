"use client";

// Private-project indicator: a compact glyph by default, or a visible badge
// for listings and the overview. Public projects render nothing.

import { Lock } from "lucide-react";
import { useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";
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
  showLabel?: boolean;
}

export function ProjectLockIndicator({
  visibility,
  iconClassName = "h-3 w-3",
  className,
  showLabel = false,
}: ProjectLockIndicatorProps) {
  const t = useTranslations();
  if (visibility !== "private") return null;

  const label = t("projectAccess.privateBadge");
  const indicator = (
    <span
      data-testid="project-lock-indicator"
      className={cn("inline-flex shrink-0 items-center text-muted-foreground", className)}
    >
      <Lock className={iconClassName} aria-hidden="true" />
      <span className={showLabel ? undefined : "sr-only"}>{label}</span>
    </span>
  );
  return (
    <TooltipProvider delayDuration={300}>
      <Tooltip>
        <TooltipTrigger asChild>
          {showLabel ? (
            <Badge asChild variant="outline" className="bg-muted/50">
              {indicator}
            </Badge>
          ) : indicator}
        </TooltipTrigger>
        <TooltipContent>{t("projectAccess.privateTooltip")}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
