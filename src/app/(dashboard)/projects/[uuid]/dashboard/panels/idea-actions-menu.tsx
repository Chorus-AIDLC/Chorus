"use client";

import { Fragment, useId, useState, useSyncExternalStore, type ReactNode, type RefObject } from "react";
import { useTranslations } from "next-intl";
import { toast } from "sonner";
import { ArrowRightLeft, CheckCircle2, ChevronDown, Copy, CornerLeftUp, GitFork, Link, Pencil, Play, Rocket, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle, SheetTrigger } from "@/components/ui/sheet";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { StartDevelopmentButton } from "@/components/start-development-button";
import { YoloButton } from "@/components/yolo-button";
import type { StartDevelopmentAssignee } from "@/lib/start-development";
import { isImeComposing } from "@/lib/ime";
import { cn } from "@/lib/utils";

type ActionTone = "default" | "verify" | "develop" | "yolo" | "destructive";

const toneClasses: Record<ActionTone, string> = {
  default: "",
  verify: "text-[#1976D2] focus:text-[#155FA0] focus:bg-[#E3F2FD] dark:text-[#64B5F6] dark:focus:text-[#90CAF9] dark:focus:bg-[#102A43]",
  develop: "text-[#2E7D32] focus:text-[#256628] focus:bg-[#E8F5E9] dark:text-[#72D572] dark:focus:text-[#9AE69A] dark:focus:bg-[#17351D]",
  yolo: "text-[#6A4FB6] focus:text-[#584098] focus:bg-[#F1ECFA] dark:text-[#B39DDB] dark:focus:text-[#D1C4E9] dark:focus:bg-[#2A2040]",
  destructive: "text-destructive focus:text-destructive focus:bg-destructive/10",
};

const mobileQuery = "(max-width: 639px)";

function subscribeToMobileQuery(onChange: () => void) {
  if (typeof window === "undefined" || !window.matchMedia) return () => {};
  const query = window.matchMedia(mobileQuery);
  query.addEventListener?.("change", onChange);
  return () => query.removeEventListener?.("change", onChange);
}

function getMobileSnapshot() {
  return typeof window !== "undefined" && !!window.matchMedia?.(mobileQuery).matches;
}

function useIsMobile() {
  return useSyncExternalStore(subscribeToMobileQuery, getMobileSnapshot, () => false);
}

/** aria-disabled rather than Radix disabled: unavailable operations remain in
 * the roving focus order so keyboard users can discover the explanation. */
function ActionItem({ label, icon, reason, onSelect, onTooltipEscape, tone = "default" }: {
  label: string; icon: ReactNode; reason?: string; onSelect: () => void;
  onTooltipEscape: () => void; tone?: ActionTone;
}) {
  const id = useId();
  const item = (
    <DropdownMenuItem
      aria-label={label}
      aria-disabled={!!reason}
      aria-describedby={reason ? id : undefined}
      variant={tone === "destructive" ? "destructive" : "default"}
      className={cn(toneClasses[tone], reason && "cursor-default text-muted-foreground focus:bg-accent focus:text-muted-foreground dark:focus:bg-accent dark:text-muted-foreground dark:focus:text-muted-foreground")}
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
      <TooltipContent
        side="left"
        className="z-[120] max-w-64"
        onEscapeKeyDown={onTooltipEscape}
      >
        {reason}
      </TooltipContent>
    </Tooltip>
  ) : item;
}

function MobileActionItem({ label, icon, reason, onSelect, tone = "default" }: {
  label: string; icon: ReactNode; reason?: string; onSelect: () => void; tone?: ActionTone;
}) {
  const id = useId();
  return (
    <Button
      type="button"
      variant="ghost"
      aria-label={label}
      aria-disabled={!!reason}
      aria-describedby={reason ? id : undefined}
      className={cn(
        "focus-visible:ring-ring flex min-h-12 w-full items-center gap-3 rounded-lg px-3 py-2 text-left text-sm outline-none transition-colors",
        "hover:bg-accent focus-visible:ring-2 [&_svg]:size-5 [&_svg]:shrink-0",
        toneClasses[tone],
        reason && "cursor-default text-muted-foreground hover:bg-transparent focus:bg-accent focus:text-muted-foreground dark:focus:bg-accent dark:text-muted-foreground dark:focus:text-muted-foreground",
      )}
      onKeyDown={(event) => {
        if (event.key === "Enter" && isImeComposing(event)) event.preventDefault();
      }}
      onClick={() => {
        if (!reason) onSelect();
      }}
    >
      {icon}
      <span className="min-w-0 flex-1">
        <span className="block font-medium">{label}</span>
        {reason && <span id={id} className="mt-0.5 block text-xs leading-4 text-muted-foreground">{reason}</span>}
      </span>
    </Button>
  );
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
  onSetParent: () => void;
  onMove: () => void;
  onEdit: () => void;
  onDelete: () => void;
  onStarted: () => void;
  onCloseAutoFocus: (event: Event) => void;
}

