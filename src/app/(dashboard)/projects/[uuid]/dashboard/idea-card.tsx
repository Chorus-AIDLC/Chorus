"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { CornerDownRight, GitFork, Link as LinkIcon, ChevronRight } from "lucide-react";
import { formatShortDate } from "@/lib/format-date";
import { ProgressRing } from "@/components/ui/progress-ring";
import { ActiveSessionIndicator } from "@/components/active-session-indicator";
import { useAgentPresenceOptional } from "@/contexts/agent-presence-context";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { listReferencesAction } from "@/app/(dashboard)/projects/[uuid]/references-actions";
import type { ReferenceArtifactResponse } from "@/services/reference-artifact.service";
import { IdeaReferencesContent } from "./idea-references-panel";

export interface IdeaCardItem {
  uuid: string;
  title: string;
  status: string;
  derivedStatus: string;
  badgeHint: string | null;
  createdAt: string;
  // Lineage (single-parent forest). Present on tracker rows; used by the tree view.
  parentUuid?: string | null;
  childCount?: number;
  // Container idea flag (default false when absent) — drives the container badge.
  isContainer?: boolean;
  // Theme rollup: child-completion (done/total) for the x/y progress ring.
  childProgress?: { done: number; total: number } | null;
  // Count of external-evidence ReferenceArtifacts attached to this idea (idea-
  // scoped, no rollup). Drives the collapsible references panel; the count badge
  // is hidden entirely when 0/absent.
  referenceCount?: number;
}

interface IdeaRowProps {
  idea: IdeaCardItem;
  onClick?: (uuid: string) => void;
  // Lineage tree-view affordances (omitted/0 in the flat view).
  depth?: number;
  // When true, render a ↳ derivation connector before the row (child rows).
  showConnector?: boolean;
}

// Badge i18n key for each badgeHint value
const badgeHintI18n: Record<string, string> = {
  open: "open",
  researching: "researching",
  answer_questions: "answerQuestions",
  planning: "planning",
  review_proposal: "reviewProposal",
  building: "building",
  verify_work: "verifyWork",
  done: "done",
  closed: "closed",
};

// Badge colors per hint. Status hues carry semantic meaning (no design token
// exists for them), so each keeps its light hex and gains a lighter `dark:`
// variant for legibility on the dark surface. Greys route to muted-foreground.
const badgeHintColor: Record<string, string> = {
  open: "text-muted-foreground",                          // Gray — not started
  researching: "text-[#7F77DD] dark:text-[#A99FF0]",      // Purple — AI working
  answer_questions: "text-[#C47A20] dark:text-[#E0A050]", // Orange — human action
  planning: "text-[#7F77DD] dark:text-[#A99FF0]",         // Purple — AI working
  review_proposal: "text-[#C47A20] dark:text-[#E0A050]",  // Orange — human action
  building: "text-[#7F77DD] dark:text-[#A99FF0]",         // Purple — AI working
  verify_work: "text-[#C47A20] dark:text-[#E0A050]",      // Orange — human action
  done: "text-[#1D9E75] dark:text-[#4FD1A0]",             // Green — complete
  closed: "text-muted-foreground",                        // Gray — closed
};

