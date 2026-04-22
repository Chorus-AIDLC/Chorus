"use client";

import { useState, useEffect, useCallback } from "react";
import { useTranslations } from "next-intl";
import { Loader2 } from "lucide-react";
import { Label } from "@/components/ui/label";
import { getIdeaActivitiesAction } from "@/app/(dashboard)/projects/[uuid]/ideas/[ideaUuid]/activity-actions";
import { formatRelativeTime, type TranslateFn } from "../utils";
import type { ActivityResponse } from "@/services/activity.service";

function formatActivityMessage(activity: ActivityResponse, t: TranslateFn): string {
  const { action, actorName } = activity;

  switch (action) {
    case "created":
    case "idea_created":
      return t("activity.ideaCreated", { actor: actorName });
    case "assigned":
    case "idea_assigned":
      return t("activity.ideaAssigned", { actor: actorName });
    case "claimed":
    case "idea_claimed":
      return t("activity.ideaClaimed", { actor: actorName });
    case "released":
    case "idea_released":
      return t("activity.ideaReleased", { actor: actorName });
    case "status_changed":
    case "idea_status_changed":
      return t("activity.ideaStatusChanged", { actor: actorName });
    case "elaboration_started":
      return t("activity.elaborationStarted", { actor: actorName });
    case "elaboration_answered":
      return t("activity.elaborationAnswered", { actor: actorName });
    case "elaboration_skipped":
      return t("activity.elaborationSkipped", { actor: actorName });
    case "elaboration_resolved":
      return t("activity.elaborationResolved", { actor: actorName });
    case "elaboration_followup":
      return t("activity.elaborationFollowup", { actor: actorName });
    default:
      return t("activity.genericAction", { actor: actorName, action });
  }
}

interface ActivityTimelineProps {
  ideaUuid: string;
}

export function ActivityTimeline({ ideaUuid }: ActivityTimelineProps) {
  const t = useTranslations();

  const [activities, setActivities] = useState<ActivityResponse[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  const loadActivities = useCallback(async () => {
    setIsLoading(true);
    const result = await getIdeaActivitiesAction(ideaUuid);
    setActivities(result.activities);
    setIsLoading(false);
  }, [ideaUuid]);

  useEffect(() => {
    loadActivities();
  }, [loadActivities]);

  return (
    <div className="mt-5">
      <Label className="text-[11px] font-medium uppercase tracking-wider text-[#9A9A9A]">
        {t("common.activity")}
      </Label>
      <div className="mt-2">
        {isLoading ? (
          <div className="flex items-center justify-center py-4">
            <Loader2 className="h-4 w-4 animate-spin text-[#9A9A9A]" />
          </div>
        ) : activities.length === 0 ? (
          <p className="text-sm text-[#9A9A9A] italic">{t("common.noActivity")}</p>
        ) : (
          activities.map((activity, idx) => (
            <div key={activity.uuid} className="flex items-stretch gap-2.5">
              <div className="flex flex-col items-center w-2 shrink-0">
                <div className="mt-1.5 h-2 w-2 shrink-0 rounded-full border-[1.5px] border-[#D9D9D9] bg-white" />
                {idx < activities.length - 1 && (
                  <div className="flex-1 w-px bg-[#E5E0D8] mt-1" />
                )}
              </div>
              <div className="flex-1 pb-3">
                <p className="text-[13px] text-[#2C2C2C]">
                  {formatActivityMessage(activity, t as TranslateFn)}
                </p>
                <p className="text-[11px] text-[#9A9A9A]">{formatRelativeTime(activity.createdAt, t as TranslateFn)}</p>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}
