"use client";

import { useState, useCallback, useEffect } from "react";
import { useTranslations } from "next-intl";
import { AlertCircle, GitFork, Lightbulb, List, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useRealtimeEntityTypeEvent } from "@/contexts/realtime-context";
import { IdeaStatusGroup } from "./idea-status-group";
import { IdeaLineageTree } from "./idea-lineage-tree";
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
  initialData?: { groups: Record<string, IdeaCardItem[]>; counts: Record<string, number> };
  onIdeaClick?: (uuid: string) => void;
  onNewIdea?: () => void;
  onEmptyChange?: (isEmpty: boolean) => void;
}

// Display order matching the Pencil design
const STATUS_ORDER = ["human_conduct_required", "in_progress", "todo", "done"] as const;

export function IdeaTrackerList({
  projectUuid,
  initialData,
  onIdeaClick,
  onNewIdea,
  onEmptyChange,
}: IdeaTrackerListProps) {
  const t = useTranslations("ideaTracker");

  const [groups, setGroups] = useState<Record<string, IdeaCardItem[]>>(initialData?.groups ?? {});
  const [isLoading, setIsLoading] = useState(!initialData);
  const [error, setError] = useState<string | null>(null);
  // View mode: "flat" (default, status-grouped) or "tree" (lineage-indented).
  // Default flat — the lineage is opt-in, never force-imposed on the list.
  const [viewMode, setViewMode] = useState<"flat" | "tree">("flat");

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

  // Realtime refresh — derived status depends on idea + proposal + task state
  // TODO: SSE events lack field-level granularity; ideally only refresh on status changes, not every update
  useRealtimeEntityTypeEvent("idea", fetchData);
  useRealtimeEntityTypeEvent("proposal", fetchData);
  useRealtimeEntityTypeEvent("task", fetchData);

  // Only fetch on mount if no initial data was provided
  useEffect(() => {
    if (!initialData) fetchData();
  }, [fetchData, initialData]);

  const totalIdeas = STATUS_ORDER.reduce(
    (sum, s) => sum + (groups[s] || []).length,
    0
  );

  // Flatten all status groups into a single list for the lineage tree view.
  const allIdeas: IdeaCardItem[] = STATUS_ORDER.flatMap((s) => groups[s] || []);

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

      {/* Flat / Tree view toggle — segmented control. Flat is the default; the
          lineage tree groups by derivation when the user opts in. */}
      <div className="flex justify-end">
        <div className="inline-flex items-center gap-0.5 rounded-lg bg-[#EFEBE3] p-0.5">
          <button
            type="button"
            onClick={() => setViewMode("flat")}
            aria-pressed={viewMode === "flat"}
            className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12px] transition-colors ${
              viewMode === "flat"
                ? "bg-white font-medium text-[#2C2C2A] shadow-sm"
                : "text-[#888780] hover:text-[#2C2C2A]"
            }`}
          >
            <List className="h-3.5 w-3.5" />
            {t("lineage.viewFlat")}
          </button>
          <button
            type="button"
            onClick={() => setViewMode("tree")}
            aria-pressed={viewMode === "tree"}
            className={`flex items-center gap-1.5 rounded-md px-3 py-1.5 text-[12px] transition-colors ${
              viewMode === "tree"
                ? "bg-white font-medium text-[#2C2C2A] shadow-sm"
                : "text-[#888780] hover:text-[#2C2C2A]"
            }`}
          >
            <GitFork className="h-3.5 w-3.5" />
            {t("lineage.viewTree")}
          </button>
        </div>
      </div>

      {viewMode === "tree" ? (
        /* Lineage tree — single indented forest built from parentUuid */
        <IdeaLineageTree ideas={allIdeas} onIdeaClick={onIdeaClick} />
      ) : (
        /* Status groups — only show groups with ideas */
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
      )}
    </div>
  );
}
