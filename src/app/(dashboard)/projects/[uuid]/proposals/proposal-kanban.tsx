"use client";

import { useState, useEffect, useCallback } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Bot, User } from "lucide-react";
import { Streamdown } from "streamdown";
import { code } from "@streamdown/code";
import type { DocumentDraft, TaskDraft } from "@/services/proposal.service";
import { useRealtimeEntityTypeEvent } from "@/contexts/realtime-context";
import { useIsMobile } from "@/hooks/use-mobile";
import { PresenceIndicator } from "@/components/ui/presence-indicator";
import { motion } from "framer-motion";
import { fetchProposalsAction } from "./actions";

interface Proposal {
  uuid: string;
  title: string;
  description: string | null;
  inputType: string;
  documentDrafts: DocumentDraft[] | null;
  taskDrafts: TaskDraft[] | null;
  status: string;
  createdBy: { type: string; uuid: string; name: string } | null;
  createdByType: string;
  review: {
    reviewedBy: { type: string; uuid: string; name: string };
    reviewNote: string | null;
    reviewedAt: string | null;
  } | null;
  createdAt: string;
}

interface ProposalKanbanProps {
  projectUuid: string;
  proposals: Proposal[];
}

// Column config — matches task kanban pattern
const columnConfigs = [
  { id: "draft", labelKey: "status.draft", statuses: ["draft"] },
  { id: "pending", labelKey: "status.pendingReview", statuses: ["pending"] },
  {
    id: "completed",
    labelKey: "proposals.completed",
    statuses: ["approved", "closed"],
  },
];

// Status badge colors — same palette as task kanban
const statusColors: Record<string, string> = {
  draft: "bg-[#F5F5F5] text-[#6B6B6B]",
  pending: "bg-[#FFF3E0] text-[#E65100]",
  approved: "bg-[#E8F5E9] text-[#2E7D32]",
  closed: "bg-[#F5F5F5] text-[#9A9A9A]",
};

const statusI18nKeys: Record<string, string> = {
  draft: "draft",
  pending: "pendingReview",
  approved: "approved",
  closed: "closed",
};

function getTypeTagKey(proposal: Proposal): string | null {
  const docCount = proposal.documentDrafts?.length || 0;
  const taskCount = proposal.taskDrafts?.length || 0;

  if (docCount > 0 && taskCount > 0) return "proposals.typeDocumentAndTasks";
  if (docCount > 0)
    return docCount === 1
      ? "proposals.typeNewDocument"
      : "proposals.typeDocumentUpdate";
  if (taskCount > 0) return "proposals.typeTaskBreakdown";
  return null;
}

// Mobile filter tabs — "all" plus one per column
const mobileFilterTabs = [
  { id: "all", labelKey: "proposals.all", statuses: [] as string[] },
  ...columnConfigs,
];

function ProposalCard({
  proposal,
  projectUuid,
  t,
}: {
  proposal: Proposal;
  projectUuid: string;
  t: ReturnType<typeof useTranslations>;
}) {
  const typeTagKey = getTypeTagKey(proposal);

  return (
    <Link
      href={`/projects/${projectUuid}/proposals/${proposal.uuid}`}
      className="block"
    >
      <PresenceIndicator entityType="proposal" entityUuid={proposal.uuid}>
      <Card className="cursor-pointer border-[#E5E0D8] bg-white p-4 transition-all hover:border-[#C67A52] hover:shadow-sm">
        {/* Row 1: Status badge + Type tag */}
        <div className="mb-2 flex items-start justify-between">
          <Badge
            className={
              statusColors[proposal.status] || statusColors.draft
            }
          >
            {t(
              `status.${statusI18nKeys[proposal.status] || proposal.status}`
            )}
          </Badge>
          {typeTagKey && (
            <span className="rounded bg-[#FFF3E0] px-2 py-0.5 text-xs font-medium text-[#E65100]">
              {t(typeTagKey)}
            </span>
          )}
        </div>

        {/* Title */}
        <h4 className="mb-1 font-medium text-[#2C2C2C]">
          {proposal.title}
        </h4>

        {/* Description */}
        {proposal.description && (
          <div className="prose prose-sm max-w-none mb-2 line-clamp-2 text-sm text-[#6B6B6B]">
            <Streamdown plugins={{ code }}>{proposal.description}</Streamdown>
          </div>
        )}

        {/* Bottom row: Creator */}
        <div className="flex items-center justify-between text-xs text-[#9A9A9A]">
          {proposal.createdBy && (
            <span className="flex items-center gap-1">
              {proposal.createdByType === "agent" ? (
                <Bot className="h-3 w-3" />
              ) : (
                <User className="h-3 w-3" />
              )}
              {proposal.createdBy.name}
            </span>
          )}
        </div>
      </Card>
      </PresenceIndicator>
    </Link>
  );
}

