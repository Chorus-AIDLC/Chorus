"use client";

// The pin-then-wake click orchestration (pin-cwd-before-wake, D5).
//
// Every wake-triggering button — Verify Elaborate, Start Development, Yolo,
// Proposal approve, Proposal reject — shares ONE click flow: before firing the
// wake, consult the server-owned wake-target preview and branch on its outcome.
//
//   pick     → open the cwd picker; on the human's choice, reassign-no-wake to
//              PERSIST the chosen instance, THEN fire the wake.
//   auto_pin → without prompting, reassign-no-wake the single online instance,
//              THEN fire the wake.
//   direct   → fire the wake immediately (no picker, no reassign).
//
// This hook centralizes that branch so the five surfaces never drift. Each
// caller supplies (a) the target idea uuid, (b) a `wake` callback that runs the
// surface's own server action, and (c) whether that action's confirm step (Yolo)
// is already handled by the caller. The picker dialog UI is a separate,
// prop-driven component (`WakeCwdPickerDialog`) that the caller mounts, driven by
// this hook's `pickerState`.
//
// MIDDLE-STATE (D2): if the wake fails AFTER a successful reassign (pick /
// auto_pin), the pin is NOT rolled back — the idea is left correctly pinned and
// the caller simply retries the wake. A pinned-but-not-woken idea is a valid
// resting state.
//
// The reassign step is BEST-EFFORT because the selected instance can disappear
// or fail validation between preview and submission. A failed pin never blocks
// the wake; the server falls back to its own wake-target resolution.

import { useCallback, useEffect, useState } from "react";
import { clientLogger } from "@/lib/logger-client";
import {
  filterOnlineInstances,
  type InstanceCandidate,
} from "@/components/agent-presence/instance-picker";
import type { ResolvedProjectAgentCwdTarget } from "@/services/project-agent-cwd.service";

/** The three pre-wake outcomes returned by GET /api/ideas/[uuid]/wake-preview. */
export type WakeTargetOutcome = "pick" | "auto_pin" | "direct";

/** The preview payload shape (mirrors WakeTargetPreview from the service). */
export interface WakeTargetPreview {
  outcome: WakeTargetOutcome;
  assigneeAgentUuid: string | null;
  onlineInstances: InstanceCandidate[];
  resolvedTarget?: ResolvedProjectAgentCwdTarget;
}

/**
 * The non-waking reassign server action, injected by the caller. Idea and Task
 * surfaces pass their own (`reassignIdeaInstanceNoWakeAction` /
 * `reassignTaskInstanceNoWakeAction`) — this hook stays entity-agnostic. Returns
 * the standard `{ success, error? }` server-action result.
 */
export type ReassignNoWakeAction = (
  ideaUuid: string,
  agentUuid: string,
  instanceUuid: string,
) => Promise<{ success: boolean; error?: string }>;

/** Open picker state — non-null only while the `pick` dialog is showing. */
export interface PickerState {
  ideaUuid: string;
  agentUuid: string;
  instances: InstanceCandidate[];
}

export interface UsePinThenWakeOptions {
  /**
   * Fetch the wake-target preview for an idea. Defaults to the real endpoint;
   * overridable in tests. Returns null on any non-OK response (the caller then
   * wakes directly — never blocks the user's action on a preview hiccup).
   */
  fetchPreview?: (ideaUuid: string) => Promise<WakeTargetPreview | null>;
  /** The entity-specific non-waking reassign server action. */
  reassignNoWake: ReassignNoWakeAction;
  previewIdeaUuid?: string | null;
}

export interface StartPinThenWakeArgs {
  /** The target idea uuid (proposals resolve this from their input idea first). */
  ideaUuid: string;
  /**
   * The wake to fire once the cwd is resolved. It runs the surface's own server
   * action (e.g. startDevelopmentAction). The hook does not interpret its
   * result — the caller handles success/error toasts as it does today.
   */
  wake: (temporary?: TemporaryCwdSelection) => void | Promise<void>;
}

export interface TemporaryCwdSelection {
  agentUuid: string;
  validationRequestUuid: string;
}

/** Default preview fetch against the real REST endpoint. */
async function defaultFetchPreview(
  ideaUuid: string,
): Promise<WakeTargetPreview | null> {
  try {
    const res = await fetch(
      `/api/ideas/${encodeURIComponent(ideaUuid)}/wake-preview`,
      { headers: { Accept: "application/json" } },
    );
    if (!res.ok) return null;
    const body = (await res.json()) as {
      success?: boolean;
      data?: WakeTargetPreview;
    };
    if (!body.success || !body.data) return null;
    return body.data;
  } catch (e) {
    clientLogger.error("wake-target preview fetch failed", e);
    return null;
  }
}

