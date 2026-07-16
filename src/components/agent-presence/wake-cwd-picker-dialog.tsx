"use client";

// The stage-advance / proposal-approval cwd picker (pin-cwd-before-wake, D5).
//
// When a wake-triggering button (Verify Elaborate / Start Development / Yolo /
// Proposal approve-reject) resolves to the `pick` preview outcome — a bare
// agent with >=2 effectively-online connections and no online session-origin —
// the button opens THIS dialog to let the human choose which (host, cwd) the
// idea should be pinned to before the wake fires.
//
// It is the stage-advance sibling of `MentionInstancePickerDialog` (mention
// editor) and reuses the very same `InstancePicker` body + z-[110]/max-h-[85svh]
// mobile-safe shell, so the two picker surfaces never drift. The ONLY
// differences are copy (the `wakeCwdPicker` namespace, framed as "pin & continue"
// rather than "pin instance") and that this one is a leaf, prop-driven dialog
// the caller mounts once and drives via `open`.
//
// ONLINE-ONLY: the caller passes the preview's `onlineInstances` (already the
// effectively-online subset) through `filterOnlineInstances` before handing them
// here — an offline (host, cwd) is never a wake target, so it is never shown.

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { isImeComposing } from "@/lib/ime";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { InstancePicker, type InstanceCandidate } from "./instance-picker";

export interface WakeCwdPickerDialogProps {
  /** Controlled open state — the caller mounts once and toggles this. */
  open: boolean;
  /** The assignee agent's display name, for the subtitle count sentence. */
  agentName: string;
  /** The ONLINE (host, cwd) candidate instances (already filtered online). */
  instances: InstanceCandidate[];
  /**
   * Fires when the human confirms a selection. Receives the full candidate so
   * the caller can persist the DURABLE `agentInstanceUuid` (not the ephemeral
   * connectionUuid) via the non-waking reassign, then fire the wake.
   */
  onConfirm: (instance: InstanceCandidate) => void;
  /** Fires when the human dismisses the dialog (Cancel / overlay / Esc). */
  onCancel: () => void;
}

/**
 * Modal cwd picker for the pin-then-wake flow. Presentational + prop-driven; it
 * never fetches instances or performs the reassign/wake itself — the caller owns
 * that orchestration (see `usePinThenWake`).
 */
export function WakeCwdPickerDialog({
  open,
  agentName,
  instances,
  onConfirm,
  onCancel,
}: WakeCwdPickerDialogProps) {
  const t = useTranslations("wakeCwdPicker");
  const [selected, setSelected] = useState<InstanceCandidate | null>(null);

  // Default-select the FIRST instance whenever a new pick opens the dialog so
  // Confirm is reachable immediately (no click) and Radix RadioGroup's roving
  // focus lands on a concrete row. The dialog only opens for >=2 instances (the
  // `pick` outcome), so there is always something to default to.
  useEffect(() => {
    if (open) setSelected(instances[0] ?? null);
  }, [open, instances]);

  // Enter confirms the current selection — the keyboard counterpart to clicking
  // Confirm. The isImeComposing guard is mandatory (CLAUDE.md IME rule): a
  // CJK/JP/KR user pressing Enter to CONFIRM an IME candidate must not
  // accidentally pin+wake.
  const handleListKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== "Enter" || isImeComposing(e)) return;
    if (!selected) return;
    e.preventDefault();
    onConfirm(selected);
  };

  const distinctHosts = new Set(instances.map((i) => i.host)).size;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      {/* z-[110]/max-h-[85svh]: opened from inside the idea-detail side panel
          (fixed z-50), so it must clear the panel and its tab bar; the body is
          the only scroll region so the footer stays reachable under the mobile
          soft keyboard. Identical contract to MentionInstancePickerDialog. */}
      <DialogContent
        className="z-[110] flex max-h-[85svh] flex-col gap-0 sm:max-w-md"
        overlayClassName="z-[110]"
      >
        <DialogHeader className="shrink-0">
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>
            {t("subtitle", {
              name: agentName,
              count: instances.length,
              hosts: distinctHosts,
            })}
          </DialogDescription>
        </DialogHeader>
        <div
          className="min-h-0 flex-1 overflow-y-auto py-3"
          onKeyDown={handleListKeyDown}
        >
          <InstancePicker
            instances={instances}
            selectedConnectionUuid={selected?.connectionUuid ?? null}
            onSelect={setSelected}
            ariaLabel={t("title")}
          />
        </div>
        <DialogFooter className="shrink-0">
          <Button variant="ghost" onClick={onCancel}>
            {t("cancel")}
          </Button>
          <Button
            disabled={!selected}
            onClick={() => {
              if (selected) onConfirm(selected);
            }}
          >
            {t("confirm")}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
