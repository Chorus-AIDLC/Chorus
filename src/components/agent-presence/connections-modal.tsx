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

import { useTranslations } from "next-intl";
import { VisuallyHidden } from "radix-ui";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { useAgentPresence } from "@/contexts/agent-presence-context";
import { DaemonChat } from "./chat/daemon-chat";

export function AgentConnectionsModal() {
  const t = useTranslations("daemonChat");
  const { modalOpen, setModalOpen } = useAgentPresence();

  return (
    <Dialog open={modalOpen} onOpenChange={setModalOpen}>
      <DialogContent
        // Padding-free shell: the chat view owns its own layout, padding, and the
        // mobile drill-down. The body is height-constrained so the transcript
        // ScrollArea scrolls WITHIN the dialog rather than pushing it past the viewport.
        //
        // MOBILE (< sm): the modal fills the screen edge-to-edge (`h-dvh w-screen`,
        // no rounding/border) so the conversation reads like a native chat screen —
        // the transcript fills the middle and the reply input sits at the very bottom
        // of the viewport. `dvh` (not `vh`) so the mobile URL bar can't push the input
        // off-screen. DESKTOP (sm+): the floating, height-capped card is restored.
        className="flex h-dvh max-h-dvh w-screen max-w-none flex-col gap-0 overflow-hidden rounded-none border-0 p-0 sm:h-[92vh] sm:max-h-[92vh] sm:w-[min(96vw,1100px)] sm:max-w-[min(96vw,1100px)] sm:rounded-lg sm:border"
      >
        {/* The view renders its own visible heading + subtitle; this hidden
            title + description satisfy the Radix Dialog accessibility
            requirement (named + described) without a duplicate visible header. */}
        <VisuallyHidden.Root>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("subtitle")}</DialogDescription>
        </VisuallyHidden.Root>
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <DaemonChat />
        </div>
      </DialogContent>
    </Dialog>
  );
}
