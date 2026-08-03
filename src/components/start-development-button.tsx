"use client";

// The human "Start Development" stage-advance button
// (add-stage-advance-start-development). Rendered by BOTH idea-detail panels
// in the same header action slot as Verify Elaborate; all gating goes through
// the shared predicate in src/lib/start-development.ts so the two surfaces
// never drift. Display is optimistic — the server action re-validates every
// precondition (including agent liveness) authoritatively.

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { Loader2, Play } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { useAgentPresenceOptional } from "@/contexts/agent-presence-context";
import {
  canStartDevelopment,
  startDevelopmentPreconditionsMet,
  assigneeOwningAgentUuid,
  type StartDevelopmentAssignee,
} from "@/lib/start-development";
import {
  startDevelopmentAction,
  type StartDevelopmentErrorCode,
} from "@/app/(dashboard)/projects/[uuid]/ideas/[ideaUuid]/stage-advance-actions";
import { reassignIdeaInstanceNoWakeAction } from "@/app/(dashboard)/projects/[uuid]/ideas/[ideaUuid]/actions";
import { usePinThenWake } from "@/hooks/use-pin-then-wake";
import { WakeCwdPickerDialog } from "@/components/agent-presence/wake-cwd-picker-dialog";

interface StartDevelopmentButtonProps {
  ideaUuid: string;
  assignee: StartDevelopmentAssignee | null | undefined;
  // Assignee agent display name — shown in the cwd picker subtitle when the
  // pin-then-wake flow prompts (`pick` outcome). Optional; the panels pass
  // idea.assignee.name.
  assigneeName?: string | null;
  proposals: { status: string }[] | null | undefined;
  tasks: { status: string }[] | null | undefined;
  // Called after a successful start so the panel can refresh its data.
  onStarted?: () => void;
}

// Each server error code maps to its own i18n message — the agent-offline case
// must be distinguishable from a generic failure (spec requirement 5).
const ERROR_CODE_I18N_KEY: Record<StartDevelopmentErrorCode, string> = {
  unauthorized: "errorGeneric",
  not_human: "errorGeneric",
  idea_not_found: "errorGeneric",
  assignee_not_agent: "errorAssigneeNotAgent",
  no_approved_proposal: "errorNoApprovedProposal",
  no_unfinished_tasks: "errorNoUnfinishedTasks",
  agent_offline: "errorAgentOffline",
  instance_offline: "errorInstanceOffline",
  fixed_cwd_host_offline: "errorFixedCwdHostOffline",
  unknown: "errorGeneric",
};

export function StartDevelopmentButton({
  ideaUuid,
  assignee,
  assigneeName,
  proposals,
  tasks,
  onStarted,
}: StartDevelopmentButtonProps) {
  const t = useTranslations("startDevelopment");
  // Optional: a missing provider (isolated render) reads as no presence data →
  // the offline-disabled state, never a crash.
  const connections = useAgentPresenceOptional()?.connections ?? [];
  const [isStarting, setIsStarting] = useState(false);
  const [started, setStarted] = useState(false);
  // Pin-then-wake: before firing the wake, consult the wake-target preview and
  // (pick) prompt for a cwd / (auto_pin) persist the sole cwd / (direct) wake
  // as-is. The picker dialog is mounted below, driven by pickerState.
  // `isResolving` is true while the preview fetch is in flight — the button is
  // disabled through it so a second click can't kick off a duplicate
  // preview→wake before the first resolves.
  const {
    start: startPinThenWake,
    pickerState,
    confirmPick,
    confirmTemporary,
    cancelPick,
    isResolving,
  } = usePinThenWake({
    reassignNoWake: reassignIdeaInstanceNoWakeAction,
    previewIdeaUuid: ideaUuid,
  });

  // The started hint is transient: it clears when the panel moves to another
  // idea, and — because a wake normally flips a task to in_progress quickly —
  // also after a short delay so the button can re-appear for a re-kick if the
  // preconditions still hold (e.g. the woken run ended early).
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

  const preconditionsMet = startDevelopmentPreconditionsMet({
    assignee,
    proposals,
    tasks,
  });
  const enabled = canStartDevelopment({ assignee, proposals, tasks, agentOnline });

  // The button renders only while the stage preconditions hold (approved
  // proposal + unfinished tasks + agent assignee); an offline agent keeps it
  // visible-but-disabled with a hint, matching the optimistic-display contract.
  if (!preconditionsMet || started) {
    return started ? (
      <span className="text-[11px] text-[#00796B] dark:text-[#4FD1C0]">{t("startedHint")}</span>
    ) : null;
  }

  // The actual wake — fired directly on `direct`/`auto_pin`, or after the human
  // picks a cwd on `pick`. The server re-validates every precondition (incl. the
  // HARD instance-offline check → instance_offline error code).
  const runWake = async (temporary?: {
    agentUuid: string;
    validationRequestUuid: string;
  }) => {
    setIsStarting(true);
    const result = temporary
      ? await startDevelopmentAction(ideaUuid, temporary)
      : await startDevelopmentAction(ideaUuid);
    setIsStarting(false);

    if (result.success) {
      setStarted(true);
      toast.success(t("startedHint"));
      onStarted?.();
    } else {
      toast.error(t(ERROR_CODE_I18N_KEY[result.errorCode ?? "unknown"]));
    }
  };

  const handleClick = () => {
    // Route through the pin-then-wake flow: it fetches the preview and either
    // wakes immediately (direct/auto_pin) or opens the picker (pick), then calls
    // runWake once the cwd is resolved.
    startPinThenWake({ ideaUuid, wake: runWake });
  };

  const button = (
    <Button
      className="bg-primary hover:bg-[#B56A42] text-white"
      onClick={handleClick}
      disabled={!enabled || isStarting || isResolving}
    >
      {isStarting ? (
        <>
          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          {t("starting")}
        </>
      ) : (
        <>
          <Play className="mr-2 h-4 w-4" />
          {t("button")}
        </>
      )}
    </Button>
  );

  // Offline: the button is disabled and a disabled <button> emits no pointer
  // events, so the offline explanation rides a tooltip whose trigger is a
  // focusable wrapper span (tabIndex=0) around the button — reachable by both
  // hover and keyboard focus. Online: render the button as-is, no wrapper.
  if (!agentOnline) {
    return (
      <TooltipProvider delayDuration={300}>
        <Tooltip>
          <TooltipTrigger asChild>
            <span tabIndex={0} className="inline-flex">
              {button}
            </span>
          </TooltipTrigger>
          <TooltipContent>{t("offlineHint")}</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    );
  }

  return (
    <>
      {button}
      {/* Pin-then-wake cwd picker — mounted only on the online path (the offline
          path keeps the button disabled, so it never opens). Driven by the hook;
          on confirm it persists the pin then fires runWake. */}
      <WakeCwdPickerDialog
        open={pickerState !== null}
        agentName={assigneeName ?? ""}
        instances={pickerState?.instances ?? []}
        agentUuid={pickerState?.agentUuid}
        onConfirm={confirmPick}
        onTemporaryConfirm={confirmTemporary}
        onCancel={cancelPick}
      />
    </>
  );
}
