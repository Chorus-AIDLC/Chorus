"use client";

import { useMemo, useEffect, useState, useCallback } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Bot, MessageSquare, FileText, User } from "lucide-react";
import {
  Card,
  CardHeader,
  CardAction,
  CardContent,
  CardFooter,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Streamdown } from "streamdown";
import { code } from "@streamdown/code";
import { IdeaDetailPanel } from "./idea-detail-panel";
import { useRealtimeEntityTypeEvent } from "@/contexts/realtime-context";
import { usePanelUrl } from "@/hooks/use-panel-url";
import { PresenceIndicator } from "@/components/ui/presence-indicator";
import { StaggerList, StaggerItem } from "@/components/stagger-list";
import { fetchIdeasAction } from "./actions";

interface IdeaItem {
  uuid: string;
  title: string;
  content: string | null;
  status: string;
  elaborationStatus?: string;
  assignee: {
    type: string;
    uuid: string;
    name: string;
    assignedAt: string | null;
    assignedBy: { type: string; uuid: string; name: string } | null;
  } | null;
  createdBy: { type: string; uuid: string; name: string } | null;
  createdAt: string;
  commentCount: number;
}

interface IdeasListProps {
  ideas: IdeaItem[];
  projectUuid: string;
  currentUserUuid: string;
  usedIdeaUuids: string[];
  ideaProposalMap: Record<string, string>;
  initialSelectedIdeaUuid?: string | null;
}

// Status badge styles: dot color + badge variant className
const statusBadgeStyles: Record<string, { dot: string; className: string }> = {
  open: { dot: "bg-[#2563EB]", className: "bg-[#DBEAFE] text-[#1D4ED8] border-transparent" },
  elaborating: { dot: "bg-[#1976D2]", className: "bg-[#E3F2FD] text-[#1976D2] border-transparent" },
  proposal_created: { dot: "bg-[#FF9800]", className: "bg-[#FFF3E0] text-[#E65100] border-transparent" },
  completed: { dot: "bg-[#4CAF50]", className: "bg-[#E8F5E9] text-[#2E7D32] border-transparent" },
  closed: { dot: "bg-[#9A9A9A]", className: "bg-[#F5F5F5] text-[#6B6B6B] border-transparent" },
};

