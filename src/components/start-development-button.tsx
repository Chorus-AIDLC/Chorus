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

interface StartDevelopmentButtonProps {
  ideaUuid: string;
  assignee: StartDevelopmentAssignee | null | undefined;
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
  unknown: "errorGeneric",
};

export function StartDevelopmentButton({
  ideaUuid,
  assignee,
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

  const handleClick = async () => {
    setIsStarting(true);
    const result = await startDevelopmentAction(ideaUuid);
    setIsStarting(false);

    if (result.success) {
      setStarted(true);
      toast.success(t("startedHint"));
      onStarted?.();
    } else {
      toast.error(t(ERROR_CODE_I18N_KEY[result.errorCode ?? "unknown"]));
    }
  };

  const button = (
    <Button
      className="bg-primary hover:bg-[#B56A42] text-white"
      onClick={handleClick}
      disabled={!enabled || isStarting}
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

  return button;
}
