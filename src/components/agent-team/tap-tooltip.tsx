"use client";

import { useState, type ReactElement, type ReactNode } from "react";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";

// Radix tooltips open on hover/focus only; touch users never see them.
// Tapping the trigger opens the tooltip so the hint is reachable on mobile.
export function TapTooltip({ content, children }: { content: ReactNode; children: ReactElement }) {
  const [open, setOpen] = useState(false);
  return (
    <TooltipProvider>
      <Tooltip open={open} onOpenChange={setOpen}>
        <TooltipTrigger asChild onClick={(event) => { event.preventDefault(); setOpen(true); }}>
          {children}
        </TooltipTrigger>
        <TooltipContent className="z-[130] max-w-72">{content}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
