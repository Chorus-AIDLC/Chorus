"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import { useTranslations, useLocale } from "next-intl";
import { useRouter } from "next/navigation";
import { X, Loader2, User, Trash2, ArrowRightLeft, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { usePanelUrl } from "@/hooks/use-panel-url";
import { useRealtimeEntityTypeEvent } from "@/contexts/realtime-context";
import { ElaborationView } from "./elaboration-view";
import { ProposalView, type ProposalData } from "./proposal-view";
import { OverviewTimeline } from "./overview-timeline";
import { TaskListView } from "./task-list-view";
import { ActivityCommentsView } from "./activity-comments-view";
import { TaskDetailPanel } from "@/app/(dashboard)/projects/[uuid]/tasks/task-detail-panel";
import { DocumentPanel } from "./document-panel";
import { MoveIdeaDialog } from "./move-idea-dialog";
import { deleteIdeaAction, updateIdeaAction } from "@/app/(dashboard)/projects/[uuid]/ideas/actions";
import { getIdeaAction, getTaskAction, getProposalsForIdeaAction, getTasksForProposalAction } from "./actions";
import { AssignIdeaModal } from "@/app/(dashboard)/projects/[uuid]/ideas/assign-idea-modal";
import type { IdeaResponse } from "@/services/idea.service";

type IdeaWithDerivedStatus = IdeaResponse & { derivedStatus: string; badgeHint: string | null };

// Task shape needed by TaskDetailPanel
interface TaskForPanel {
  uuid: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  storyPoints: number | null;
  acceptanceCriteria?: string | null;
  acceptanceCriteriaItems?: {
    uuid: string;
    description: string;
    required: boolean;
    devStatus: string;
    devEvidence: string | null;
    status: string;
    evidence: string | null;
    sortOrder: number;
  }[];
  acceptanceStatus?: string;
  acceptanceSummary?: {
    total: number;
    required: number;
    passed: number;
    failed: number;
    pending: number;
    requiredPassed: number;
    requiredFailed: number;
    requiredPending: number;
  };
  proposalUuid: string | null;
  assignee: {
    type: string;
    uuid: string;
    name: string;
    assignedAt: string | null;
    assignedBy: { type: string; uuid: string; name: string } | null;
  } | null;
  dependsOn?: { uuid: string; title: string; status: string }[];
  dependedBy?: { uuid: string; title: string; status: string }[];
}

import {
  DERIVED_STATUS_COLORS as derivedStatusColors,
  DERIVED_STATUS_I18N_KEYS as derivedStatusI18nKeys,
  BADGE_HINT_I18N_KEYS,
  type FlatTask,
} from "../utils";

// ===== Tab Types =====
type TabId = "overview" | "elaboration" | "proposal" | "tasks" | "activity";

function getVisibleTabs(
  idea: IdeaWithDerivedStatus,
  proposals: ProposalData[],
  tasks: FlatTask[],
): TabId[] {
  const tabs: TabId[] = ["overview"];
  if (idea.status !== "open") tabs.push("elaboration");
  if (proposals.length > 0) tabs.push("proposal");
  if (tasks.length > 0) tabs.push("tasks");
  tabs.push("activity");
  return tabs;
}

function getDefaultTab(badgeHint: string | null): TabId {
  switch (badgeHint) {
    case "open":
      return "overview";
    case "researching":
    case "answer_questions":
      return "elaboration";
    case "planning":
    case "review_proposal":
      return "proposal";
    case "building":
    case "verify_work":
      return "tasks";
    case "done":
      return "overview";
    default:
      return "overview";
  }
}

interface IdeaDetailPanelProps {
  ideaUuid: string;
  projectUuid: string;
  currentUserUuid: string;
  onClose: () => void;
}

export function IdeaDetailPanel({
  ideaUuid,
  projectUuid,
  currentUserUuid,
  onClose,
}: IdeaDetailPanelProps) {
  const t = useTranslations();
  const tTracker = useTranslations("ideaTracker");
  const tStatus = useTranslations("status");
  const locale = useLocale();
  const router = useRouter();

  // Core idea state
  const [idea, setIdea] = useState<IdeaWithDerivedStatus | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Top-level data: proposals and tasks
  const [proposals, setProposals] = useState<ProposalData[]>([]);
  const [tasks, setTasks] = useState<FlatTask[]>([]);

  // Tab state
  const [activeTab, setActiveTab] = useState<TabId>("overview");
  const [visitedTabs, setVisitedTabs] = useState<Set<TabId>>(new Set(["overview"]));
  const [userHasSwitchedTab, setUserHasSwitchedTab] = useState(false);

  // Comment count for activity badge
  const [commentCount, setCommentCount] = useState(0);

  // Footer/modal state
  const [showAssignModal, setShowAssignModal] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  // Edit mode state
  const [isEditing, setIsEditing] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [editContent, setEditContent] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  // Move dialog state
  const [showMoveDialog, setShowMoveDialog] = useState(false);

  // Child panel state
  const [selectedTaskUuid, setSelectedTaskUuid] = useState<string | null>(null);
  const [selectedTask, setSelectedTask] = useState<TaskForPanel | null>(null);
  const [selectedDoc, setSelectedDoc] = useState<{ title: string; type: string; content: string } | null>(null);

  // Slide-in animation
  const [hasAnimated, setHasAnimated] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setHasAnimated(true), 300);
    return () => clearTimeout(timer);
  }, []);

  usePanelUrl(`/projects/${projectUuid}/dashboard`, ideaUuid);

  // Fetch single idea
  const fetchIdea = useCallback(async () => {
    try {
      const result = await getIdeaAction(ideaUuid);
      if (result.success) {
        setIdea(result.data);
        setError(null);
      } else {
        setError(tTracker(result.error === "Not found" ? "panel.notFound" : "panel.loadFailed"));
      }
    } catch {
      setError(tTracker("panel.loadFailed"));
    } finally {
      setIsLoading(false);
    }
  }, [ideaUuid, tTracker]);

  useEffect(() => {
    setIsLoading(true);
    fetchIdea();
  }, [fetchIdea]);

  useRealtimeEntityTypeEvent("idea", fetchIdea);

  // ===== Lift data fetching: Proposals =====
  const ideaUuidForFetch = idea?.uuid;
  const ideaStatusForFetch = idea?.status;
  const fetchProposals = useCallback(async () => {
    if (!ideaUuidForFetch || ideaStatusForFetch === "open") {
      setProposals([]);
      return;
    }
    try {
      const result = await getProposalsForIdeaAction(projectUuid, ideaUuidForFetch);
      if (result.success) {
        setProposals(result.data);
      }
    } catch (e) {
      console.error("Failed to fetch proposals:", e);
    }
  }, [projectUuid, ideaUuidForFetch, ideaStatusForFetch]);

  useEffect(() => {
    fetchProposals();
  }, [fetchProposals]);

  useRealtimeEntityTypeEvent("proposal", fetchProposals);

  // ===== Lift data fetching: Tasks (from approved proposals) =====
  const fetchTasks = useCallback(async () => {
    const approvedProposals = proposals.filter((p) => p.status === "approved");
    if (approvedProposals.length === 0) {
      setTasks([]);
      return;
    }
    try {
      const results = await Promise.all(
        approvedProposals.map((p) => getTasksForProposalAction(projectUuid, p.uuid))
      );
      const allTasks: FlatTask[] = results.flatMap((result) =>
        result.success && result.data
          ? result.data.map((t) => ({
              uuid: t.uuid,
              title: t.title,
              status: t.status,
              commentCount: (t as { commentCount?: number }).commentCount ?? 0,
            }))
          : []
      );
      setTasks(allTasks);
    } catch (e) {
      console.error("Failed to fetch tasks:", e);
    }
  }, [projectUuid, proposals]);

  useEffect(() => {
    fetchTasks();
  }, [fetchTasks]);

  useRealtimeEntityTypeEvent("task", fetchTasks);

  // ===== Tab visibility & default =====
  const visibleTabs = useMemo(
    () => (idea ? getVisibleTabs(idea, proposals, tasks) : ["overview" as TabId, "activity" as TabId]),
    [idea, proposals, tasks],
  );

  // Auto-select default tab when idea loads/changes or when visible tabs update,
  // unless user has manually switched
  const desiredTab = idea ? getDefaultTab(idea.badgeHint) : "overview";
  useEffect(() => {
    if (!idea || userHasSwitchedTab) return;
    // Wait until the desired tab becomes visible (proposals/tasks may load async)
    const tab = visibleTabs.includes(desiredTab) ? desiredTab : "overview";
    setActiveTab(tab);
    setVisitedTabs((prev) => new Set([...prev, tab]));
    // Intentionally omitting userHasSwitchedTab — it's checked inside but shouldn't trigger re-runs
  }, [idea?.uuid, desiredTab, visibleTabs]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reset user switch flag when idea changes
  useEffect(() => {
    setUserHasSwitchedTab(false);
  }, [ideaUuid]);

  // Ensure active tab is still visible (e.g., tasks cleared)
  useEffect(() => {
    if (!visibleTabs.includes(activeTab)) {
      setActiveTab("overview");
    }
  }, [visibleTabs, activeTab]);

  const handleTabChange = (tab: TabId) => {
    setActiveTab(tab);
    setUserHasSwitchedTab(true);
    setVisitedTabs((prev) => new Set([...prev, tab]));
  };

  // ===== Badge counts =====
  const activeTaskCount = useMemo(
    () => tasks.filter((t) => t.status === "in_progress" || t.status === "assigned" || t.status === "to_verify").length,
    [tasks],
  );

  // Fetch task when selected from any tab view
  useEffect(() => {
    if (!selectedTaskUuid) {
      setSelectedTask(null);
      return;
    }
    getTaskAction(selectedTaskUuid).then((result) => {
      if (result.success) setSelectedTask(result.data);
    }).catch((e) => console.error("Failed to load task details:", e));
  }, [selectedTaskUuid]);

  // Reset edit state when idea changes
  useEffect(() => {
    setIsEditing(false);
    setEditTitle(idea?.title || "");
    setEditContent(idea?.content || "");
    setEditError(null);
  }, [idea?.uuid, idea?.title, idea?.content]);

  const handleStartEdit = () => {
    if (!idea) return;
    setEditTitle(idea.title);
    setEditContent(idea.content || "");
    setEditError(null);
    setIsEditing(true);
  };

  const handleCancelEdit = () => {
    setIsEditing(false);
    setEditTitle(idea?.title || "");
    setEditContent(idea?.content || "");
    setEditError(null);
  };

  const handleSaveEdit = async () => {
    if (!idea || !editTitle.trim()) {
      setEditError(t("ideas.titleRequired"));
      return;
    }

    setIsSaving(true);
    setEditError(null);

    const result = await updateIdeaAction({
      ideaUuid: idea.uuid,
      projectUuid,
      title: editTitle.trim(),
      content: editContent.trim() || null,
    });

    setIsSaving(false);

    if (result.success) {
      setIsEditing(false);
      await fetchIdea();
      router.refresh();
    } else {
      setEditError(result.error || t("ideas.updateFailed"));
    }
  };

  const handleDelete = async () => {
    if (!idea) return;
    setIsDeleting(true);
    const result = await deleteIdeaAction(idea.uuid, projectUuid);
    setIsDeleting(false);
    if (result.success) {
      onClose();
      router.refresh();
    }
  };

  const status = idea?.derivedStatus || "todo";
  const canAssign = idea ? idea.status !== "elaborated" : false;
  const elaborationResolved = idea?.elaborationStatus === "resolved";
  const showHelpText = idea?.status === "elaborating" && !elaborationResolved;

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40 bg-black/20"
        onClick={onClose}
      />

      {/* Panel */}
      <div
        className={`fixed right-0 top-14 md:top-0 z-50 flex h-[calc(100%-3.5rem)] md:h-full w-full md:w-[480px] flex-col bg-white shadow-xl border-l border-[#E5E0D8] ${
          hasAnimated ? "" : "animate-in slide-in-from-right duration-300"
        }`}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-[#F5F2EC] px-6 py-5">
          <div className="flex-1 min-w-0">
            {isLoading ? (
              <div className="h-5 w-40 animate-pulse rounded bg-[#F5F2EC]" />
            ) : idea ? (
              isEditing ? (
                <h2 className="text-base font-semibold text-[#2C2C2C]">
                  {t("ideas.editIdea")}
                </h2>
              ) : (
                <>
                  <h2 className="text-base font-semibold text-[#2C2C2C] truncate">
                    {idea.title}
                  </h2>
                  <div className="mt-1.5 flex items-center gap-2">
                    <Badge
                      className={
                        derivedStatusColors[status] || derivedStatusColors.todo
                      }
                    >
                      {idea.badgeHint
                        ? tTracker(`badge.${BADGE_HINT_I18N_KEYS[idea.badgeHint] || "open"}`)
                        : tStatus(derivedStatusI18nKeys[status] || "todo")}
                    </Badge>
                    <span className="text-xs text-[#9A9A9A]">
                      {new Date(idea.createdAt).toLocaleDateString(locale)}
                    </span>
                  </div>
                </>
              )
            ) : (
              <h2 className="text-base font-semibold text-[#2C2C2C]">
                {tTracker("panel.notFound")}
              </h2>
            )}
          </div>

          <div className="flex items-center gap-2 ml-4">
            {idea && idea.status !== "elaborated" && !isEditing && (
              <>
                <Button
                  variant="outline"
                  size="icon"
                  className="h-8 w-8 border-[#E5E0D8]"
                  onClick={() => setShowMoveDialog(true)}
                  title={t("ideas.moveToProject")}
                >
                  <ArrowRightLeft className="h-4 w-4 text-[#6B6B6B]" />
                </Button>
                <Button
                  variant="outline"
                  size="icon"
                  className="h-8 w-8 border-[#E5E0D8]"
                  onClick={handleStartEdit}
                  title={t("ideas.editIdea")}
                >
                  <Pencil className="h-4 w-4 text-[#6B6B6B]" />
                </Button>
              </>
            )}
            <Button
              variant="outline"
              size="icon"
              className="h-8 w-8 border-[#E5E0D8]"
              onClick={isEditing ? handleCancelEdit : onClose}
            >
              <X className="h-4 w-4 text-[#6B6B6B]" />
            </Button>
          </div>
        </div>

        {/* Tab Bar */}
        {idea && !isLoading && !isEditing && (
          <div className="border-b border-[#F5F2EC] px-6">
            <div className="flex gap-0 -mb-px">
              {visibleTabs.map((tab) => (
                <button
                  key={tab}
                  onClick={() => handleTabChange(tab)}
                  className={`relative flex items-center gap-1.5 px-3 py-2.5 text-[13px] font-medium transition-colors ${
                    activeTab === tab
                      ? "text-[#C67A52] border-b-2 border-[#C67A52]"
                      : "text-[#9A9A9A] hover:text-[#6B6B6B]"
                  }`}
                >
                  {tTracker(`panel.tabs.${tab}`)}
                  {tab === "tasks" && activeTaskCount > 0 && (
                    <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-[#E3F2FD] text-[#1976D2] text-[10px] font-semibold leading-none">
                      {activeTaskCount}
                    </span>
                  )}
                  {tab === "activity" && commentCount > 0 && (
                    <span className="inline-flex items-center justify-center min-w-[18px] h-[18px] px-1 rounded-full bg-[#F5F2EC] text-[#6B6B6B] text-[10px] font-semibold leading-none">
                      {commentCount}
                    </span>
                  )}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Body */}
        <ScrollArea className="flex-1 min-h-0 [&_[data-slot=scroll-area-viewport]>div]:!block">
          <div className="flex min-h-full flex-col px-6 py-5">
            {isLoading ? (
              <div className="flex flex-1 items-center justify-center py-12">
                <Loader2 className="h-6 w-6 animate-spin text-[#C67A52]" />
                <span className="ml-2 text-sm text-[#9A9A9A]">
                  {tTracker("loading")}
                </span>
              </div>
            ) : error ? (
              <div className="flex flex-1 items-center justify-center py-12">
                <p className="text-sm text-[#9A9A9A]">{error}</p>
              </div>
            ) : idea ? (
              isEditing ? (
                <div className="space-y-5">
                  {editError && (
                    <div className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
                      {editError}
                    </div>
                  )}

                  <div className="space-y-2">
                    <Label htmlFor="edit-title" className="text-[13px] font-medium text-[#2C2C2C]">
                      {t("ideas.titleLabel")}
                    </Label>
                    <Input
                      id="edit-title"
                      value={editTitle}
                      onChange={(e) => setEditTitle(e.target.value)}
                      className="border-[#E5E0D8] text-sm focus-visible:ring-[#C67A52]"
                      autoFocus
                    />
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="edit-content" className="text-[13px] font-medium text-[#2C2C2C]">
                      {t("common.content")}
                    </Label>
                    <Textarea
                      id="edit-content"
                      value={editContent}
                      onChange={(e) => setEditContent(e.target.value)}
                      rows={8}
                      className="border-[#E5E0D8] text-sm resize-none focus-visible:ring-[#C67A52]"
                    />
                  </div>
                </div>
              ) : (
                /* Tab Content with visitedTabs caching */
                <>
                  {/* Overview Tab */}
                  {visitedTabs.has("overview") && (
                    <div style={{ display: activeTab === "overview" ? "block" : "none" }}>
                      <OverviewTimeline
                        idea={idea}
                        proposals={proposals}
                        tasks={tasks}
                        onSelectTask={setSelectedTaskUuid}
                      />
                    </div>
                  )}

                  {/* Elaboration Tab */}
                  {visibleTabs.includes("elaboration") && visitedTabs.has("elaboration") && (
                    <div style={{ display: activeTab === "elaboration" ? "block" : "none" }}>
                      <ElaborationView
                        idea={idea}
                        onRefresh={fetchIdea}
                      />
                    </div>
                  )}

                  {/* Proposal Tab */}
                  {visibleTabs.includes("proposal") && visitedTabs.has("proposal") && (
                    <div style={{ display: activeTab === "proposal" ? "block" : "none" }}>
                      <ProposalView
                        idea={idea}
                        projectUuid={projectUuid}
                        onTaskClick={setSelectedTaskUuid}
                        onDocClick={setSelectedDoc}
                        initialProposals={proposals}
                      />
                    </div>
                  )}

                  {/* Tasks Tab */}
                  {visibleTabs.includes("tasks") && visitedTabs.has("tasks") && (
                    <div style={{ display: activeTab === "tasks" ? "block" : "none" }}>
                      <TaskListView
                        tasks={tasks}
                        onSelectTask={setSelectedTaskUuid}
                      />
                    </div>
                  )}

                  {/* Activity Tab */}
                  {visitedTabs.has("activity") && (
                    <div style={{ display: activeTab === "activity" ? "block" : "none" }}>
                      <ActivityCommentsView
                        ideaUuid={idea.uuid}
                        currentUserUuid={currentUserUuid}
                        commentCount={commentCount}
                        onCommentCountChange={setCommentCount}
                      />
                    </div>
                  )}
                </>
              )
            ) : null}
          </div>
        </ScrollArea>

        {/* Footer */}
        {idea && !isLoading && (
          <div className="border-t border-[#F5F2EC] px-6 py-4">
            {isEditing ? (
              <div className="flex items-center justify-end gap-3">
                <Button
                  variant="outline"
                  className="border-[#E5E0D8]"
                  onClick={handleCancelEdit}
                  disabled={isSaving}
                >
                  {t("common.cancel")}
                </Button>
                <Button
                  className="bg-[#C67A52] hover:bg-[#B56A42] text-white"
                  onClick={handleSaveEdit}
                  disabled={isSaving || !editTitle.trim()}
                >
                  {isSaving ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      {t("common.save")}
                    </>
                  ) : (
                    t("common.save")
                  )}
                </Button>
              </div>
            ) : (
              <div className="flex items-center justify-between gap-3">
                {canAssign && (
                  <Button
                    variant="outline"
                    className="shrink-0 border-[#E5E0D8] rounded-md px-4 py-2 text-[13px] font-medium"
                    onClick={() => setShowAssignModal(true)}
                  >
                    <User className="mr-2 h-4 w-4" />
                    {idea.assignee ? t("common.reassign") : t("common.assign")}
                  </Button>
                )}
                <div className="flex-1 min-w-0">
                  {showHelpText && (
                    <span className="text-[11px] text-[#9A9A9A]">
                      {t("elaboration.elaborationRequiredHint")}
                    </span>
                  )}
                </div>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button
                      variant="outline"
                      size="icon"
                      className="shrink-0 h-8 w-8 border-[#E5E0D8] text-[#EF4444] hover:bg-[#FFEBEE] hover:text-[#EF4444] hover:border-[#EF4444]"
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>{t("ideas.deleteIdea")}</AlertDialogTitle>
                      <AlertDialogDescription>
                        {t("ideas.deleteIdeaConfirm", { title: idea.title })}
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
                      <AlertDialogAction
                        variant="destructive"
                        onClick={handleDelete}
                        disabled={isDeleting}
                      >
                        {isDeleting ? (
                          <>
                            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                            {t("common.delete")}
                          </>
                        ) : (
                          t("common.delete")
                        )}
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Move to Project Dialog */}
      <MoveIdeaDialog
        open={showMoveDialog}
        onOpenChange={setShowMoveDialog}
        ideaUuid={ideaUuid}
        projectUuid={projectUuid}
        onMoved={onClose}
      />

      {/* Assign Idea Modal */}
      {showAssignModal && idea && (
        <AssignIdeaModal
          idea={{
            uuid: idea.uuid,
            title: idea.title,
            content: idea.content,
            status: idea.status,
            assignee: idea.assignee ? { type: idea.assignee.type, uuid: idea.assignee.uuid, name: idea.assignee.name } : null,
          }}
          projectUuid={projectUuid}
          currentUserUuid={currentUserUuid}
          onClose={() => {
            setShowAssignModal(false);
            fetchIdea();
          }}
        />
      )}

      {/* Task Detail Panel */}
      {selectedTaskUuid && selectedTask && (
        <TaskDetailPanel
          task={selectedTask}
          projectUuid={projectUuid}
          currentUserUuid={currentUserUuid}
          onClose={() => {
            setSelectedTaskUuid(null);
            setSelectedTask(null);
          }}
          onBack={() => {
            setSelectedTaskUuid(null);
            setSelectedTask(null);
          }}
        />
      )}

      {/* Document Panel */}
      {selectedDoc && (
        <DocumentPanel
          title={selectedDoc.title}
          type={selectedDoc.type}
          content={selectedDoc.content}
          onClose={() => setSelectedDoc(null)}
          onBack={() => setSelectedDoc(null)}
        />
      )}
    </>
  );
}
