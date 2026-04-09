import type { useTranslations } from "next-intl";
import type { BadgeHint } from "@/services/idea.service";

export type TranslateFn = ReturnType<typeof useTranslations>;

// ===== Panel Layout Constants =====

/** Width of side panels (idea detail, document, task detail) — used for side-by-side positioning */
export const PANEL_WIDTH_PX = 480;

// ===== Shared Task Types =====

/** Flattened task shape used across panel components */
export interface FlatTask {
  uuid: string;
  title: string;
  status: string;
  commentCount: number;
  assignee?: { type: string; uuid: string; name: string } | null;
  acceptanceSummary?: {
    total: number;
    required: number;
    passed: number;
    failed: number;
    pending: number;
    requiredPassed: number;
    requiredFailed: number;
    requiredPending: number;
  } | null;
}

/** Task status → dot color mapping (shared by overview-timeline and task-list-view) */
export function getTaskStatusDotColor(status: string): string {
  switch (status) {
    case "done":
      return "bg-[#00796B]";
    case "in_progress":
      return "bg-[#1976D2]";
    case "to_verify":
      return "bg-[#7B1FA2]";
    case "open":
    case "assigned":
      return "bg-[#E65100]";
    case "closed":
      return "bg-[#9A9A9A]";
    default:
      return "bg-[#D9D9D9]";
  }
}

// ===== Relative Time Formatting =====

export function formatRelativeTime(dateString: string, t: TranslateFn, locale?: string): string {
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
  return date.toLocaleDateString(locale);
}

// ===== Derived Status UI Mapping =====

/** Badge colors keyed by derived status */
export const DERIVED_STATUS_COLORS: Record<string, string> = {
  todo: "bg-[#FFF3E0] text-[#E65100]",
  in_progress: "bg-[#E3F2FD] text-[#1976D2]",
  human_conduct_required: "bg-[#F3E5F5] text-[#7B1FA2]",
  done: "bg-[#E0F2F1] text-[#00796B]",
};

/** i18n key mapping for derived status labels (under "ideaTracker.status" namespace) */
export const DERIVED_STATUS_I18N_KEYS: Record<string, string> = {
  todo: "todo",
  in_progress: "inProgress",
  human_conduct_required: "humanConductRequired",
  done: "done",
};

// ===== Badge Hint i18n =====

export const BADGE_HINT_I18N_KEYS: Record<string, string> = {
  open: "open",
  researching: "researching",
  answer_questions: "answerQuestions",
  planning: "planning",
  review_proposal: "reviewProposal",
  building: "building",
  verify_work: "verifyWork",
  done: "done",
};

export function getBadgeHintLabel(badgeHint: BadgeHint, t: TranslateFn): string {
  if (!badgeHint) return "";
  return t(BADGE_HINT_I18N_KEYS[badgeHint] || "open");
}
