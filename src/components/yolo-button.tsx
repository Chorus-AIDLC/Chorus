"use client";

// The human "Yolo" stage-advance button (add-stage-advance-yolo). Rendered by
// BOTH idea-detail panels in the same header action slot as Start Development;
// all gating goes through the shared predicate in src/lib/yolo-request.ts so the
// two surfaces never drift. Display is optimistic — the server action
// re-validates every precondition (including agent liveness) authoritatively.
//
// Difference from StartDevelopmentButton: clicking opens an AlertDialog confirm
// step (elaboration decision Q5 — a full-auto run is high-cost to mis-trigger),
// and the render gate is the relaxed "any incomplete stage" predicate rather
// than the approved-proposal + unfinished-task gate.

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Loader2, Rocket } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { useAgentPresenceOptional } from "@/contexts/agent-presence-context";
import {
  canRequestYolo,
  yoloPreconditionsMet,
  assigneeOwningAgentUuid,
  type YoloAssignee,
} from "@/lib/yolo-request";
import {
  yoloRequestedAction,
  type YoloRequestedErrorCode,
} from "@/app/(dashboard)/projects/[uuid]/ideas/[ideaUuid]/stage-advance-actions";

interface YoloButtonProps {
  ideaUuid: string;
  assignee: YoloAssignee | null | undefined;
  proposals: { status: string }[] | null | undefined;
  tasks: { status: string }[] | null | undefined;
  // Called after a successful request so the panel can refresh its data.
  onStarted?: () => void;
}

// Each server error code maps to its own i18n message — the agent-offline case
// must be distinguishable from a generic failure.
const ERROR_CODE_I18N_KEY: Record<YoloRequestedErrorCode, string> = {
  unauthorized: "errorGeneric",
  not_human: "errorGeneric",
  idea_not_found: "errorGeneric",
  assignee_not_agent: "errorAssigneeNotAgent",
  agent_offline: "errorAgentOffline",
  unknown: "errorGeneric",
};

export function YoloButton({
  ideaUuid,
  assignee,
  proposals,
  tasks,
  onStarted,
}: YoloButtonProps) {
  const t = useTranslations("yolo");
  // Optional: a missing provider (isolated render) reads as no presence data →
  // the offline-disabled state, never a crash.
  const connections = useAgentPresenceOptional()?.connections ?? [];
  const [isStarting, setIsStarting] = useState(false);
  const [started, setStarted] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);

  // The started hint is transient: it clears when the panel moves to another
  // idea, and — because a wake normally flips the idea into motion quickly —
  // also after a short delay so the button can re-appear for a re-kick if the
  // preconditions still hold.
  useEffect(() => {
    setStarted(false);
  }, [ideaUuid]);
  useEffect(() => {
    if (!started) return;
    const timer = setTimeout(() => setStarted(false), 30_000);
    return () => clearTimeout(timer);
  }, [started]);

  // Any effectively-online connection of the assignee's owning agent qualifies —
  // the server's session-origin upgrade picks the right cwd, not the client.
  const owningAgentUuid = assigneeOwningAgentUuid(assignee);
  const agentOnline =
    owningAgentUuid !== null &&
    connections.some(
      (c) => c.agentUuid === owningAgentUuid && c.effectiveStatus === "online"
    );

  const preconditionsMet = yoloPreconditionsMet({ assignee, proposals, tasks });
  const enabled = canRequestYolo({ assignee, proposals, tasks, agentOnline });

  // The button renders only while the stage preconditions hold (agent assignee +
  // not-done idea); an offline agent keeps it visible-but-disabled with a hint,
  // matching the optimistic-display contract.
  if (!preconditionsMet || started) {
    return started ? (
      <span className="text-[11px] text-[#00796B]">{t("startedHint")}</span>
    ) : null;
  }

  const handleConfirm = async () => {
    setIsStarting(true);
    const result = await yoloRequestedAction(ideaUuid);
    setIsStarting(false);
    setDialogOpen(false);

    if (result.success) {
      setStarted(true);
      toast.success(t("startedHint"));
      onStarted?.();
    } else {
      toast.error(t(ERROR_CODE_I18N_KEY[result.errorCode ?? "unknown"]));
    }
  };

  return (
    <>
      <AlertDialog open={dialogOpen} onOpenChange={setDialogOpen}>
        {/* Icon + label: the footer now has room (the standalone reassign button
            moved onto the assignee block), so Yolo reads as a full text button
            like Start Development rather than an icon-only shortcut. */}
        <AlertDialogTrigger asChild>
          <Button
            className="bg-[#7F5AF0] hover:bg-[#6D48DE] text-white"
            disabled={!enabled}
          >
            <Rocket className="mr-2 h-4 w-4" />
            {t("button")}
          </Button>
        </AlertDialogTrigger>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("confirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>{t("confirmDescription")}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isStarting}>
              {t("cancel")}
            </AlertDialogCancel>
            {/* Not AlertDialogAction: we keep the dialog open during the async
                call and close it ourselves in handleConfirm, so the spinner is
                visible and a failure toast surfaces without a flash-close. */}
            <Button
              className="bg-[#7F5AF0] hover:bg-[#6D48DE] text-white"
              onClick={handleConfirm}
              disabled={isStarting}
            >
              {isStarting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {t("starting")}
                </>
              ) : (
                t("confirmCta")
              )}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      {!agentOnline && (
        <span className="text-[11px] text-[#9A9A9A]">{t("offlineHint")}</span>
      )}
    </>
  );
}
