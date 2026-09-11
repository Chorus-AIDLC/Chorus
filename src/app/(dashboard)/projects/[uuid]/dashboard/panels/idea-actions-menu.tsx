"use client";

import { useId, type ReactNode, type RefObject } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { ArrowRightLeft, CheckCircle2, ChevronDown, Copy, GitFork, Link, Pencil, Play, Rocket, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { StartDevelopmentButton } from "@/components/start-development-button";
import { YoloButton } from "@/components/yolo-button";
import type { StartDevelopmentAssignee } from "@/lib/start-development";
import { isImeComposing } from "@/lib/ime";

/** aria-disabled rather than Radix disabled: unavailable operations remain in
 * the roving focus order so keyboard users can discover the explanation. */
function ActionItem({ label, icon, reason, onSelect, destructive = false }: {
  label: string; icon: ReactNode; reason?: string; onSelect: () => void; destructive?: boolean;
}) {
  const id = useId();
  const item = (
    <DropdownMenuItem
      aria-label={label}
      aria-disabled={!!reason}
      aria-describedby={reason ? id : undefined}
      variant={destructive ? "destructive" : "default"}
      className={reason ? "text-muted-foreground cursor-default" : undefined}
      onKeyDown={(event) => {
        if (event.key === "Enter" && isImeComposing(event)) event.preventDefault();
      }}
      onSelect={(event) => {
        if (reason) event.preventDefault();
        else onSelect();
      }}
    >
      {icon}<span>{label}</span>
      {reason && <span id={id} className="sr-only">{reason}</span>}
    </DropdownMenuItem>
  );
  return reason ? (
    <Tooltip>
      <TooltipTrigger asChild>{item}</TooltipTrigger>
      <TooltipContent side="left" className="z-[120] max-w-64">{reason}</TooltipContent>
    </Tooltip>
  ) : item;
}

interface IdeaActionsMenuProps {
  ideaUuid: string;
  projectUuid: string;
  assignee: StartDevelopmentAssignee | null | undefined;
  assigneeName?: string;
  proposals: { status: string }[];
  tasks: { status: string }[];
  triggerRef: RefObject<HTMLButtonElement | null>;
  busy: boolean;
  stageReason?: string;
  stageDataReason?: string;
  verifyReason?: string;
  editReason?: string;
  onVerify: () => void;
  onDerive: () => void;
  onMove: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onStarted: () => void;
  onCloseAutoFocus: (event: Event) => void;
}

export function IdeaActionsMenu(props: IdeaActionsMenuProps) {
  const t = useTranslations();
  const ta = useTranslations("ideaTracker.panel.actions");
  const busyReason = props.busy ? ta("busy") : undefined;
  const stageReason = busyReason || props.stageReason || props.stageDataReason;
  const copy = async (link: boolean) => {
    try {
      const value = link
        ? new URL(`/projects/${props.projectUuid}/dashboard?panel=${props.ideaUuid}`, window.location.origin).href
        : props.ideaUuid;
      await navigator.clipboard.writeText(value);
      toast.success(ta(link ? "linkCopied" : "uuidCopied"));
    } catch {
      toast.error(ta("copyFailed"));
    }
  };
  const shared = {
    ideaUuid: props.ideaUuid, assignee: props.assignee, assigneeName: props.assigneeName,
    proposals: props.proposals, tasks: props.tasks, onStarted: props.onStarted,
    disabledReason: stageReason, onCloseAutoFocus: props.onCloseAutoFocus,
  };

  // These owners deliberately wrap the menu, NOT its content. Radix unmounts
  // content on selection; confirmation/picker state must survive that unmount.
  return (
    <StartDevelopmentButton {...shared} renderAction={(start) => (
      <YoloButton {...shared} disabledReason={stageReason || (start.busy ? ta("busy") : undefined)} renderAction={(yolo) => {
        const mutationReason = busyReason || (start.busy || yolo.busy ? ta("busy") : undefined);
        return (
          <TooltipProvider delayDuration={300}>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button ref={props.triggerRef} variant="outline" size="sm" className="h-8 gap-1.5 border-border px-2.5">
                  {t("common.actions")}<ChevronDown className="h-3.5 w-3.5" aria-hidden />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="z-[100] w-64 max-w-[calc(100vw-1rem)] max-h-[var(--radix-dropdown-menu-content-available-height)] overflow-y-auto">
                <ActionItem label={t("elaboration.verifyButton")} icon={<CheckCircle2 />} reason={mutationReason || props.stageReason || props.verifyReason} onSelect={props.onVerify} />
                <ActionItem label={start.label} icon={<Play />} reason={mutationReason || start.disabledReason} onSelect={start.onSelect} />
                <ActionItem label={yolo.label} icon={<Rocket />} reason={mutationReason || yolo.disabledReason} onSelect={yolo.onSelect} />
                <DropdownMenuSeparator />
                <ActionItem label={t("ideaTracker.lineage.deriveIdea")} icon={<GitFork />} reason={mutationReason} onSelect={props.onDerive} />
                <ActionItem label={t("ideas.actions.move")} icon={<ArrowRightLeft />} reason={mutationReason} onSelect={props.onMove} />
                <ActionItem label={t("ideas.editIdea")} icon={<Pencil />} reason={mutationReason || props.editReason} onSelect={props.onEdit} />
                <DropdownMenuSeparator />
                <ActionItem label={ta("copyLink")} icon={<Link />} onSelect={() => { void copy(true); }} />
                <ActionItem label={ta("copyUuid")} icon={<Copy />} onSelect={() => { void copy(false); }} />
                <DropdownMenuSeparator />
                <ActionItem label={t("ideas.deleteIdea")} icon={<Trash2 />} reason={mutationReason} onSelect={props.onDelete} destructive />
              </DropdownMenuContent>
            </DropdownMenu>
          </TooltipProvider>
        );
      }} />
    )} />
  );
}
