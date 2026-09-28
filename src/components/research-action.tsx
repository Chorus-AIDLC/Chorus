"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import type { StageAction } from "@/components/stage-action";
import type { StartDevelopmentAssignee } from "@/lib/start-development";
import { assigneeOwningAgentUuid } from "@/lib/start-development";
import { researchEligibilityAction, researchIdeaAction } from "@/app/(dashboard)/projects/[uuid]/ideas/[ideaUuid]/research-actions";
import { usePinThenWake } from "@/hooks/use-pin-then-wake";
import { WakeCwdPickerDialog } from "@/components/agent-presence/wake-cwd-picker-dialog";
import { useAgentPresenceOptional } from "@/contexts/agent-presence-context";

export function ResearchAction({ ideaUuid, assignee, disabledReason, refreshKey, onStarted, renderAction, onCloseAutoFocus }: {
  ideaUuid: string;
  projectUuid: string;
  assignee: StartDevelopmentAssignee | null | undefined;
  disabledReason?: string;
  refreshKey: string;
  onStarted: () => void;
  renderAction: (action: StageAction) => ReactNode;
  onCloseAutoFocus?: (event: Event) => void;
}) {
  const t = useTranslations("research");
  const presence = useAgentPresenceOptional();
  const owningAgentUuid = assigneeOwningAgentUuid(assignee);
  // Match YOLO's agent-level presence gate; exact origin/cwd checks stay server-side.
  const agentOnline = owningAgentUuid !== null && (presence?.connections ?? []).some(
    (connection) => connection.agentUuid === owningAgentUuid && connection.effectiveStatus === "online",
  );
  const [reason, setReason] = useState<string | undefined>("loading");
  const [busy, setBusy] = useState(false);
  const sending = useRef(false);
  const [revision, setRevision] = useState(0);
  const selection = useRef<{ agentUuid: string; instanceUuid?: string } | undefined>(undefined);
  // Reuse the picker flow while deferring assignment to the atomic Research dispatch.
  // Generic assignIdea, including its "no wake" variant, advances open -> elaborating.
  const captureSelection = useCallback(async (_idea: string, agentUuid: string, instanceUuid: string) => {
    selection.current = { agentUuid, instanceUuid };
    return { success: true };
  }, []);
  const { start, pickerState, confirmPick, confirmTemporary, cancelPick, isResolving } = usePinThenWake({
    reassignNoWake: captureSelection, previewIdeaUuid: ideaUuid,
  });
  useEffect(() => {
    let current = true;
    setReason("loading");
    const refresh = () => {
      void researchEligibilityAction(ideaUuid).then((result) => {
        if (current) setReason(result.eligible ? undefined : result.reason);
      }).catch(() => { if (current) setReason("unknown"); });
    };
    refresh();
    // Keep the development boundary fresh even while the menu is open.
    window.addEventListener("focus", refresh);
    const timer = setInterval(refresh, 15_000);
    return () => { current = false; clearInterval(timer); window.removeEventListener("focus", refresh); };
  }, [ideaUuid, assignee?.uuid, owningAgentUuid, refreshKey, revision]);

  const actionReason = disabledReason || (busy || isResolving ? t("dispatching")
    : !owningAgentUuid ? t("assignmentHint")
    : !agentOnline ? t("offlineHint")
    : reason ? t(reason) : undefined);

  const runWake = async (temporary?: { agentUuid: string; validationRequestUuid: string }, allowPicker = true) => {
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    try {
      const result = temporary || selection.current
        ? await researchIdeaAction(ideaUuid, temporary, selection.current)
        : await researchIdeaAction(ideaUuid);
      if (result.success) {
        setReason(undefined);
        toast.success(t("dispatched"));
        selection.current = undefined;
        onStarted();
      } else {
        if (allowPicker && result.errorCode === "assignment_required" && assigneeOwningAgentUuid(assignee)) {
          // Existing roots already have authority and never come here. Only an
          // unconfigured new root with ambiguous cwd needs pin-then-wake.
          sending.current = false;
          void start({ ideaUuid, wake: (target) => runWake(target, false) });
        } else {
          toast.error(t(result.errorCode));
        }
        setRevision((value) => value + 1);
      }
    } catch {
      toast.error(t("unknown"));
    } finally {
      sending.current = false;
      setBusy(false);
    }
  };
  const onSelect = () => {
    if (actionReason || sending.current) return;
    selection.current = undefined;
    void runWake();
  };
  return <>
    {renderAction({
      label: t("button"), busy: busy || isResolving,
      disabledReason: actionReason,
      onSelect,
    })}
    <WakeCwdPickerDialog
      open={pickerState !== null} onCloseAutoFocus={onCloseAutoFocus}
      agentName="" instances={pickerState?.instances ?? []} agentUuid={pickerState?.agentUuid}
      onConfirm={confirmPick} onTemporaryConfirm={confirmTemporary} onCancel={cancelPick}
    />
  </>;
}
