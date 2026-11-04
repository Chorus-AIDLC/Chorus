"use client";

import { useId, useState, type ReactNode } from "react";
import { Ellipsis, Plus } from "lucide-react";
import { AgentSelect, type AgentSelectOption } from "@/components/agent-select";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import type { AgentTeamRole } from "@/types/agent-team";
import { roleIcons } from "./role-icons";
import { TeamMemberChip, type MemberChipData } from "./team-member-chip";

export interface TeamRoleRowProps {
  role: AgentTeamRole;
  roleLabel: string;
  description?: string;
  members: MemberChipData[];
  badge?: ReactNode;
  addOptions?: AgentSelectOption[];
  addLabel: string;
  emptyLabel: string;
  actionsLabel: string;
  removeLabel: (member: MemberChipData) => string;
  onAdd?: (uuid: string) => void;
  onRemove?: (uuid: string) => void;
  actions?: ReactNode;
  disabled?: boolean;
  readOnly?: boolean;
}

export function TeamRoleRow({ role, roleLabel, description, members, badge, addOptions = [], addLabel, emptyLabel, actionsLabel, removeLabel, onAdd, onRemove, actions, disabled, readOnly }: TeamRoleRowProps) {
  const labelId = useId();
  const [addOpen, setAddOpen] = useState(false);
  const [actionsOpen, setActionsOpen] = useState(false);
  const Icon = roleIcons[role];

  return (
    <div role="group" aria-labelledby={labelId} className="flex min-w-0 flex-col gap-3 px-4 py-3 sm:flex-row sm:items-start">
      <div className="flex min-w-0 gap-2 sm:w-44 sm:shrink-0">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary/10 text-primary">
          <Icon aria-hidden="true" className="size-4" />
        </span>
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-1.5">
            <span id={labelId} className="text-sm font-medium text-foreground">{roleLabel}</span>
            {badge}
          </div>
          {description && <p className="truncate text-xs text-muted-foreground" title={description}>{description}</p>}
        </div>
      </div>
      <div className="flex min-w-0 flex-1 items-start gap-2">
        <div className="flex min-w-0 flex-1 flex-wrap gap-1.5">
          {members.map((member) => (
            <TeamMemberChip key={member.uuid} member={member} removeLabel={removeLabel(member)} onRemove={onRemove} disabled={disabled} readOnly={readOnly} />
          ))}
        </div>
        {!readOnly && (onAdd || actions) && (
          <div className="ml-auto flex shrink-0 items-center gap-1">
            {onAdd && (
              <Popover open={addOpen && !disabled} onOpenChange={setAddOpen}>
                <PopoverTrigger asChild>
                  <Button type="button" variant="ghost" size="icon" className="size-7" aria-label={addLabel} disabled={disabled}>
                    <Plus aria-hidden="true" className="size-4" />
                  </Button>
                </PopoverTrigger>
                <PopoverContent align="end" className="z-[110] w-64 max-w-[calc(100vw-2rem)] p-2">
                  <AgentSelect agents={addOptions} value="" placeholder={addLabel} emptyLabel={emptyLabel} ariaLabel={addLabel} disabled={disabled} onValueChange={(uuid) => {
                    onAdd(uuid);
                    setAddOpen(false);
                  }} />
                </PopoverContent>
              </Popover>
            )}
            {actions && (
              <DropdownMenu open={actionsOpen && !disabled} onOpenChange={setActionsOpen}>
                <DropdownMenuTrigger asChild>
                  <Button type="button" variant="ghost" size="icon" className="size-7" aria-label={actionsLabel} disabled={disabled}>
                    <Ellipsis aria-hidden="true" className="size-4" />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end" className="z-[110]">{actions}</DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
