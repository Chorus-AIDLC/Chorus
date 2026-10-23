"use client";

import { useId } from "react";
import { AgentAvatar } from "@/components/ui/agent-avatar";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export interface AgentSelectOption {
  uuid: string;
  name: string;
  disabled?: boolean;
  description?: string;
}

export function AgentSelect({ agents, value, onValueChange, placeholder, emptyLabel, disabled, ariaLabel }: {
  agents: AgentSelectOption[];
  value: string;
  onValueChange: (uuid: string) => void;
  placeholder: string;
  emptyLabel: string;
  disabled?: boolean;
  ariaLabel?: string;
}) {
  const id = useId();

  return (
    <Select value={value} onValueChange={onValueChange} disabled={disabled}>
      <SelectTrigger className="w-full min-w-0 border-border" aria-label={ariaLabel ?? placeholder}>
        <SelectValue placeholder={placeholder} />
      </SelectTrigger>
      <SelectContent className="z-[120] max-h-[min(18rem,var(--radix-select-content-available-height))] w-[var(--radix-select-trigger-width)] max-w-[calc(100vw-2rem)]" position="popper">
        {agents.length > 0 ? agents.map((agent) => (
          <SelectItem key={agent.uuid} value={agent.uuid} textValue={agent.name} disabled={agent.disabled} aria-describedby={agent.description ? `${id}-${agent.uuid}` : undefined}>
            <span className="flex items-center gap-2">
              <span aria-hidden="true"><AgentAvatar name={agent.name} size={20} className="shrink-0 rounded-full" /></span>
              <span className="min-w-0">
                <span className="block break-all">{agent.name}</span>
                {agent.description && <span id={`${id}-${agent.uuid}`} className="block max-w-72 whitespace-normal text-xs text-muted-foreground">{agent.description}</span>}
              </span>
            </span>
          </SelectItem>
        )) : <p className="px-3 py-2 text-xs text-muted-foreground">{emptyLabel}</p>}
      </SelectContent>
    </Select>
  );
}
