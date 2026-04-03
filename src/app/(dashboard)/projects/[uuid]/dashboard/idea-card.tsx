"use client";

import { useTranslations } from "next-intl";

export interface IdeaCardItem {
  uuid: string;
  ideaNumber: number;
  title: string;
  status: string;
  derivedStatus: string;
  badgeHint: string | null;
  assignee: {
    type: string;
    uuid: string;
    name: string;
  } | null;
  createdAt: string;
  commentCount: number;
}

interface IdeaRowProps {
  idea: IdeaCardItem;
  onClick: (uuid: string) => void;
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

function formatShortDate(dateString: string): string {
  const date = new Date(dateString);
  return date.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

export function IdeaCard({ idea, onClick }: IdeaRowProps) {
  const t = useTranslations("ideaTracker");
  const badgeKey = idea.badgeHint ? badgeHintI18n[idea.badgeHint] : null;
  const badgeColor = idea.badgeHint
    ? badgeHintColor[idea.badgeHint] || "text-[#888780]"
    : "text-[#888780]";

  return (
    <div
      className="flex cursor-pointer items-center justify-between px-3.5 py-3 transition-colors hover:bg-[#FAF8F4]"
      onClick={() => onClick(idea.uuid)}
    >
      {/* Left: ID + Title + Badge */}
      <div className="flex min-w-0 items-center gap-2.5">
        <span className="shrink-0 text-[11px] text-[#B4B2A9]">
          IDEA-{idea.ideaNumber}
        </span>
        <span className="truncate text-[13px] text-[#2C2C2A]">
          {idea.title}
        </span>
        {badgeKey && (
          <span className={`shrink-0 rounded bg-[#F0EEEA] px-1.5 py-0.5 text-[11px] ${badgeColor}`}>
            {t(`badge.${badgeKey}`)}
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
