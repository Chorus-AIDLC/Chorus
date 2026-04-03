"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { IdeaTrackerList } from "./idea-tracker-list";
import { IdeaTrackerStats } from "./idea-tracker-stats";
import { IdeaDetailPanel } from "./panels/idea-detail-panel";
import { NewIdeaDialog } from "./new-idea-dialog";
import type { TrackerGroups } from "@/services/idea.service";

interface ProjectStats {
  ideas: { total: number; open: number };
  tasks: { total: number; inProgress: number; todo: number; toVerify: number; done: number };
  proposals: { total: number; pending: number };
  documents: { total: number };
}

interface ActivityItem {
  uuid: string;
  targetType: string;
  action: string;
  actorName: string;
  createdAt: string;
}

interface StatsData {
  stats: ProjectStats;
  recentActivities: ActivityItem[];
}

interface IdeaTrackerProps {
  projectUuid: string;
  currentUserUuid: string;
  initialGroups?: TrackerGroups;
  initialStats?: StatsData;
}

export function IdeaTracker({ projectUuid, currentUserUuid, initialGroups, initialStats }: IdeaTrackerProps) {
  const t = useTranslations("ideaTracker");
  const [selectedIdeaUuid, setSelectedIdeaUuid] = useState<string | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [isEmpty, setIsEmpty] = useState(true);
  const [showNewIdeaDialog, setShowNewIdeaDialog] = useState(false);
  const [activeTab, setActiveTab] = useState<"ideas" | "stats">("ideas");

  const handleIdeaCreated = (uuid: string) => {
    setRefreshKey((k) => k + 1);
    setSelectedIdeaUuid(uuid);
  };

  return (
    <div className="flex h-full flex-col">
      {/* Tab Header */}
      <div className="mb-4 flex items-center justify-between">
        <div className="flex gap-2">
          <button
            onClick={() => setActiveTab("ideas")}
            className={`rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors ${
              activeTab === "ideas"
                ? "bg-white text-[#2C2C2A] shadow-sm"
                : "text-[#6B6B6B] hover:text-[#2C2C2A]"
            }`}
          >
            {t("tabs.ideas")}
          </button>
          <button
            onClick={() => setActiveTab("stats")}
            className={`rounded-md px-3 py-1.5 text-[13px] font-medium transition-colors ${
              activeTab === "stats"
                ? "bg-white text-[#2C2C2A] shadow-sm"
                : "text-[#6B6B6B] hover:text-[#2C2C2A]"
            }`}
          >
            {t("tabs.stats")}
          </button>
        </div>

        {/* New Idea button — only visible on ideas tab when not empty */}
        {activeTab === "ideas" && !isEmpty && (
          <Button
            onClick={() => setShowNewIdeaDialog(true)}
            size="sm"
            className="gap-1.5 rounded-md bg-[#C67A52] px-3.5 py-2 text-white hover:bg-[#B56A42]"
          >
            <Plus className="h-4 w-4" />
            {t("actions.newIdea")}
          </Button>
        )}
      </div>

      {/* Tab Content */}
      {activeTab === "ideas" ? (
        <IdeaTrackerList
          key={refreshKey}
          projectUuid={projectUuid}
          onIdeaClick={setSelectedIdeaUuid}
          onNewIdea={() => setShowNewIdeaDialog(true)}
          onEmptyChange={setIsEmpty}
          initialGroups={initialGroups}
        />
      ) : (
        <IdeaTrackerStats
          projectUuid={projectUuid}
          initialData={initialStats}
        />
      )}

      {/* New Idea Dialog */}
      <NewIdeaDialog
        open={showNewIdeaDialog}
        onOpenChange={setShowNewIdeaDialog}
        projectUuid={projectUuid}
        onCreated={handleIdeaCreated}
      />

      {/* Detail Panel */}
      {selectedIdeaUuid && (
        <IdeaDetailPanel
          ideaUuid={selectedIdeaUuid}
          projectUuid={projectUuid}
          currentUserUuid={currentUserUuid}
          onClose={() => setSelectedIdeaUuid(null)}
        />
      )}
    </div>
  );
}
