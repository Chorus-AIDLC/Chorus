"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { ChevronLeft, Loader2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useRealtimeEntityTypeEvent } from "@/contexts/realtime-context";
import { clientLogger } from "@/lib/logger-client";
import { DOC_TYPE_I18N_KEYS } from "./utils";
import { getReportsForIdeaAction } from "./actions";
import type { ProposalData } from "./proposal-view";

interface ReportItem {
  uuid: string;
  title: string;
  type: string;
  content: string | null;
  createdAt: string;
}

interface ReportsListProps {
  /** Project UUID — required for the server action's project-scoped lookup. */
  projectUuid: string;
  /** Idea UUID — used to aggregate reports across the Idea's approved proposals. */
  ideaUuid: string;
  /**
   * Approved proposals already loaded by the parent. We use this list as a
   * cheap pre-filter: when no proposal is approved, we know there are no
   * reports and skip the round-trip entirely.
   */
  proposals: ProposalData[];
  /**
   * Click handler that opens the parent's existing DocumentPanel. The panel
   * already knows how to render the content as Markdown via MarkdownContent.
   */
  onDocClick: (doc: { title: string; type: string; content: string }) => void;
}

/**
 * Idea-level Reports list rendered on the overview tab below OverviewTimeline.
 *
 * Aggregates `type="report"` Documents across all approved Proposals of an
 * Idea (server-side via `getReportsForIdeaAction`). Hidden entirely when no
 * reports exist — no header, no empty-state copy, per the spec.
 */
export function ReportsList({
  projectUuid,
  ideaUuid,
  proposals,
  onDocClick,
}: ReportsListProps) {
  const tIdea = useTranslations("idea");
  const tDocs = useTranslations("documents");

  const [reports, setReports] = useState<ReportItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  // Cheap precondition: any approved proposals at all? If not, skip the fetch
  // and render nothing — saves a server round-trip on every open of an Idea
  // that hasn't reached the post-approval stage.
  const hasApprovedProposal = proposals.some((p) => p.status === "approved");

  const fetchReports = useCallback(async () => {
    if (!hasApprovedProposal) {
      setReports([]);
      setIsLoading(false);
      return;
    }
    try {
      const result = await getReportsForIdeaAction(projectUuid, ideaUuid);
      if (result.success) {
        // Defensive resort by createdAt desc — server already sorts but the
        // contract is small enough to make explicit on the rendering side.
        const sorted = [...result.data].sort(
          (a, b) =>
            new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime(),
        );
        setReports(
          sorted.map((d) => ({
            uuid: d.uuid,
            title: d.title,
            type: d.type,
            content: d.content ?? null,
            createdAt: d.createdAt,
          })),
        );
      }
    } catch (e) {
      clientLogger.error("Failed to fetch reports for idea:", e);
    } finally {
      setIsLoading(false);
    }
  }, [projectUuid, ideaUuid, hasApprovedProposal]);

  useEffect(() => {
    setIsLoading(true);
    fetchReports();
  }, [fetchReports]);

  // SSE: re-fetch when a Document changes — covers the "agent just created
  // a new report" case so the list updates without a manual reload.
  useRealtimeEntityTypeEvent("document", fetchReports);

  // Hidden entirely when no reports — no header, no empty-state copy. Loading
  // also renders nothing to avoid a flash of header/spinner before the
  // typical zero-report case settles.
  if (isLoading) {
    if (!hasApprovedProposal) return null;
    return (
      <div className="flex items-center justify-center py-3">
        <Loader2 className="h-4 w-4 animate-spin text-[#C67A52]" />
      </div>
    );
  }

  if (reports.length === 0) return null;

  return (
    <div className="mt-6 space-y-3">
      {/* Section header — REPORTS · count · subtitle */}
      <div className="flex items-baseline gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-[1px] text-[#9A9A9A]">
          {tIdea("reportsList")}
        </span>
        <span className="text-[11px] text-[#9A9A9A]">{reports.length}</span>
        <span className="text-[11px] text-[#B4B2A9]">
          · {tIdea("reportsAcrossProposals")}
        </span>
      </div>

      {/* Rows — chevron-left + Report badge + title, same shape as proposal-view doc rows */}
      <div className="space-y-0">
        {reports.map((r) => (
          <Button
            key={r.uuid}
            variant="ghost"
            className="w-full justify-start h-auto text-left flex items-center gap-2.5 py-3.5 hover:bg-[#FAF8F4] transition-colors cursor-pointer -mx-1 px-1 rounded-lg"
            onClick={() =>
              onDocClick({
                title: r.title,
                type: "report",
                content: r.content ?? "",
              })
            }
          >
            <ChevronLeft className="h-3.5 w-3.5 shrink-0 text-[#B4B2A9]" />
            <Badge
              variant="outline"
              className="shrink-0 text-[10px] font-medium border-[#E5E0D8] text-[#6B6B6B] bg-[#F5F2EC] px-2 py-0.5 font-mono"
            >
              {tDocs(DOC_TYPE_I18N_KEYS[r.type] || "typeOther")}
            </Badge>
            <span className="flex-1 min-w-0 text-left text-[13px] text-[#2C2C2A] truncate">
              {r.title}
            </span>
          </Button>
        ))}
      </div>
    </div>
  );
}
