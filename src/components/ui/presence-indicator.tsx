"use client";

import { usePresence, type PresenceEntry } from "@/hooks/use-presence";
import { getAgentColor } from "@/lib/agent-color";
import { Bot } from "lucide-react";

interface PresenceIndicatorProps {
  entityType: string;
  entityUuid: string;
  /** Optional sub-entity for nested resources (e.g., draft within a proposal) */
  subEntityType?: string;
  subEntityUuid?: string;
  children: React.ReactNode;
  /** Place badge inside the border (for containers with overflow-hidden) */
  badgeInside?: boolean;
}

export function PresenceIndicator({ entityType, entityUuid, subEntityType, subEntityUuid, children, badgeInside }: PresenceIndicatorProps) {
  const { getPresence } = usePresence();
  const entries = getPresence(entityType, entityUuid, subEntityType, subEntityUuid);

  const hasPresence = entries.length > 0;

  // Determine border style: mutate takes priority over view
  const hasMutate = hasPresence && entries.some((e) => e.action === "mutate");
  const borderStyle = hasMutate ? "solid" : "dashed";

  // Primary agent for border color (mutate > view, then most recent)
  const primary = hasPresence
    ? (hasMutate ? entries.find((e) => e.action === "mutate")! : entries[entries.length - 1])
    : null;
  const borderColor = primary ? getAgentColor(primary.agentName) : "transparent";

  return (
    <div
      className="relative"
      style={hasPresence ? {
        outline: `2px ${borderStyle} ${borderColor}`,
        outlineOffset: "-2px",
        borderRadius: "var(--radius)",
      } : undefined}
    >
      {/* Agent badges */}
      {hasPresence && (
        <div className={`absolute flex gap-1 z-10 justify-end ${badgeInside ? "top-0.5 right-1.5 max-w-[70%]" : "-top-2.5 right-2 max-w-[80%]"}`}>
          {entries.slice(0, 3).map((entry) => (
            <AgentBadge key={entry.agentUuid} entry={entry} />
          ))}
          {entries.length > 3 && (
            <span className="inline-flex items-center px-1.5 py-0.5 rounded-full text-[10px] font-medium text-white bg-gray-500 whitespace-nowrap">
              +{entries.length - 3}
            </span>
          )}
        </div>
      )}
      {children}
    </div>
  );
}

function AgentBadge({ entry }: { entry: PresenceEntry }) {
  const color = getAgentColor(entry.agentName);

  return (
    <span
      className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded-full text-[10px] font-medium text-white whitespace-nowrap animate-in fade-in duration-300 ease-out sm:text-[11px] sm:px-2"
      style={{ backgroundColor: color }}
    >
      <Bot className="h-2.5 w-2.5" />
      {entry.agentName}
    </span>
  );
}
