"use client";

// "View all" modal — hosts the relocated Agent Connections master-detail view.
//
// Open-state is bound to the provider's `modalOpen` / `setModalOpen` (from
// `useAgentPresence()`), so the sidebar popover's "View all" affordance opens it
// WITHOUT a direct component dependency: the popover only calls `setModalOpen(true)`
// on the shared provider, and this modal — mounted once in the dashboard shell —
// reacts to that flag. There is no `DialogTrigger`; the trigger is the popover
// button elsewhere.
//
// The hosted `AgentConnectionsView` reads its dataset from the same shell-level
// `useAgentPresence()` spine (single poll + single SSE for the whole shell), so
// opening the modal starts no second poll of the connection list. The view
// manages its own internal padding + scroll regions, so the DialogContent drops
// the default padding and gives the body a tall, scrollable frame.

import { useTranslations } from "next-intl";
import { VisuallyHidden } from "radix-ui";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { useAgentPresence } from "@/contexts/agent-presence-context";
import { AgentConnectionsView } from "./connections-view";

export function AgentConnectionsModal() {
  const t = useTranslations("agentConnections");
  const { modalOpen, setModalOpen } = useAgentPresence();

  return (
    <Dialog open={modalOpen} onOpenChange={setModalOpen}>
      <DialogContent
        // Wide, tall, padding-free shell: the view owns its own layout, padding,
        // and the (rare) mobile drill-down. Body scrolls within the dialog so the
        // master-detail panes never push the dialog past the viewport.
        className="flex max-h-[92vh] w-[min(96vw,1100px)] max-w-[min(96vw,1100px)] flex-col gap-0 overflow-hidden p-0 sm:max-w-[min(96vw,1100px)]"
      >
        {/* The view renders its own visible heading + subtitle; this hidden
            title + description satisfy the Radix Dialog accessibility
            requirement (named + described) without a duplicate visible header. */}
        <VisuallyHidden.Root>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("subtitle")}</DialogDescription>
        </VisuallyHidden.Root>
        <div className="min-h-0 flex-1 overflow-y-auto">
          <AgentConnectionsView />
        </div>
      </DialogContent>
    </Dialog>
  );
}