/**
 * Orchestrates the pin-then-wake click flow. Returns:
 *  - `start(args)` — call on button click; fetches the preview and branches.
 *  - `pickerState` — non-null while the `pick` dialog should be open; feed it to
 *    `<WakeCwdPickerDialog>`.
 *  - `confirmPick(instance)` — call from the dialog's onConfirm.
 *  - `cancelPick()` — call from the dialog's onCancel.
 *  - `isResolving` — true while the preview is being fetched (button can show a
 *    spinner). Independent of the surface's own wake-pending flag.
 */
export function usePinThenWake({
  fetchPreview = defaultFetchPreview,
  reassignNoWake,
  previewIdeaUuid,
}: UsePinThenWakeOptions) {
  const [pickerState, setPickerState] = useState<PickerState | null>(null);
  const [isResolving, setIsResolving] = useState(false);
  const [fixedTarget, setFixedTarget] =
    useState<ResolvedProjectAgentCwdTarget | null>(null);
  // The wake bound to the currently-open picker, captured at `start` time so
  // `confirmPick` fires the exact wake the user initiated.
  const [pendingWake, setPendingWake] = useState<{
    run: (temporary?: TemporaryCwdSelection) => void | Promise<void>;
  } | null>(
    null,
  );

  useEffect(() => {
    let cancelled = false;
    if (!previewIdeaUuid) {
      setFixedTarget(null);
      return;
    }
    void fetchPreview(previewIdeaUuid).then((preview) => {
      if (cancelled) return;
      setFixedTarget(
        preview?.resolvedTarget?.source === "project_fixed"
          ? preview.resolvedTarget
          : null,
      );
    });
    return () => {
      cancelled = true;
    };
  }, [fetchPreview, previewIdeaUuid]);

  // Reassign that never throws and never blocks the wake — logs and continues.
  // Used by both the auto_pin path and the picker confirm.
  const reassignBestEffort = useCallback(
    async (ideaUuid: string, agentUuid: string, instanceUuid: string) => {
      try {
        const result = await reassignNoWake(ideaUuid, agentUuid, instanceUuid);
        if (!result.success) {
          // A stale or invalid instance does not invalidate the wake; the server
          // resolves the wake target itself. Kept at debug so logs stay quiet.
          clientLogger.debug(
            "pin-then-wake reassign did not persist (continuing to wake)",
            result.error,
          );
        }
      } catch (e) {
        clientLogger.error("pin-then-wake reassign threw (continuing to wake)", e);
      }
    },
    [reassignNoWake],
  );

  const start = useCallback(
    async ({ ideaUuid, wake }: StartPinThenWakeArgs) => {
      setIsResolving(true);
      let preview: WakeTargetPreview | null = null;
      try {
        preview = await fetchPreview(ideaUuid);
        setFixedTarget(
          preview?.resolvedTarget?.source === "project_fixed"
            ? preview.resolvedTarget
            : null,
        );
      } finally {
        setIsResolving(false);
      }

      // No preview (endpoint hiccup / not-found) OR no assignee agent OR the
      // `direct` outcome → wake immediately, exactly as before this change.
      if (!preview || !preview.assigneeAgentUuid || preview.outcome === "direct") {
        await wake();
        return;
      }

      const agentUuid = preview.assigneeAgentUuid;
      const online = filterOnlineInstances(preview.onlineInstances);

      if (preview.outcome === "pick") {
        // Defensive: `pick` implies >=2 online, but if the list somehow arrived
        // empty just wake (nothing to prompt with).
        if (online.length === 0) {
          await wake();
          return;
        }
        setPendingWake({ run: wake });
        setPickerState({ ideaUuid, agentUuid, instances: online });
        return;
      }

      // auto_pin → persist the sole online instance (best-effort), then wake.
      if (preview.outcome === "auto_pin") {
        const sole = online[0];
        if (sole?.agentInstanceUuid) {
          await reassignBestEffort(ideaUuid, agentUuid, sole.agentInstanceUuid);
        }
        await wake();
        return;
      }
    },
    [fetchPreview, reassignBestEffort],
  );

  const confirmPick = useCallback(
    async (instance: InstanceCandidate) => {
      const state = pickerState;
      const wake = pendingWake;
      // Close the dialog first so the UI feels responsive; the reassign+wake
      // then run against the captured state.
      setPickerState(null);
      setPendingWake(null);
      if (!state || !wake) return;
      if (instance.agentInstanceUuid) {
        await reassignBestEffort(
          state.ideaUuid,
          state.agentUuid,
          instance.agentInstanceUuid,
        );
      }
      await wake.run();
    },
    [pickerState, pendingWake, reassignBestEffort],
  );

  const cancelPick = useCallback(() => {
    // Dismissing the picker aborts the whole action — no reassign, no wake.
    setPickerState(null);
    setPendingWake(null);
  }, []);

  const confirmTemporary = useCallback(
    async (selection: TemporaryCwdSelection) => {
      const wake = pendingWake;
      setPickerState(null);
      setPendingWake(null);
      if (wake) await wake.run(selection);
    },
    [pendingWake],
  );

  return {
    start,
    pickerState,
    confirmPick,
    confirmTemporary,
    cancelPick,
    isResolving,
    fixedTarget,
  };
}
