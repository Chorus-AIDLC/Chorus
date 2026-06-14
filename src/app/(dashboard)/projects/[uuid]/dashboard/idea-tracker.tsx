"use client";

import { useTranslations } from "next-intl";
import { useEffect, useState } from "react";
import { BarChart3, GitFork, List, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { usePanelUrl } from "@/hooks/use-panel-url";
import { IdeaTrackerList } from "./idea-tracker-list";
import { IdeaTrackerStats } from "./idea-tracker-stats";
import { IdeaDetailPanel } from "./panels/idea-detail-panel";
import { NewIdeaDialog } from "./new-idea-dialog";
import {
  adaptiveDefault,
  hasLineageInGroups,
  readStoredView,
  storeView,
  type DashboardView,
} from "./dashboard-view-preference";
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

  // Single owner of the view selection. The initial value is the *adaptive
  // default* (lineage when the project has derivation, else the flat list) and
  // is computed identically on server and client — localStorage is deliberately
  // NOT read here. Reading it in the initializer would make the client's first
  // render diverge from the server HTML for anyone with a stored override,
  // producing a React hydration mismatch on every load. Instead the stored
  // per-project preference is applied once after mount (effect below).
  const [view, setView] = useState<DashboardView>(() =>
    adaptiveDefault(hasLineageInGroups(initialTrackerData?.groups)),
  );
  const [showNewIdeaDialog, setShowNewIdeaDialog] = useState(false);

  // Apply the stored per-project override after hydration. This runs only on
  // the client (post-mount), so it can safely touch localStorage without
  // affecting the server-rendered HTML. The empty dep array means it runs once;
  // a later data refresh must never yank the user to a different view.
  useEffect(() => {
    const stored = readStoredView(projectUuid);
    if (stored) setView(stored);
  }, [projectUuid]);

  // Persist the manual choice so it wins on the next visit.
  const selectView = (next: DashboardView) => {
    setView(next);
    storeView(projectUuid, next);
  };

  // Emptiness is owned here but kept in sync with the *live* tracker data. The
  // SSR snapshot seeds the first value; the child list refetches its groups on
  // realtime idea/proposal/task events and reports the current emptiness back
  // via onEmptyChange. Without this, creating the first idea from the empty-state
  // CTA would populate the list but leave the header "New Idea" button hidden
  // (the SSR prop never updates), stranding the user with no way to add another
  // idea until a full reload.
  const [isEmpty, setIsEmpty] = useState<boolean>(() =>
    initialTrackerData
      ? Object.values(initialTrackerData.groups).reduce((n, arr) => n + arr.length, 0) === 0
      : false,
  );

  const basePath = `/projects/${projectUuid}/dashboard`;
  const { selectedId: selectedIdeaUuid, openPanel, closePanel } = usePanelUrl(basePath, initialSelectedIdeaUuid);

  // One segmented control, three peer options. Beige-fill style, unified across
  // all three (no second control, no layout jump when switching to Stats).
  const viewOptions: { id: DashboardView; label: string; icon: typeof List }[] = [
    { id: "ideas", label: t("tabs.ideas"), icon: List },
    { id: "lineage", label: t("tabs.lineage"), icon: GitFork },
    { id: "stats", label: t("tabs.stats"), icon: BarChart3 },
  ];

  return (
    <div className="flex h-full flex-col">
      {/* Header: single 3-way view switch + New Idea button */}
      <div className="mb-4 flex items-center justify-between">
        <div className="inline-flex items-center gap-0.5 rounded-lg bg-[#EFEBE3] p-0.5">
          {viewOptions.map(({ id, label, icon: Icon }) => (
            <button
              key={id}
              type="button"
              onClick={() => selectView(id)}
              aria-pressed={view === id}
              className={`flex cursor-pointer items-center gap-1.5 rounded-md px-3 py-1.5 text-[12px] transition-colors ${
                view === id
                  ? "bg-white font-medium text-[#2C2C2A] shadow-sm"
                  : "text-[#888780] hover:text-[#2C2C2A]"
              }`}
            >
              <Icon className="h-3.5 w-3.5" />
              {label}
            </button>
          ))}
        </div>

        {/* New Idea lives in the header for non-stats views. When the project is
            empty the list renders its own centered CTA (with a New Idea button),
            so the header button is suppressed to avoid two. The switch itself
            always stays mounted and reachable, even at zero ideas. */}
        {view !== "stats" && !isEmpty && (
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

      {view === "stats" ? (
        <IdeaTrackerStats projectUuid={projectUuid} initialData={initialStatsData} />
      ) : (
        <IdeaTrackerList
          projectUuid={projectUuid}
          initialData={initialTrackerData}
          viewMode={view === "lineage" ? "tree" : "flat"}
          onIdeaClick={openPanel}
          onNewIdea={() => setShowNewIdeaDialog(true)}
          onEmptyChange={setIsEmpty}
        />
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
