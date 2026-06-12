"use client";

import { useTranslations } from "next-intl";
import { CornerDownRight, GitFork } from "lucide-react";
import { formatShortDate } from "@/lib/format-date";

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

// Badge colors per hint
const badgeHintColor: Record<string, string> = {
  open: "text-[#888780]",              // Gray — not started
  researching: "text-[#7F77DD]",       // Purple — AI working
  answer_questions: "text-[#C47A20]",  // Orange — human action
  planning: "text-[#7F77DD]",          // Purple — AI working
  review_proposal: "text-[#C47A20]",   // Orange — human action
  building: "text-[#7F77DD]",          // Purple — AI working
  verify_work: "text-[#C47A20]",       // Orange — human action
  done: "text-[#1D9E75]",             // Green — complete
  closed: "text-[#888780]",           // Gray — closed
};

export function IdeaCard({ idea, onClick, depth = 0, showConnector = false }: IdeaRowProps) {
  const t = useTranslations("ideaTracker");
  const badgeKey = idea.badgeHint ? badgeHintI18n[idea.badgeHint] : null;
  const badgeColor = idea.badgeHint
    ? badgeHintColor[idea.badgeHint] || "text-[#888780]"
    : "text-[#888780]";
  const childCount = idea.childCount ?? 0;

  return (
    <div
      className={`flex items-center justify-between px-3.5 py-3 transition-colors ${onClick ? "cursor-pointer hover:bg-[#FAF8F4]" : ""}`}
      onClick={onClick ? () => onClick(idea.uuid) : undefined}
      style={depth > 0 ? { paddingLeft: `${14 + depth * 22}px` } : undefined}
    >
      {/* Left: [connector] ID + Title + Badge + rollup */}
      <div className="flex min-w-0 items-center gap-2.5">
        {showConnector && (
          // ↳ derivation connector — NOT a folder metaphor (weak lineage).
          <CornerDownRight className="h-3.5 w-3.5 shrink-0 text-[#C2BDB2]" aria-hidden />
        )}
        <span className="shrink-0 text-[11px] text-[#B4B2A9]">IDEA</span>
        <span className={`truncate text-[13px] text-[#2C2C2A] ${depth === 0 && childCount > 0 ? "font-medium" : ""}`}>
          {idea.title}
        </span>
        {badgeKey && (
          <span className={`shrink-0 rounded bg-[#F0EEEA] px-1.5 py-0.5 text-[11px] ${badgeColor}`}>
            {t(`badge.${badgeKey}`)}
          </span>
        )}
        {childCount > 0 && (
          // Read-only "+N derived" rollup chip (direct children only).
          <span className="flex shrink-0 items-center gap-1 rounded bg-[#F3E7DD] px-1.5 py-0.5 text-[11px] font-medium text-[#B26B3D]">
            <GitFork className="h-2.5 w-2.5" aria-hidden />
            {t("lineage.derivedCount", { count: childCount })}
          </span>
        )}
      </div>

      {/* Right: Date */}
      <span className="shrink-0 pl-4 text-[12px] text-[#888780]">
        {formatShortDate(idea.createdAt)}
      </span>
    </div>
  );
}
