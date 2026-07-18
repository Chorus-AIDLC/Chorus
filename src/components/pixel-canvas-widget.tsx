"use client";

import { useState, useCallback, useEffect } from "react";
import { useTranslations } from "next-intl";
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import {
  PixelCanvas,
  type SlotData,
  type SlotState,
  type PixelCanvasEffect,
} from "@/components/pixel-canvas";
import { getProjectActiveSessionsAction } from "@/app/(dashboard)/projects/[uuid]/actions";
import { useRealtimeEvent } from "@/contexts/realtime-context";
import { usePixelActivity } from "@/contexts/pixel-activity-context";

interface PixelCanvasWidgetProps {
  projectUuid: string;
  projectName: string;
}

// Project-scoped pixel-canvas "activity" view. It no longer renders its own
// standalone bottom-right button — the single bottom-right affordance is now the
// DaemonPresenceEntry (mounted at the shell). Instead this component:
//   1. keeps the project-scoped active-sessions fetch + realtime refresh, and
//   2. is a CONTROLLED Dialog whose open-state comes from the shell-level
//      PixelActivityContext bridge (so the entry's "View activity" action opens
//      it), and
//   3. registers `available = true` while mounted so the entry knows a project
//      context is active and can SHOW the "View activity" affordance (absent on
//      global pages where this component is not mounted).
// It is mounted only inside the project branch of the dashboard layout (where a
// RealtimeProvider + projectUuid exist), per the pixel-view availability contract.
export function PixelCanvasWidget({ projectUuid, projectName }: PixelCanvasWidgetProps) {
  const t = useTranslations("pixelCanvas");
  const { open, setOpen, setAvailable } = usePixelActivity();
  const [slots, setSlots] = useState<SlotData[]>(
    Array.from({ length: 7 }, () => ({ state: "empty" as SlotState }))
  );
  const [agentCount, setAgentCount] = useState(0);
  const [effects, setEffects] = useState<PixelCanvasEffect[]>([]);

  // Announce to the shell-level bridge that a project-scoped pixel view is
  // mountable while this component lives; clear it on unmount (navigating away
  // from the project) so the entry's "View activity" affordance disappears
  // rather than opening an empty/stale view. Also close the view on unmount so a
  // lingering `open=true` can't reopen it on the next project.
  useEffect(() => {
    setAvailable(true);
    return () => {
      setAvailable(false);
      setOpen(false);
    };
  }, [setAvailable, setOpen]);

  const fetchSessions = useCallback(async () => {
    const result = await getProjectActiveSessionsAction(projectUuid);
    if (!result.success || !result.data) return;

    const sessions = result.data;
    const newSlots: SlotData[] = Array.from({ length: 7 }, (_, i) => {
      const session = sessions[i];
      if (!session) return { state: "empty" as SlotState };
      return {
        state: "typing" as SlotState,
        sessionName: session.sessionName,
      };
    });

    setSlots(newSlots);
    setAgentCount(sessions.length);
  }, [projectUuid]);

  // Initial fetch + SSE-driven refresh via context
  useRealtimeEvent(fetchSessions);

  const handleEffectsConsumed = useCallback(() => {
    setEffects([]);
  }, []);

  // Controlled Dialog only — the trigger is the DaemonPresenceEntry's
  // "View activity" action (via the PixelActivityContext bridge).
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent className="sm:max-w-2xl p-4">
        <DialogTitle className="text-sm">
          {projectName} — {t("title")}
        </DialogTitle>
        <DialogDescription className="sr-only">
          {t("title")}
        </DialogDescription>
        <div className="overflow-hidden rounded-lg border border-border">
          <PixelCanvas
            slots={slots}
            projectName={projectName}
            agentCount={agentCount}
            collapsed={!open}
            effects={effects}
            onEffectsConsumed={handleEffectsConsumed}
          />
        </div>
      </DialogContent>
    </Dialog>
  );
}