export function IdeaActionsMenu(props: IdeaActionsMenuProps) {
  const t = useTranslations();
  const ta = useTranslations("ideaTracker.panel.actions");
  const [actionsOpen, setActionsOpen] = useState(false);
  const isMobile = useIsMobile();
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
        const groups = [
          [
            { label: t("elaboration.verifyButton"), icon: <CheckCircle2 />, reason: mutationReason || props.stageReason || props.verifyReason, onSelect: props.onVerify, tone: "verify" as const },
            { label: start.label, icon: <Play />, reason: mutationReason || start.disabledReason, onSelect: start.onSelect, tone: "develop" as const },
            { label: yolo.label, icon: <Rocket />, reason: mutationReason || yolo.disabledReason, onSelect: yolo.onSelect, tone: "yolo" as const },
          ],
          [
            { label: t("ideaTracker.lineage.deriveIdea"), icon: <GitFork />, reason: mutationReason, onSelect: props.onDerive, tone: "default" as const },
            { label: t("ideaTracker.lineage.setParentTitle"), icon: <CornerLeftUp />, reason: mutationReason, onSelect: props.onSetParent, tone: "default" as const },
            { label: t("ideas.actions.move"), icon: <ArrowRightLeft />, reason: mutationReason, onSelect: props.onMove, tone: "default" as const },
            { label: t("ideas.editIdea"), icon: <Pencil />, reason: mutationReason || props.editReason, onSelect: props.onEdit, tone: "default" as const },
          ],
          [
            { label: ta("copyLink"), icon: <Link />, onSelect: () => { void copy(true); }, tone: "default" as const },
            { label: ta("copyUuid"), icon: <Copy />, onSelect: () => { void copy(false); }, tone: "default" as const },
          ],
          [
            { label: t("ideas.deleteIdea"), icon: <Trash2 />, reason: mutationReason, onSelect: props.onDelete, tone: "destructive" as const },
          ],
        ];

        if (isMobile) {
          return (
            <Sheet open={actionsOpen} onOpenChange={setActionsOpen}>
              <SheetTrigger asChild>
                <Button ref={props.triggerRef} variant="outline" size="sm" className="h-11 gap-1.5 border-border px-3">
                  {t("common.actions")}<ChevronDown className="size-4" aria-hidden />
                </Button>
              </SheetTrigger>
              <SheetContent
                side="bottom"
                className="max-h-[min(82svh,44rem)] gap-0 overflow-hidden rounded-t-2xl pb-[max(1rem,env(safe-area-inset-bottom))]"
                onCloseAutoFocus={props.onCloseAutoFocus}
              >
                <div className="mx-auto mt-2 h-1 w-10 shrink-0 rounded-full bg-muted-foreground/25" aria-hidden />
                <SheetHeader className="border-b px-4 pt-3 pb-3 text-left">
                  <SheetTitle>{t("common.actions")}</SheetTitle>
                  <SheetDescription className="sr-only">{t("common.actions")}</SheetDescription>
                </SheetHeader>
                <div className="overflow-y-auto overscroll-contain px-2 py-2">
                  {groups.map((group, groupIndex) => (
                    <div
                      key={groupIndex}
                      className={cn(groupIndex > 0 && "mt-1 border-t pt-1")}
                    >
                      {group.map((action) => (
                        <MobileActionItem
                          key={action.label}
                          {...action}
                          onSelect={() => {
                            setActionsOpen(false);
                            action.onSelect();
                          }}
                        />
                      ))}
                    </div>
                  ))}
                </div>
              </SheetContent>
            </Sheet>
          );
        }

        return (
          <TooltipProvider delayDuration={300}>
            <DropdownMenu open={actionsOpen} onOpenChange={setActionsOpen}>
              <DropdownMenuTrigger asChild>
                <Button ref={props.triggerRef} variant="outline" size="sm" className="h-8 gap-1.5 border-border px-2.5">
                  {t("common.actions")}<ChevronDown className="h-3.5 w-3.5" aria-hidden />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end" className="z-[100] w-64 max-w-[calc(100vw-1rem)] max-h-[var(--radix-dropdown-menu-content-available-height)] overflow-y-auto">
                {groups.map((group, groupIndex) => (
                  <Fragment key={groupIndex}>
                    {groupIndex > 0 && <DropdownMenuSeparator />}
                    {group.map((action) => (
                      <ActionItem
                        key={action.label}
                        {...action}
                        onTooltipEscape={() => setActionsOpen(false)}
                      />
                    ))}
                  </Fragment>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </TooltipProvider>
        );
      }} />
    )} />
  );
}
