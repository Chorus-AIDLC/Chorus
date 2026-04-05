"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { ChevronDown, ChevronRight } from "lucide-react";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { PresenceIndicator } from "@/components/ui/presence-indicator";
import { IdeaCard, type IdeaCardItem } from "./idea-card";

interface IdeaStatusGroupProps {
  status: string;
  ideas: IdeaCardItem[];
  defaultOpen?: boolean;
  onIdeaClick?: (uuid: string) => void;
}

// Dot colors matching the Pencil design
const statusDotStyles: Record<string, { fill?: string; stroke?: string }> = {
  human_conduct_required: { fill: "#7F77DD" },
  in_progress: { fill: "#378ADD" },
  todo: { stroke: "#888780" },
  done: { fill: "#1D9E75" },
};

const statusI18nKeys: Record<string, string> = {
  todo: "todo",
  in_progress: "inProgress",
  human_conduct_required: "humanConductRequired",
  done: "done",
};

export function IdeaStatusGroup({
  status,
  ideas,
  defaultOpen = true,
  onIdeaClick,
}: IdeaStatusGroupProps) {
  const t = useTranslations("ideaTracker");
  const hasIdeas = ideas.length > 0;
  const [isOpen, setIsOpen] = useState(hasIdeas ? defaultOpen : false);

  const statusKey = statusI18nKeys[status] || "todo";
  const dotStyle = statusDotStyles[status] || statusDotStyles.todo;

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <CollapsibleTrigger className="flex w-full items-center gap-2 px-0 pb-1.5 pt-0">
        {isOpen ? (
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-[#888780]" />
        ) : (
          <ChevronRight className="h-3.5 w-3.5 shrink-0 text-[#888780]" />
        )}
        {/* Status dot */}
        <span
          className="h-2 w-2 shrink-0 rounded-full"
          style={{
            backgroundColor: dotStyle.fill,
            border: dotStyle.stroke ? `1.5px solid ${dotStyle.stroke}` : undefined,
          }}
        />
        <span className={`text-[13px] font-medium ${hasIdeas ? "text-[#5F5E5A]" : "text-[#B4B2A9]"}`}>
          {t(`status.${statusKey}`)}
        </span>
        <span className="text-[12px] text-[#888780]">
          {ideas.length}
        </span>
      </CollapsibleTrigger>

      {hasIdeas && (
        <CollapsibleContent>
          <div className="overflow-hidden rounded-lg bg-white">
            {ideas.map((idea, idx) => (
              <div key={idea.uuid}>
                {idx > 0 && (
                  <div className="mx-0 h-px bg-[#F0EEEA]" />
                )}
                <PresenceIndicator entityType="idea" entityUuid={idea.uuid} badgeInside>
                  <IdeaCard idea={idea} onClick={onIdeaClick} />
                </PresenceIndicator>
              </div>
            ))}
          </div>
        </CollapsibleContent>
      )}
    </Collapsible>
  );
}
