"use client";

import { useTranslations } from "next-intl";
import { useState } from "react";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { usePanelUrl } from "@/hooks/use-panel-url";
import { IdeaTrackerList } from "./idea-tracker-list";
import { IdeaTrackerStats } from "./idea-tracker-stats";
import { IdeaDetailPanel } from "./panels/idea-detail-panel";
import { NewIdeaDialog } from "./new-idea-dialog";
import type { TrackerGroupsResult } from "@/services/idea.service";

interface IdeaTrackerProps {
  projectUuid: string;
  currentUserUuid: string;
  initialTrackerData: TrackerGroupsResult;
  initialSelectedIdeaUuid?: string | null;
  initialStatsData: {
    stats: {
      ideas: { total: number; open: number };
      tasks: { total: number; inProgress: number; todo: number; toVerify: number; done: number };
      proposals: { total: number; pending: number };
      documents: { total: number };
    };
    recentActivities: Array<{
      uuid: string;
      targetType: string;
      action: string;
      actorName: string;
      createdAt: string;
    }>;
  };
}

export function IdeaTracker({ projectUuid, currentUserUuid, initialTrackerData, initialStatsData, initialSelectedIdeaUuid }: IdeaTrackerProps) {
  const t = useTranslations("ideaTracker");
  const [activeTab, setActiveTab] = useState<"ideas" | "stats">("ideas");
  const [isEmpty, setIsEmpty] = useState(false);
  const [showNewIdeaDialog, setShowNewIdeaDialog] = useState(false);

  const basePath = `/projects/${projectUuid}/dashboard`;
  const { selectedId: selectedIdeaUuid, openPanel, closePanel } = usePanelUrl(basePath, initialSelectedIdeaUuid);

  return (
    <div className="flex h-full flex-col">
      {/* Header: Tabs + New Idea button */}
      {!isEmpty && (
        <div className="mb-4 flex items-center justify-between">
          <div className="flex gap-0.5 rounded-lg border border-[#E5E0D8] bg-[#F7F6F3] p-0.5">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setActiveTab("ideas")}
              className={`rounded-md px-3 py-1 h-auto text-[12px] font-medium transition-colors ${
                activeTab === "ideas"
                  ? "bg-white text-[#2C2C2C] shadow-sm"
                  : "text-[#9A9A9A] hover:text-[#6B6B6B]"
              }`}
            >
              {t("tabs.ideas")}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setActiveTab("stats")}
              className={`rounded-md px-3 py-1 h-auto text-[12px] font-medium transition-colors ${
                activeTab === "stats"
                  ? "bg-white text-[#2C2C2C] shadow-sm"
                  : "text-[#9A9A9A] hover:text-[#6B6B6B]"
              }`}
            >
              {t("tabs.stats")}
            </Button>
          </div>

          {activeTab === "ideas" && (
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
      )}

      {activeTab === "ideas" ? (
        <IdeaTrackerList
          projectUuid={projectUuid}
          initialData={initialTrackerData}
          onIdeaClick={openPanel}
          onNewIdea={() => setShowNewIdeaDialog(true)}
          onEmptyChange={setIsEmpty}
        />
      ) : (
        <IdeaTrackerStats projectUuid={projectUuid} initialData={initialStatsData} />
      )}

      <NewIdeaDialog
        open={showNewIdeaDialog}
        onOpenChange={setShowNewIdeaDialog}
        projectUuid={projectUuid}
        onCreated={(uuid) => openPanel(uuid)}
      />

      {selectedIdeaUuid && (
        <IdeaDetailPanel
          ideaUuid={selectedIdeaUuid}
          projectUuid={projectUuid}
          currentUserUuid={currentUserUuid}
          onClose={closePanel}
        />
      )}
    </div>
  );
}
