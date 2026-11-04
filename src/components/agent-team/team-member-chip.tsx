"use client";

import { useId } from "react";
import { AlertTriangle, X } from "lucide-react";
import { AgentAvatar } from "@/components/ui/agent-avatar";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { TapTooltip } from "./tap-tooltip";

export interface MemberChipData {
  uuid: string;
  name: string;
  online?: boolean;
  presenceLabel?: string;
  ineligibleReason?: string;
}

export interface TeamMemberChipProps {
  member: MemberChipData;
  removeLabel: string;
  onRemove?: (uuid: string) => void;
  readOnly?: boolean;
  disabled?: boolean;
}

export function TeamMemberChip({ member, removeLabel, onRemove, readOnly, disabled }: TeamMemberChipProps) {
  const reasonId = useId();
  // Presence and eligibility hints must be reachable without hover (touch, keyboard).
  const hint = member.ineligibleReason || member.presenceLabel
    ? <>{member.ineligibleReason && <p>{member.ineligibleReason}</p>}{member.presenceLabel && <p>{member.presenceLabel}</p>}</>
    : null;
  const identity = (
    <span
      className="flex min-w-0 items-center gap-1.5 rounded-full outline-none focus-visible:ring-2 focus-visible:ring-ring"
      tabIndex={hint ? 0 : undefined}
      aria-describedby={member.ineligibleReason ? reasonId : undefined}
    >
      <span aria-hidden="true" className="shrink-0">
        <AgentAvatar name={member.name} size={20} className="rounded-full" />
      </span>
      <span className="min-w-0 break-all">{member.name}</span>
      {member.online !== undefined && (
        <span className="inline-flex shrink-0">
          <span aria-hidden="true" className={cn("size-1.5 rounded-full", member.online ? "bg-primary" : "bg-muted-foreground/50")} />
          {member.presenceLabel && <span className="sr-only">{member.presenceLabel}</span>}
        </span>
      )}
      {member.ineligibleReason && <AlertTriangle aria-hidden="true" className="size-3.5 shrink-0 text-destructive" />}
    </span>
  );

  return (
    <span className={cn(
      "inline-flex max-w-full items-center gap-1 rounded-full border border-border bg-secondary/50 px-2 py-1 text-xs text-foreground",
      member.ineligibleReason && "border-destructive/40 bg-destructive/5 dark:border-destructive/60 dark:bg-destructive/10",
    )}>
      {hint ? <TapTooltip content={hint}>{identity}</TapTooltip> : identity}
      {member.ineligibleReason && <span id={reasonId} className="sr-only">{member.ineligibleReason}</span>}
      {!readOnly && onRemove && (
        <Button
          type="button"
          size="icon"
          variant="ghost"
          className="relative size-5 shrink-0 rounded-full text-muted-foreground after:absolute after:-inset-2 after:content-[''] hover:text-foreground"
          aria-label={removeLabel}
          disabled={disabled}
          onClick={() => onRemove(member.uuid)}
        >
          <X aria-hidden="true" className="size-3" />
        </Button>
      )}
    </span>
  );
}
