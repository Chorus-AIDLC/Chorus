"use client";

// ScrollableDialog — a reusable, mobile-safe dialog skeleton built on the shadcn
// `Dialog` primitive. It solves the recurring "modal taller than the viewport,
// footer buttons unreachable" bug once, in one place, so individual modals don't
// each have to re-derive the flex-column + dynamic-viewport-cap recipe (and don't
// each re-introduce the bug by forgetting `min-h-0`).
//
// Layout contract (the actual fix):
//   - The DialogContent is a FLEX COLUMN capped to `max-h-[85svh]` — a DYNAMIC
//     small-viewport unit that shrinks with the mobile soft keyboard / URL bar,
//     unlike a static `vh` which tracks only the layout viewport (that static unit
//     was the original bug). `overflow-hidden` confines all scrolling to the body.
//   - Header and Footer are `shrink-0` siblings, so they NEVER compress and stay
//     visible + tappable however tall the body content is.
//   - The Body is the ONE scroll region: `min-h-0 flex-1 overflow-y-auto`. The
//     `min-h-0` is REQUIRED — a flex child defaults to `min-height:auto`, which
//     lets it grow past the cap and re-push the footer off-screen (exactly the bug
//     this component exists to prevent).
//   - Width falls back to the shadcn base `max-w-[calc(100%-2rem)]` on narrow
//     viewports; callers pass `sm:max-w-[...]` to set the desktop width.
//
// Stacking: these dialogs are often opened from inside a `fixed z-50` side panel.
// The default Dialog overlay+content are also `z-50`, so the dialog would only sit
// above the panel by PAINT ORDER — a tie some mobile browsers resolve the other
// way, leaving the panel painted over the dialog (title occluded, footer untappable).
// So BOTH the content and the overlay default to `z-[110]` (the same high band the
// @mention picker uses), overridable via `zIndexClassName` for callers that don't
// need the lift.
//
// Open contract: this is a thin controlled wrapper — it forwards `open` /
// `onOpenChange` straight to `Dialog`, so Esc, overlay-click, focus-trap, and the
// shadcn close button all keep working. Callers that mount conditionally (and thus
// have no `open` state) render it with `open` hard-true and map `onOpenChange(false)`
// back to their own `onClose`.

import * as React from "react";

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

export interface ScrollableDialogProps {
  /** Controlled open state — forwarded verbatim to the shadcn `Dialog`. */
  open: boolean;
  /**
   * Open-state change callback — forwarded to `Dialog`. Fires with `false` on
   * every dismissal path (Esc, overlay click, the close button). Conditionally
   * mounted callers map `(o) => { if (!o) onClose(); }`.
   */
  onOpenChange: (open: boolean) => void;
  /** Header slot — typically a `<ScrollableDialogTitle>` (+ optional description). */
  header: React.ReactNode;
  /** Footer slot — typically the action buttons (Cancel / confirm). */
  footer: React.ReactNode;
  /** Body content — the ONLY scroll region; grows/scrolls within the height cap. */
  children: React.ReactNode;
  /** Extra classes on the DialogContent (e.g. `sm:max-w-[400px]` for desktop width). */
  className?: string;
  /** Extra classes on the body scroll region. */
  bodyClassName?: string;
  /**
   * z-index class applied to BOTH the content and the overlay. Defaults to
   * `z-[110]` so the dialog clears a `fixed z-50` side panel by z-index, not paint
   * order. Pass `undefined` to fall back to the shadcn default `z-50`.
   */
  zIndexClassName?: string;
  /** Whether to render the shadcn corner close button. Defaults to true. */
  showCloseButton?: boolean;
}

/**
 * Mobile-safe scrollable dialog: pinned header + scrolling body + pinned footer,
 * capped to the dynamic small-viewport height. See the module header for the full
 * layout + stacking contract.
 */
export function ScrollableDialog({
  open,
  onOpenChange,
  header,
  footer,
  children,
  className,
  bodyClassName,
  zIndexClassName = "z-[110]",
  showCloseButton = true,
}: ScrollableDialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        // Flex column, capped to the dynamic small-viewport height, scroll confined
        // to the body. `gap-0` because the slots own their own spacing/borders.
        className={cn(
          "flex max-h-[85svh] flex-col gap-0 overflow-hidden p-0",
          zIndexClassName,
          className,
        )}
        overlayClassName={zIndexClassName}
        showCloseButton={showCloseButton}
      >
        {/* Pinned header — never compresses, never scrolls away. */}
        <DialogHeader className="shrink-0 border-b border-[#E5E0D8] px-6 py-5 text-left">
          {header}
        </DialogHeader>

        {/* The ONE scroll region. `min-h-0` is what lets this flex child shrink
            below its content height and actually scroll, instead of growing past
            the cap and pushing the footer off-screen. */}
        <div
          className={cn("min-h-0 flex-1 overflow-y-auto px-6 py-4", bodyClassName)}
        >
          {children}
        </div>

        {/* Pinned footer — stays visible + tappable however tall the body is. */}
        <DialogFooter className="shrink-0 border-t border-[#E5E0D8] px-6 py-5">
          {footer}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * Accessible dialog title for the header slot. Re-exported from the shadcn
 * primitive so callers import the whole skeleton from one module. A dialog MUST
 * render one (Radix warns otherwise); wrap it in a visually-hidden span if the
 * design has no visible title.
 */
export const ScrollableDialogTitle = DialogTitle;

/** Optional description line for the header slot (re-exported for convenience). */
export const ScrollableDialogDescription = DialogDescription;
