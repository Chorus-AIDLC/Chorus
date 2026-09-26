"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import type { StageAction } from "@/components/stage-action";
import type { StartDevelopmentAssignee } from "@/lib/start-development";
import { assigneeOwningAgentUuid } from "@/lib/start-development";
import { researchEligibilityAction, researchIdeaAction } from "@/app/(dashboard)/projects/[uuid]/ideas/[ideaUuid]/research-actions";
import { useAgentPresenceOptional } from "@/contexts/agent-presence-context";
import { usePinThenWake } from "@/hooks/use-pin-then-wake";
import { WakeCwdPickerDialog } from "@/components/agent-presence/wake-cwd-picker-dialog";
import { ResearchAgentPicker } from "@/components/research-agent-picker";

export function ResearchAction({ ideaUuid, projectUuid, assignee, disabledReason, refreshKey, onStarted, renderAction, onCloseAutoFocus }: {
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
  const [reason, setReason] = useState<string | undefined>("loading");
  const [busy, setBusy] = useState(false);
  const sending = useRef(false);
  const [revision, setRevision] = useState(0);
  const [choosingAgent, setChoosingAgent] = useState(false);
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
    // Completion of a research turn need not change the Idea. Refresh on focus
    // and periodically so a later explicit request becomes available.
    window.addEventListener("focus", refresh);
    const timer = setInterval(refresh, 15_000);
    return () => { current = false; clearInterval(timer); window.removeEventListener("focus", refresh); };
  }, [ideaUuid, assignee?.uuid, refreshKey, revision]);

  const runWake = async (temporary?: { agentUuid: string; validationRequestUuid: string }, allowPicker = true) => {
    if (sending.current) return;
    sending.current = true;
    setBusy(true);
    try {
      const result = temporary || selection.current
        ? await researchIdeaAction(ideaUuid, temporary, selection.current)
        : await researchIdeaAction(ideaUuid);
      if (result.success) {
        setReason("already_running");
        toast.success(t("dispatched"));
        presence?.openChatForSession(result.session);
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
          if (result.errorCode === "assignment_required" && !assigneeOwningAgentUuid(assignee)) setChoosingAgent(true);
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
    if (disabledReason || reason || sending.current || isResolving) return;
    selection.current = undefined;
    if (!assigneeOwningAgentUuid(assignee)) {
      setChoosingAgent(true);
    } else void runWake();
  };
  return <>
    {renderAction({
      label: t("button"), busy: busy || isResolving || choosingAgent,
      disabledReason: disabledReason || (busy || isResolving || choosingAgent ? t("dispatching") : reason ? t(reason) : undefined),
      onSelect,
    })}
    <WakeCwdPickerDialog
      open={pickerState !== null} onCloseAutoFocus={onCloseAutoFocus}
      agentName="" instances={pickerState?.instances ?? []} agentUuid={pickerState?.agentUuid}
      onConfirm={confirmPick} onTemporaryConfirm={confirmTemporary} onCancel={cancelPick}
    />
    {choosingAgent && <ResearchAgentPicker
      projectUuid={projectUuid} onCloseAutoFocus={onCloseAutoFocus}
      onCancel={() => setChoosingAgent(false)}
      onConfirm={(target) => {
        selection.current = target;
        setChoosingAgent(false);
        void runWake(undefined, false);
      }}
    />}
  </>;
}
