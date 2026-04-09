"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { ActivityTimeline } from "./activity-timeline";
import { UnifiedComments } from "@/components/unified-comments";

interface ActivityCommentsViewProps {
  ideaUuid: string;
  currentUserUuid?: string;
  commentCount: number;
  onCommentCountChange?: (count: number) => void;
}

type SubTab = "activity" | "comments";

export function ActivityCommentsView({
  ideaUuid,
  currentUserUuid,
  commentCount,
  onCommentCountChange,
}: ActivityCommentsViewProps) {
  const t = useTranslations("ideaTracker");
  const [activeSubTab, setActiveSubTab] = useState<SubTab>("activity");

  return (
    <div className="space-y-4">
      {/* Sub-tab toggle */}
      <div className="flex gap-1 rounded-lg bg-[#F5F2EC] p-0.5">
        <button
          onClick={() => setActiveSubTab("activity")}
          className={`flex-1 rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors ${
            activeSubTab === "activity"
              ? "bg-white text-[#2C2C2C] shadow-sm"
              : "text-[#9A9A9A] hover:text-[#6B6B6B]"
          }`}
        >
          {t("panel.activityTab.activity")}
        </button>
        <button
          onClick={() => setActiveSubTab("comments")}
          className={`flex-1 rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors flex items-center justify-center gap-1.5 ${
            activeSubTab === "comments"
              ? "bg-white text-[#2C2C2C] shadow-sm"
              : "text-[#9A9A9A] hover:text-[#6B6B6B]"
          }`}
        >
          {t("panel.activityTab.comments")}
          {commentCount > 0 && (
            <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-[#F5F2EC] text-[#6B6B6B] text-[10px] font-semibold leading-none">
              {commentCount}
            </span>
          )}
        </button>
      </div>

      {/* Sub-tab content */}
      <div>
        {activeSubTab === "activity" ? (
          <ActivityTimeline ideaUuid={ideaUuid} />
        ) : (
          <UnifiedComments
            targetType="idea"
            targetUuid={ideaUuid}
            currentUserUuid={currentUserUuid}
            onCountChange={onCommentCountChange}
            compact
          />
        )}
      </div>
    </div>
  );
}