export function IdeaCard({ idea, onClick, depth = 0, showConnector = false }: IdeaRowProps) {
  const t = useTranslations("ideaTracker");
  const tRoot = useTranslations();
  const badgeKey = idea.badgeHint ? badgeHintI18n[idea.badgeHint] : null;
  const badgeColor = idea.badgeHint
    ? badgeHintColor[idea.badgeHint] || "text-muted-foreground"
    : "text-muted-foreground";
  const childCount = idea.childCount ?? 0;
  const referenceCount = idea.referenceCount ?? 0;
  const presence = useAgentPresenceOptional();
  const activeSessions = presence?.activeSessionsByIdea.get(idea.uuid) ?? [];

  // Read-only references panel state (Thread B). Collapsed shows just the count
  // badge; the panel is hidden entirely when there are no references. The fetch
  // state lives here (IdeaCard stays mounted across Collapsible toggles) so the
  // lazy fetch runs exactly once — Radix unmounts CollapsibleContent when closed.
  const [refsOpen, setRefsOpen] = useState(false);
  const [references, setReferences] = useState<ReferenceArtifactResponse[]>([]);
  const [refsLoading, setRefsLoading] = useState(false);
  const [refsFetched, setRefsFetched] = useState(false);

  const handleRefsOpenChange = (open: boolean) => {
    setRefsOpen(open);
    if (open && !refsFetched && !refsLoading) {
      setRefsFetched(true);
      setRefsLoading(true);
      void listReferencesAction("idea", idea.uuid).then((result) => {
        if (result.success) setReferences(result.references);
        setRefsLoading(false);
      });
    }
  };

  // A "theme" reuses the leading type-eyebrow slot instead of a trailing badge:
  // the label itself reads THEME (accent) vs IDEA (muted), so the row type is
  // legible at a glance with zero extra horizontal space — critical on mobile.
  const isTheme = idea.isContainer === true;

  return (
    <Collapsible open={refsOpen} onOpenChange={handleRefsOpenChange}>
      <div
        className={`flex items-center justify-between px-3.5 py-3 transition-colors ${
          onClick ? "cursor-pointer hover:bg-background" : ""
        }`}
        onClick={onClick ? () => onClick(idea.uuid) : undefined}
        style={depth > 0 ? { paddingLeft: `${14 + depth * 22}px` } : undefined}
      >
        {/* Left: [connector] TYPE-eyebrow + Title + status badge + derived rollup */}
        <div className="flex min-w-0 items-center gap-2.5">
          {showConnector && (
            // ↳ derivation connector — NOT a folder metaphor (weak lineage).
            <CornerDownRight className="h-3.5 w-3.5 shrink-0 text-muted-foreground" aria-hidden />
          )}
          <span
            className={`shrink-0 text-[11px] font-semibold tracking-wide ${
              isTheme ? "text-primary" : "font-normal tracking-normal text-muted-foreground"
            }`}
          >
            {isTheme ? t("lineage.typeTheme") : t("lineage.typeIdea")}
          </span>
          <span className={`truncate text-[13px] text-foreground ${isTheme ? "font-medium" : ""}`}>
            {idea.title}
          </span>
          {badgeKey && (
            <span className={`shrink-0 rounded bg-secondary px-1.5 py-0.5 text-[11px] ${badgeColor}`}>
              {t(`badge.${badgeKey}`)}
            </span>
          )}
          {isTheme && idea.childProgress && idea.childProgress.total > 0 ? (
            // Theme with children: a Linear-style x/y progress ring rolled up from
            // child completion — replaces the flat "+N derived" chip so the theme's
            // real progress is legible (not stuck at "elaborated").
            <span
              className="flex shrink-0 items-center gap-1 rounded bg-primary/[0.12] px-1.5 py-0.5 text-[11px] font-medium text-primary"
              title={t("lineage.childrenDone", {
                done: idea.childProgress.done,
                total: idea.childProgress.total,
              })}
            >
              <ProgressRing done={idea.childProgress.done} total={idea.childProgress.total} size={12} stroke={2} />
              {idea.childProgress.done}/{idea.childProgress.total}
            </span>
          ) : childCount > 0 ? (
            // Non-theme parent (weak lineage): plain "+N derived" rollup chip.
            <span className="flex shrink-0 items-center gap-1 rounded bg-primary/[0.12] px-1.5 py-0.5 text-[11px] font-medium text-primary">
              <GitFork className="h-2.5 w-2.5" aria-hidden />
              {t("lineage.derivedCount", { count: childCount })}
            </span>
          ) : null}
          {/* References count badge — collapsed trigger; hidden when 0. Only the
              count is shown collapsed (owner: '外层展示数字'). */}
          {referenceCount > 0 && (
            <CollapsibleTrigger
              onClick={(e) => e.stopPropagation()}
              aria-label={tRoot("references.countLabel", { count: referenceCount })}
              title={tRoot("references.countLabel", { count: referenceCount })}
              className="group/refs flex shrink-0 items-center gap-1 rounded bg-secondary px-1.5 py-0.5 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground"
            >
              <ChevronRight
                className={`h-2.5 w-2.5 transition-transform ${refsOpen ? "rotate-90" : ""}`}
                aria-hidden
              />
              <LinkIcon className="h-2.5 w-2.5" aria-hidden />
              {referenceCount}
            </CollapsibleTrigger>
          )}
          {activeSessions.length > 0 && presence && (
            <ActiveSessionIndicator
              sessions={activeSessions}
              onSelect={presence.openChatForActiveSession}
              surface="tracker"
            />
          )}
        </div>

        {/* Right: Date */}
        <span className="shrink-0 pl-4 text-[12px] text-muted-foreground">
          {formatShortDate(idea.createdAt)}
        </span>
      </div>

      {referenceCount > 0 && (
        <CollapsibleContent onClick={(e) => e.stopPropagation()}>
          <div
            className="px-3.5 pb-3"
            style={depth > 0 ? { paddingLeft: `${14 + depth * 22}px` } : undefined}
          >
            <IdeaReferencesContent references={references} isLoading={refsLoading} />
          </div>
        </CollapsibleContent>
      )}
    </Collapsible>
  );
}