const statusI18nKeys: Record<string, string> = {
  open: "open",
  elaborating: "elaborating",
  proposal_created: "proposal_created",
  completed: "completed",
  closed: "closed",
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function formatRelativeTime(dateString: string, t: any): string {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return t("time.justNow");
  if (diffMins < 60) return t("time.minutesAgo", { minutes: diffMins });
  if (diffHours < 24) return t("time.hoursAgo", { hours: diffHours });
  if (diffDays < 7) return t("time.daysAgo", { days: diffDays });
  return date.toLocaleDateString();
}

export function IdeasList({
  ideas: initialIdeas,
  projectUuid,
  currentUserUuid,
  usedIdeaUuids: initialUsedIdeaUuids,
  ideaProposalMap: initialIdeaProposalMap,
  initialSelectedIdeaUuid,
}: IdeasListProps) {
  const t = useTranslations();

  const [ideas, setIdeas] = useState(initialIdeas);
  const [usedIdeaUuids, setUsedIdeaUuids] = useState(initialUsedIdeaUuids);
  const [ideaProposalMap, setIdeaProposalMap] = useState(initialIdeaProposalMap);

  // Sync from server component on navigation/filter change
  useEffect(() => { setIdeas(initialIdeas); }, [initialIdeas]);
  useEffect(() => { setUsedIdeaUuids(initialUsedIdeaUuids); }, [initialUsedIdeaUuids]);
  useEffect(() => { setIdeaProposalMap(initialIdeaProposalMap); }, [initialIdeaProposalMap]);

  // Refetch ideas locally on SSE — no router.refresh()
  const refetchIdeas = useCallback(async () => {
    const result = await fetchIdeasAction(projectUuid);
    if (result.success) {
      setIdeas(result.data.ideas);
      setUsedIdeaUuids(result.data.usedIdeaUuids);
      setIdeaProposalMap(result.data.ideaProposalMap);
    }
  }, [projectUuid]);

  useRealtimeEntityTypeEvent("idea", refetchIdeas);

  const basePath = `/projects/${projectUuid}/ideas`;
  const { selectedId, openPanel, closePanel } = usePanelUrl(basePath, initialSelectedIdeaUuid);

  const usedSet = new Set(usedIdeaUuids);

  // If selectedId is not in the current list (e.g., filter changed), close panel
  useEffect(() => {
    if (selectedId && !ideas.some((i) => i.uuid === selectedId)) {
      closePanel();
    }
  }, [selectedId, ideas, closePanel]);

  // Derive selectedIdea from current props
  const selectedIdea = useMemo(
    () => (selectedId ? ideas.find((i) => i.uuid === selectedId) ?? null : null),
    [selectedId, ideas]
  );

  return (
    <>
      <StaggerList className="space-y-4">
        {ideas.map((idea) => {
          const badgeStyle = statusBadgeStyles[idea.status] || statusBadgeStyles.open;
          const isUsed = usedSet.has(idea.uuid);

          return (
            <StaggerItem key={idea.uuid}>
              <PresenceIndicator entityType="idea" entityUuid={idea.uuid}>
                <Card
              className="cursor-pointer border-[#E5E0D8] py-4 transition-all hover:border-[#C67A52]/50 hover:shadow-sm"
              onClick={() => openPanel(idea.uuid)}
            >
              {/* Header: Author meta + Status badge */}
              <CardHeader className="gap-0 py-0">
                <div className="flex items-center gap-2">
                  <Avatar size="sm">
                    <AvatarFallback className="bg-[#E5E0D8] text-[#6B6B6B]">
                      {idea.createdBy?.type === "agent" ? (
                        <Bot className="h-3 w-3" />
                      ) : (
                        <User className="h-3 w-3" />
                      )}
                    </AvatarFallback>
                  </Avatar>
                  <span className="text-[11px] text-[#6B6B6B]">
                    {idea.createdBy?.name || t("common.unknown")}
                  </span>
                  <span className="text-[11px] text-[#9A9A9A]">•</span>
                  <span className="text-[11px] text-[#9A9A9A]">
                    {formatRelativeTime(idea.createdAt, t)}
                  </span>
                </div>
                <CardAction>
                  <Badge className={`gap-1.5 text-[10px] ${badgeStyle.className}`}>
                    <span className={`h-1.5 w-1.5 rounded-full ${badgeStyle.dot}`} />
                    {isUsed
                      ? t("ideas.proposalGenerated")
                      : t(`status.${statusI18nKeys[idea.status] || idea.status}`)}
                  </Badge>
                </CardAction>
              </CardHeader>

              <CardContent className="space-y-2 py-0">
                {/* Assigned To row */}
                {idea.assignee && (
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] text-[#9A9A9A]">
                      {t("ideas.assignedTo")}:
                    </span>
                    <Badge className="gap-1.5 bg-[#F0F9FF] text-[#0284C7] border-transparent text-[10px]">
                      <Bot className="h-3 w-3" />
                      {idea.assignee.name}
                    </Badge>
                  </div>
                )}

                {/* Title */}
                <h3 className="text-sm font-medium text-[#2C2C2C]">
                  {idea.title}
                </h3>

                {/* Content */}
                {idea.content && (
                  <div className="prose prose-sm max-w-none line-clamp-3 text-[13px] leading-relaxed text-[#2C2C2C]">
                    <Streamdown plugins={{ code }}>{idea.content}</Streamdown>
                  </div>
                )}
              </CardContent>

              {/* Actions row */}
              <CardFooter className="gap-4 py-0 text-[#6B6B6B]">
                <div className="flex items-center gap-1.5">
                  <MessageSquare className="h-3.5 w-3.5" />
                  <span className="text-xs">
                    {idea.commentCount} {t("comments.title").toLowerCase()}
                  </span>
                </div>
                {isUsed && ideaProposalMap[idea.uuid] && (
                  <Link
                    href={`/projects/${projectUuid}/proposals/${ideaProposalMap[idea.uuid]}`}
                    onClick={(e) => e.stopPropagation()}
                    className="flex items-center gap-1.5 text-[#C67A52] hover:text-[#B56A42] transition-colors"
                  >
                    <FileText className="h-3.5 w-3.5" />
                    <span className="text-xs font-medium">
                      {t("ideas.viewProposal")}
                    </span>
                  </Link>
                )}
              </CardFooter>
                </Card>
              </PresenceIndicator>
            </StaggerItem>
          );
        })}
      </StaggerList>

      {/* Side Panel */}
      {selectedIdea && (
        <IdeaDetailPanel
          idea={selectedIdea}
          projectUuid={projectUuid}
          currentUserUuid={currentUserUuid}
          isUsedInProposal={usedSet.has(selectedIdea.uuid)}
          onClose={closePanel}
          onDeleted={closePanel}
        />
      )}
    </>
  );
}
