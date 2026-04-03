"use client";

import { useState, useCallback, useEffect } from "react";
import { useTranslations } from "next-intl";
import { AlertCircle, Lightbulb, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useRealtimeEvent } from "@/contexts/realtime-context";
import { IdeaStatusGroup } from "./idea-status-group";
import type { IdeaCardItem } from "./idea-card";

interface TrackerApiResponse {
  success: boolean;
  data?: {
    groups: Record<string, IdeaCardItem[]>;
    counts: Record<string, number>;
  };
  error?: string;
}

interface IdeaTrackerListProps {
  projectUuid: string;
  onIdeaClick: (uuid: string) => void;
  onNewIdea?: () => void;
  onEmptyChange?: (isEmpty: boolean) => void;
}

// Display order matching the Pencil design
const STATUS_ORDER = ["human_conduct_required", "in_progress", "todo", "done"] as const;

export function IdeaTrackerList({
  projectUuid,
  onIdeaClick,
  onNewIdea,
  onEmptyChange,
}: IdeaTrackerListProps) {
  const t = useTranslations("ideaTracker");

  const [groups, setGroups] = useState<Record<string, IdeaCardItem[]>>({});
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const fetchData = useCallback(async () => {
    try {
      const res = await fetch(`/api/projects/${projectUuid}/ideas/tracker`);
      const json: TrackerApiResponse = await res.json();
      if (json.success && json.data) {
        setGroups(json.data.groups);
        setError(null);
      } else {
        setError(json.error || t("error.loadFailed"));
      }
    } catch {
      setError(t("error.loadFailed"));
    } finally {
      setIsLoading(false);
    }
  }, [projectUuid, t]);

  // Initial fetch + realtime refresh
  useRealtimeEvent(fetchData);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const totalIdeas = STATUS_ORDER.reduce(
    (sum, s) => sum + (groups[s] || []).length,
    0
  );

  useEffect(() => {
    if (!isLoading) {
      onEmptyChange?.(totalIdeas === 0);
    }
  }, [totalIdeas, isLoading, onEmptyChange]);

  // Loading skeleton
  if (isLoading) {
    return (
      <div className="space-y-4">
        {[1, 2, 3].map((i) => (
          <div key={i} className="space-y-2">
            <Skeleton className="h-5 w-32" />
            <Skeleton className="h-12 w-full rounded-lg" />
            <Skeleton className="h-12 w-full rounded-lg" />
          </div>
        ))}
      </div>
    );
  }

  // Error state
  if (error && Object.keys(groups).length === 0) {
    return (
      <div className="flex flex-col items-center gap-4 py-16">
        <AlertCircle className="h-10 w-10 text-[#E65100]" />
        <p className="text-[13px] text-[#6B6B6B]">{error}</p>
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            setIsLoading(true);
            setError(null);
            fetchData();
          }}
          className="border-[#E5E0D8] text-[#2C2C2C]"
        >
          {t("actions.retry")}
        </Button>
      </div>
    );
  }

  // Empty state — centered CTA, no status groups
  if (totalIdeas === 0) {
    return (
      <div className="flex min-h-[60vh] flex-col items-center justify-center gap-3">
        <div className="flex h-12 w-12 items-center justify-center rounded-full bg-[#F5F2EC]">
          <Lightbulb className="h-5 w-5 text-[#B4B2A9]" />
        </div>
        <p className="text-[13px] font-medium text-[#6B6B6B]">
          {t("empty.noIdeas")}
        </p>
        <p className="max-w-[260px] text-center text-[12px] leading-relaxed text-[#9A9A9A]">
          {t("empty.getStarted")}
        </p>
        {onNewIdea && (
          <Button
            onClick={onNewIdea}
            size="sm"
            className="mt-2 gap-1.5 rounded-md bg-[#C67A52] px-4 py-2 text-white hover:bg-[#B56A42]"
          >
            <Plus className="h-4 w-4" />
            {t("actions.newIdea")}
          </Button>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Error banner (non-blocking) */}
      {error && Object.keys(groups).length > 0 && (
        <div className="rounded-lg bg-destructive/10 px-3 py-2 text-[12px] text-destructive">
          {error}
        </div>
      )}

      {/* Status groups — only show groups with ideas */}
      <div className="space-y-4">
        {STATUS_ORDER.map((status) => {
          const ideas = groups[status] || [];
          if (ideas.length === 0) return null;
          return (
            <IdeaStatusGroup
              key={status}
              status={status}
              ideas={ideas}
              defaultOpen={status !== "done"}
              onIdeaClick={onIdeaClick}
            />
          );
        })}
      </div>
    </div>
  );
}
