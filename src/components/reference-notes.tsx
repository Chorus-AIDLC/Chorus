"use client";

// Shared renderer for a reference artifact's `notes` summary text, used by both
// reference-list surfaces (the editable ReferencesSection on idea/proposal/task
// detail panels and the read-only IdeaReferencesContent dashboard card).
//
// Agents sometimes write long, paragraph-length notes; rendered raw they'd
// dominate the card. So the notes are clamped to 2 lines by default, with the
// full text reachable two ways (elaboration q4 = tap-to-toggle):
//   - desktop hover  → a tooltip carrying the full text
//   - tap / click    → expands the notes inline (the touch fallback, since hover
//                      never fires on touch); tapping again collapses
// The clamp is display-only — the stored `notes` value is never altered.
//
// Empty/null notes render nothing and expose no control (preserves the previous
// `{ref.notes && …}` guard at each call site).
//
// Dark-mode: uses only semantic tokens (`text-muted-foreground` on the text,
// and the shared TooltipContent's `bg-foreground text-background`), so it reads
// correctly in both light and dark themes with no fixed-light-only color.

import { useState } from "react";
import { useTranslations } from "next-intl";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface ReferenceNotesProps {
  notes: string | null | undefined;
}

export function ReferenceNotes({ notes }: ReferenceNotesProps) {
  const t = useTranslations();
  const [expanded, setExpanded] = useState(false);

  const text = notes?.trim();
  if (!text) return null;

  // The visible text: a left-aligned button styled to look exactly like the
  // former paragraph, so it stays keyboard-focusable and accessible while
  // reading as body text. Collapsed → clamp to 2 lines; expanded → full text.
  //
  // IMPORTANT: do NOT add `block` to the collapsed variant. `line-clamp-2`
  // relies on `display: -webkit-box`, and Tailwind emits `.block` AFTER
  // `.line-clamp-2` at equal specificity — so a co-present `block` wins the
  // cascade, `display` reverts to `block`, and `-webkit-line-clamp` silently
  // does nothing (the text is no longer height-clamped). The clamp must own
  // `display`. `w-full` still makes the box fill the card width.
  const trigger = (
    <button
      type="button"
      onClick={() => setExpanded((v) => !v)}
      aria-expanded={expanded}
      aria-label={t("references.toggleNotes")}
      className={`mt-1 w-full cursor-pointer text-left text-xs leading-relaxed text-muted-foreground ${
        expanded ? "block" : "line-clamp-2"
      }`}
    >
      {text}
    </button>
  );

  // While expanded the whole text is already visible inline, so the hover
  // tooltip has nothing to add — render the bare trigger. When collapsed, wrap
  // it so desktop hover reveals the full notes.
  if (expanded) return trigger;

  return (
    <TooltipProvider delayDuration={200}>
      <Tooltip>
        <TooltipTrigger asChild>{trigger}</TooltipTrigger>
        <TooltipContent className="max-w-xs whitespace-pre-wrap break-words">
          {text}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}
