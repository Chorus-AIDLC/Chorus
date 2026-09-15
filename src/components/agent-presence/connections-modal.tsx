"use client";

// "View all" modal — hosts the chat-style daemon conversation surface (子3).
//
// Open-state is bound to the provider's `modalOpen` / `setModalOpen` (from
// `useAgentPresence()`), so the sidebar popover's "View all" affordance opens it
// WITHOUT a direct component dependency: the popover only calls `setModalOpen(true)`
// on the shared provider, and this modal — mounted once in the dashboard shell —
// reacts to that flag. There is no `DialogTrigger`; the trigger is the popover
// button elsewhere.
//
// The hosted `DaemonChat` reads its connection dataset from the same shell-level
// `useAgentPresence()` spine (single poll + single SSE for the whole shell) and
// fetches the conversation list / transcript itself, wiring live transcript updates
// through the provider's `setOpenSession` / `subscribeTranscript` API. It owns its
// own layout, padding, and internal scroll regions (the transcript ScrollArea +
// the desktop two-pane), so the DialogContent drops the default padding and gives
// the body a tall, height-constrained frame.

import {
  useCallback,
  useEffect,
  useRef,
  useSyncExternalStore,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useTranslations } from "next-intl";
import { VisuallyHidden } from "radix-ui";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from "@/components/ui/sheet";
import { useAgentPresence } from "@/contexts/agent-presence-context";
import { DaemonChat } from "./chat/daemon-chat";

const MOBILE_QUERY = "(max-width: 639px)";
export const MOBILE_SHEET_TOP_GAP_PX = 16;
export const MOBILE_SHEET_DISMISS_THRESHOLD_PX = 96;

function subscribeToMobileQuery(onChange: () => void) {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const query = window.matchMedia(MOBILE_QUERY);
  query.addEventListener?.("change", onChange);
  return () => query.removeEventListener?.("change", onChange);
}

function getMobileSnapshot() {
  return typeof window !== "undefined" && !!window.matchMedia?.(MOBILE_QUERY).matches;
}

function useIsMobile() {
  return useSyncExternalStore(subscribeToMobileQuery, getMobileSnapshot, () => false);
}

function ChatFrame() {
  return (
    <div
      data-slot="daemon-chat-sheet-body"
      className="flex min-h-0 flex-1 flex-col overflow-hidden"
    >
      <DaemonChat />
    </div>
  );
}

export function AgentConnectionsModal() {
  const t = useTranslations("daemonChat");
  const { modalOpen, setModalOpen } = useAgentPresence();
  const isMobile = useIsMobile();
  const sheetRef = useRef<HTMLDivElement>(null);
  const dragRef = useRef<{ pointerId: number; startY: number } | null>(null);
  const cleanupTimerRef = useRef<number | null>(null);

  const clearDragStyles = useCallback(() => {
    const sheet = sheetRef.current;
    if (!sheet) return;
    sheet.style.transform = "";
    sheet.style.transition = "";
    sheet.style.willChange = "";
  }, []);

  const clearCleanupTimer = useCallback(() => {
    if (cleanupTimerRef.current !== null) {
      window.clearTimeout(cleanupTimerRef.current);
      cleanupTimerRef.current = null;
    }
  }, []);

  useEffect(
    () => () => {
      clearCleanupTimer();
      clearDragStyles();
    },
    [clearCleanupTimer, clearDragStyles],
  );

  const handlePointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!event.isPrimary || event.button !== 0) return;
    clearCleanupTimer();
    clearDragStyles();
    dragRef.current = { pointerId: event.pointerId, startY: event.clientY };
    event.currentTarget.setPointerCapture?.(event.pointerId);
    if (sheetRef.current) {
      sheetRef.current.style.transition = "none";
      sheetRef.current.style.willChange = "transform";
    }
  };

  const handlePointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId || !sheetRef.current) return;
    event.preventDefault();
    const distance = Math.max(0, event.clientY - drag.startY);
    sheetRef.current.style.transform = `translate3d(0, ${distance}px, 0)`;
  };

  const finishHandleDrag = (
    event: ReactPointerEvent<HTMLDivElement>,
    cancelled = false,
  ) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture?.(event.pointerId)) {
      event.currentTarget.releasePointerCapture?.(event.pointerId);
    }

    const distance = Math.max(0, event.clientY - drag.startY);
    if (!cancelled && distance >= MOBILE_SHEET_DISMISS_THRESHOLD_PX) {
      clearDragStyles();
      setModalOpen(false);
      return;
    }

    const sheet = sheetRef.current;
    if (!sheet) return;
    const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
    sheet.style.transition = reduceMotion ? "none" : "transform 180ms ease-out";
    sheet.style.transform = "translate3d(0, 0, 0)";
    cleanupTimerRef.current = window.setTimeout(
      () => {
        clearDragStyles();
        cleanupTimerRef.current = null;
      },
      reduceMotion ? 0 : 200,
    );
  };

  if (isMobile) {
    return (
      <Sheet open={modalOpen} onOpenChange={setModalOpen}>
        <SheetContent
          ref={sheetRef}
          side="bottom"
          data-top-gap-px={MOBILE_SHEET_TOP_GAP_PX}
          className="h-[calc(100dvh-1rem)] max-h-[calc(100dvh-1rem)] gap-0 overflow-hidden rounded-t-2xl border-x border-t p-0 pb-[env(safe-area-inset-bottom)]"
        >
          <VisuallyHidden.Root>
            <SheetTitle>{t("title")}</SheetTitle>
            <SheetDescription>{t("subtitle")}</SheetDescription>
          </VisuallyHidden.Root>
          <div
            data-slot="daemon-chat-sheet-handle"
            className="flex h-11 shrink-0 touch-none cursor-grab items-center justify-center active:cursor-grabbing"
            aria-hidden="true"
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={finishHandleDrag}
            onPointerCancel={(event) => finishHandleDrag(event, true)}
          >
            <div className="h-1 w-10 rounded-full bg-muted-foreground/25" />
          </div>
          <ChatFrame />
        </SheetContent>
      </Sheet>
    );
  }

  return (
    <Dialog open={modalOpen} onOpenChange={setModalOpen}>
      <DialogContent
        // Padding-free shell: the chat view owns its own layout, padding, and the
        // mobile drill-down. The body is height-constrained so the transcript
        // ScrollArea scrolls WITHIN the dialog rather than pushing it past the viewport.
        //
        // This branch only mounts at sm+, preserving the existing floating,
        // height-capped desktop surface and its lg+ two-pane chat layout.
        className="flex h-dvh max-h-dvh w-screen max-w-none flex-col gap-0 overflow-hidden rounded-none border-0 p-0 sm:h-[92vh] sm:max-h-[92vh] sm:w-[min(96vw,1100px)] sm:max-w-[min(96vw,1100px)] sm:rounded-lg sm:border"
      >
        {/* The view renders its own visible heading + subtitle; this hidden
            title + description satisfy the Radix Dialog accessibility
            requirement (named + described) without a duplicate visible header. */}
        <VisuallyHidden.Root>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("subtitle")}</DialogDescription>
        </VisuallyHidden.Root>
        <ChatFrame />
      </DialogContent>
    </Dialog>
  );
}