export function ProposalKanban({ projectUuid, proposals: initialProposals }: ProposalKanbanProps) {
  const t = useTranslations();
  const isMobile = useIsMobile();
  const [activeFilter, setActiveFilter] = useState("all");
  const [proposals, setProposals] = useState(initialProposals);

  // Sync from server component on navigation
  useEffect(() => { setProposals(initialProposals); }, [initialProposals]);

  // Refetch proposals locally on SSE — no router.refresh()
  const refetchProposals = useCallback(async () => {
    const result = await fetchProposalsAction(projectUuid);
    if (result.success) {
      setProposals(result.data);
    }
  }, [projectUuid]);

  useRealtimeEntityTypeEvent("proposal", refetchProposals);

  const getProposalsForColumn = (statuses: string[]) =>
    proposals.filter((p) => statuses.includes(p.status));

  // Mobile: vertical list with horizontal status filter tabs
  if (isMobile) {
    const activeTab = mobileFilterTabs.find((tab) => tab.id === activeFilter) || mobileFilterTabs[0];
    const filteredProposals =
      activeFilter === "all"
        ? proposals
        : getProposalsForColumn(activeTab.statuses);

    return (
      <div className="flex flex-1 flex-col">
        {/* Horizontal status filter tabs */}
        <div className="flex gap-2 overflow-x-auto pb-3 mb-4">
          {mobileFilterTabs.map((tab) => {
            const count =
              tab.id === "all"
                ? proposals.length
                : getProposalsForColumn(tab.statuses).length;
            const isActive = activeFilter === tab.id;

            return (
              <button
                key={tab.id}
                onClick={() => setActiveFilter(tab.id)}
                className={`flex shrink-0 items-center gap-1.5 rounded-full px-3 py-1.5 text-sm font-medium transition-colors ${
                  isActive
                    ? "bg-[#C67A52] text-white"
                    : "bg-[#F5F2EC] text-[#6B6B6B] hover:bg-[#EDE9E1]"
                }`}
              >
                {t(tab.labelKey)}
                <span
                  className={`rounded-full px-1.5 py-0.5 text-xs ${
                    isActive
                      ? "bg-white/20 text-white"
                      : "bg-white text-[#6B6B6B]"
                  }`}
                >
                  {count}
                </span>
              </button>
            );
          })}
        </div>

        {/* Vertical proposal list */}
        <div className="flex-1 space-y-3">
          {filteredProposals.length === 0 ? (
            <motion.div
              initial={{ opacity: 0, scale: 0.98 }}
              animate={{ opacity: 1, scale: 1 }}
              transition={{ duration: 0.2, ease: [0, 0, 0.2, 1] }}
              className="flex h-24 items-center justify-center rounded-lg border-2 border-dashed border-[#E5E0D8] text-sm text-[#9A9A9A]"
            >
              {t("proposals.noProposals")}
            </motion.div>
          ) : (
            filteredProposals.map((proposal) => (
              <ProposalCard
                key={proposal.uuid}
                proposal={proposal}
                projectUuid={projectUuid}
                t={t}
              />
            ))
          )}
        </div>
      </div>
    );
  }

  // Desktop: horizontal kanban columns
  return (
    <div className="flex flex-1 gap-4 overflow-x-auto pb-4">
      {columnConfigs.map((column) => {
        const columnProposals = getProposalsForColumn(column.statuses);

        return (
          <div
            key={column.id}
            className="flex w-[300px] flex-shrink-0 flex-col rounded-xl bg-[#F5F2EC] p-4"
          >
            {/* Column Header — same as task kanban */}
            <div className="mb-4 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <h3 className="font-medium text-[#2C2C2C]">
                  {t(column.labelKey)}
                </h3>
                <span className="rounded-full bg-white px-2 py-0.5 text-xs font-medium text-[#6B6B6B]">
                  {columnProposals.length}
                </span>
              </div>
            </div>

            {/* Cards */}
            {/* pt-3: leave room for PresenceIndicator badge above first card */}
            <div className="flex-1 space-y-4 overflow-y-auto pt-3">
              {columnProposals.length === 0 ? (
                <motion.div
                  initial={{ opacity: 0, scale: 0.98 }}
                  animate={{ opacity: 1, scale: 1 }}
                  transition={{ duration: 0.2, ease: [0, 0, 0.2, 1] }}
                  className="flex h-24 items-center justify-center rounded-lg border-2 border-dashed border-[#E5E0D8] text-sm text-[#9A9A9A]"
                >
                  {t("proposals.noProposals")}
                </motion.div>
              ) : (
                columnProposals.map((proposal) => (
                  <ProposalCard
                    key={proposal.uuid}
                    proposal={proposal}
                    projectUuid={projectUuid}
                    t={t}
                  />
                ))
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
