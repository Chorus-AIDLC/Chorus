"use client";

import { useTranslations } from "next-intl";
import { Bot } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Label } from "@/components/ui/label";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { AssigneeInstanceLine } from "@/components/agent-presence";
import { isAgentAssignee } from "@/lib/assignee-identity";

interface AssigneeSectionProps {
  assignee: {
    type: string;
    uuid: string;
    name: string;
    // Present only when type === "agent_instance": the pinned (host, cwd) place.
    instance?: { agentUuid: string; host: string; cwd: string | null };
  } | null;
  // When both are set, the assignee box becomes the reassign trigger: clicking
  // it calls onReassign (opens the assign modal). This replaces the panel's old
  // footer reassign button — the entry point now lives on the assignee itself.
  onReassign?: () => void;
  // When false/omitted the box is read-only.
  editable?: boolean;
}

export function AssigneeSection({ assignee, onReassign, editable }: AssigneeSectionProps) {
  const tCommon = useTranslations("common");

  // The reassign entry is active only while editable AND a handler is wired.
  const interactive = editable === true && typeof onReassign === "function";
  const actionLabel = assignee ? tCommon("reassign") : tCommon("assign");

  // Shared inner content for both interactive and read-only renders.
  const inner = assignee ? (
    <>
      <Avatar className="h-7 w-7">
        <AvatarFallback
          className={
            isAgentAssignee(assignee)
              ? "bg-primary text-white"
              : "bg-border text-muted-foreground"
          }
        >
          {isAgentAssignee(assignee) ? (
            <Bot className="h-3.5 w-3.5" />
          ) : (
            assignee.name.charAt(0).toUpperCase()
          )}
        </AvatarFallback>
      </Avatar>
      <div className="min-w-0">
        <div className="text-sm font-medium text-foreground">{assignee.name}</div>
        <div className="text-xs text-muted-foreground">
          {isAgentAssignee(assignee) ? tCommon("agent") : tCommon("user")}
        </div>
        {/* Pinned (host, cwd) place for an agent_instance assignee. */}
        {assignee.type === "agent_instance" && assignee.instance && (
          <div className="mt-1">
            <AssigneeInstanceLine
              cwd={assignee.instance.cwd}
              host={assignee.instance.host}
            />
          </div>
        )}
      </div>
    </>
  ) : (
    <span className="text-sm text-muted-foreground">{tCommon("unassigned")}</span>
  );

  const boxClass = "mt-2 flex items-center gap-2.5 rounded-lg bg-background p-3";

  return (
    <div>
      <Label className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {tCommon("assignee")}
      </Label>
      {interactive ? (
        // Minimal affordance (elaboration q3=b): cursor-pointer + tooltip +
        // aria-label. No hover-background tint, no hover pencil icon.
        <TooltipProvider delayDuration={300}>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={onReassign}
                aria-label={actionLabel}
                className={`${boxClass} w-full cursor-pointer text-left`}
              >
                {inner}
              </button>
            </TooltipTrigger>
            <TooltipContent>{actionLabel}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
      ) : (
        <div className={boxClass}>{inner}</div>
      )}
    </div>
  );
}
