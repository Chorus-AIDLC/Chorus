"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Lightbulb, ArrowUpRight } from "lucide-react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { IdeaDetailPanel } from "../../ideas/idea-detail-panel";

interface SourceIdea {
  uuid: string;
  title: string;
  content: string | null;
  status: string;
  assignee: {
    type: string;
    uuid: string;
    name: string;
    assignedAt: string | null;
    assignedBy: { type: string; uuid: string; name: string } | null;
  } | null;
  createdAt: string;
}

interface SourceIdeasCardProps {
  ideas: SourceIdea[];
  projectUuid: string;
  currentUserUuid: string;
}

export function SourceIdeasCard({
  ideas,
  projectUuid,
  currentUserUuid,
}: SourceIdeasCardProps) {
  const t = useTranslations("proposals");
  const [selectedIdea, setSelectedIdea] = useState<SourceIdea | null>(null);

  if (ideas.length === 0) {
    return null;
  }

  return (
    <>
      <Card className="border-[#E5E2DC] dark:border-[#2a2a2e] shadow-none rounded-2xl gap-0 py-0 overflow-hidden">
        <CardHeader className="border-b border-secondary px-5 py-4">
          <div className="flex items-center gap-2">
            <Lightbulb className="h-4 w-4 text-primary" />
            <CardTitle className="text-[13px] font-semibold text-foreground">
              {t("sourceIdeas")}
            </CardTitle>
          </div>
        </CardHeader>
        <CardContent className="space-y-2 px-5 py-3">
          {ideas.map((idea) => (
            <button
              key={idea.uuid}
              onClick={() => setSelectedIdea(idea)}
              className="flex w-full items-center gap-2 rounded-lg bg-secondary px-3 py-2 text-left transition-colors hover:bg-[#EDE9E3] dark:hover:bg-[#2a2a2e]"
            >
              <Lightbulb className="h-3.5 w-3.5 shrink-0 text-primary" />
              <span className="flex-1 truncate text-xs font-medium text-primary">
                {idea.title}
              </span>
              <ArrowUpRight className="h-3 w-3 shrink-0 text-[#9A9A9A]" />
            </button>
          ))}
        </CardContent>
      </Card>

      {selectedIdea && (
        <IdeaDetailPanel
          idea={selectedIdea}
          projectUuid={projectUuid}
          currentUserUuid={currentUserUuid}
          isUsedInProposal={true}
          onClose={() => setSelectedIdea(null)}
        />
      )}
    </>
  );
}
