"use client";

import { useState, useEffect, useCallback, useMemo, useRef } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { X, Loader2, User, Trash2, ArrowRightLeft, Pencil, GitFork, CornerLeftUp, CornerDownRight, CheckCircle2 } from "lucide-react";
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
import { PresenceIndicator } from "@/components/ui/presence-indicator";
import { useRealtimeEntityTypeEvent } from "@/contexts/realtime-context";
import { ElaborationView } from "./elaboration-view";
import { ProposalView, type ProposalData } from "./proposal-view";
import { OverviewTimeline } from "./overview-timeline";
import { ReportsList } from "./reports-list";
import { TaskListView } from "./task-list-view";
import { ActivityCommentsView } from "./activity-comments-view";
import { TaskDetailPanel } from "@/app/(dashboard)/projects/[uuid]/tasks/task-detail-panel";
import { DocumentPanel } from "./document-panel";
import { MoveIdeaDialog } from "./move-idea-dialog";
import { SetParentDialog } from "./set-parent-dialog";
import { NewIdeaDialog } from "../new-idea-dialog";
import { deleteIdeaAction, updateIdeaAction } from "@/app/(dashboard)/projects/[uuid]/ideas/actions";
import { getIdeaAction, getTaskAction, getProposalsForIdeaAction, getTasksForProposalAction } from "./actions";
import { getElaborationAction, verifyElaborationAction } from "@/app/(dashboard)/projects/[uuid]/ideas/[ideaUuid]/elaboration-actions";
import { AssignIdeaModal } from "@/app/(dashboard)/projects/[uuid]/ideas/assign-idea-modal";
import type { IdeaResponse } from "@/services/idea.service";
import type { ElaborationResponse } from "@/types/elaboration";
import { canVerifyElaboration } from "@/lib/elaboration-verify";
import { clientLogger } from "@/lib/logger-client";
import { formatDateTime } from "@/lib/format-date";

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
  tabs.push("elaboration");
  if (proposals.length > 0) tabs.push("proposal");
  if (tasks.length > 0) tabs.push("tasks");
  tabs.push("activity");
  return tabs;
}

function getDefaultTab(badgeHint: string | null): TabId {
  switch (badgeHint) {
    case "open":
      return "elaboration";
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
  // Switch the open panel to another idea (lineage parent/child, post-derive).
  // Wired to the parent's usePanelUrl.openPanel so the panel actually re-renders
  // for the new idea — a bare router.push of ?panel= changes the URL but not the
  // hook's selectedId state, so the panel would never switch.
  onNavigate?: (ideaUuid: string) => void;
}

export function IdeaDetailPanel({
  ideaUuid,
  projectUuid,
  currentUserUuid,
  onClose,
  onNavigate,
}: IdeaDetailPanelProps) {
  const t = useTranslations();
  const tTracker = useTranslations("ideaTracker");
  const tStatus = useTranslations("status");
  const tLineage = useTranslations("ideaTracker.lineage");
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

  // Elaboration data — loaded once here and shared between the elaboration tab
  // view and the footer's "Verify Elaborate" gate (no separate fetch each).
  const [elaboration, setElaboration] = useState<ElaborationResponse | null>(null);
  const [isLoadingElaboration, setIsLoadingElaboration] = useState(true);

  // Verify elaboration state
  const [isVerifying, setIsVerifying] = useState(false);
  const [verifyError, setVerifyError] = useState<string | null>(null);
  const [verified, setVerified] = useState(false);

  // Edit mode state
  const [isEditing, setIsEditing] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [editContent, setEditContent] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  // Move dialog state
  const [showMoveDialog, setShowMoveDialog] = useState(false);
  const [showSetParentDialog, setShowSetParentDialog] = useState(false);
  const [showDeriveDialog, setShowDeriveDialog] = useState(false);

  // Child panel state — only one secondary panel at a time
  const [selectedTaskUuid, setSelectedTaskUuid] = useState<string | null>(null);
  const [selectedTask, setSelectedTask] = useState<TaskForPanel | null>(null);
  const [selectedDoc, setSelectedDoc] = useState<{ title: string; type: string; content: string } | null>(null);

  const openTask = useCallback((taskUuid: string) => {
    setSelectedDoc(null); // Close doc panel when opening task
    setSelectedTaskUuid(taskUuid);
  }, []);

  const openDoc = useCallback((doc: { title: string; type: string; content: string }) => {
    setSelectedTaskUuid(null); // Close task panel when opening doc
    setSelectedTask(null);
    setSelectedDoc(doc);
  }, []);

  // Wide screen detection for side-by-side panels
  const [isWideScreen, setIsWideScreen] = useState(false);
  useEffect(() => {
    const mql = window.matchMedia("(min-width: 960px)");
    setIsWideScreen(mql.matches);
    const handler = (e: MediaQueryListEvent) => setIsWideScreen(e.matches);
    mql.addEventListener("change", handler);
    return () => mql.removeEventListener("change", handler);
  }, []);

  // Slide-in animation
  const [hasAnimated, setHasAnimated] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setHasAnimated(true), 300);
    return () => clearTimeout(timer);
  }, []);

  // Sync tab to URL query param (replaceState only, no history entry)
  const switchTab = useCallback((tab: string) => {
    const params = new URLSearchParams(window.location.search);
    params.set("tab", tab);
    window.history.replaceState(null, "", `${window.location.pathname}?${params.toString()}`);
  }, []);

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
  // Derived status depends on proposal/task state — refetch idea when they change
  useRealtimeEntityTypeEvent("proposal", fetchIdea);
  useRealtimeEntityTypeEvent("task", fetchIdea);

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
      clientLogger.error("Failed to fetch proposals:", e);
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
          ? result.data.map((t) => {
              const task = t as {
                uuid: string;
                title: string;
                status: string;
                commentCount?: number;
                assignee?: { type: string; uuid: string; name: string } | null;
                acceptanceSummary?: FlatTask["acceptanceSummary"];
              };
              return {
                uuid: task.uuid,
                title: task.title,
                status: task.status,
                commentCount: task.commentCount ?? 0,
                assignee: task.assignee ?? null,
                acceptanceSummary: task.acceptanceSummary ?? null,
              };
            })
          : []
      );
      setTasks(allTasks);
    } catch (e) {
      clientLogger.error("Failed to fetch tasks:", e);
    }
  }, [projectUuid, proposals]);

  useEffect(() => {
    fetchTasks();
  }, [fetchTasks]);

  useRealtimeEntityTypeEvent("task", fetchTasks);

  // ===== Lift data fetching: Elaboration (shared by tab view + verify gate) =====
  const fetchElaboration = useCallback(async () => {
    if (!ideaUuidForFetch) return;
    const result = await getElaborationAction(ideaUuidForFetch);
    if (result.success && result.data) {
      setElaboration(result.data);
    }
    setIsLoadingElaboration(false);
  }, [ideaUuidForFetch]);

  useEffect(() => {
    fetchElaboration();
  }, [fetchElaboration]);

  useRealtimeEntityTypeEvent("idea", fetchElaboration);

  // ===== Tab visibility & default =====
  const visibleTabs = useMemo(
    () => (idea ? getVisibleTabs(idea, proposals, tasks) : ["overview" as TabId, "activity" as TabId]),
    [idea, proposals, tasks],
  );

  // Read initial tab from URL (if present and valid) — consumed once on first auto-select
  const urlTabRef = useRef<string | null>(
    typeof window !== "undefined"
      ? new URLSearchParams(window.location.search).get("tab")
      : null
  );

  // Auto-select default tab when idea loads/changes or when visible tabs update,
  // unless user has manually switched
  const desiredTab = idea ? getDefaultTab(idea.badgeHint) : "overview";
  useEffect(() => {
    if (!idea || userHasSwitchedTab) return;
    const urlTab = urlTabRef.current;
    let tab: TabId;
    if (urlTab) {
      if (visibleTabs.includes(urlTab as TabId)) {
        // URL tab is now visible — use it, consume the ref, and lock selection
        tab = urlTab as TabId;
        urlTabRef.current = null;
        setUserHasSwitchedTab(true); // Prevent subsequent auto-routing from overriding
      } else {
        // URL tab not yet visible — don't consume, wait for next visibleTabs update
        return;
      }
    } else {
      if (visibleTabs.includes(desiredTab)) {
        tab = desiredTab;
      } else if (desiredTab === "overview") {
        tab = "overview";
      } else {
        // Desired tab not yet visible (data loading) — wait instead of flashing "overview"
        return;
      }
    }
    setActiveTab(tab);
    setVisitedTabs((prev) => new Set([...prev, tab]));
    switchTab(tab); // Sync URL with auto-selected tab
    // Intentionally omitting userHasSwitchedTab and switchTab — checked/used inside but shouldn't trigger re-runs
  }, [idea?.uuid, desiredTab, visibleTabs]); // eslint-disable-line react-hooks/exhaustive-deps

  // Reset user switch flag only when switching to a different idea
  // (badgeHint changes mid-view should NOT yank the user to a different tab)
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
    switchTab(tab);
  };

  // ===== Badge counts =====
  const activeTaskCount = useMemo(
    () => tasks.filter((t) => t.status === "in_progress" || t.status === "assigned" || t.status === "to_verify").length,
    [tasks],
  );

  // Fetch task when selected from any tab view
  const fetchSelectedTask = useCallback(() => {
    if (!selectedTaskUuid) {
      setSelectedTask(null);
      return;
    }
    getTaskAction(selectedTaskUuid).then((result) => {
      if (result.success) setSelectedTask(result.data);
    }).catch((e) => clientLogger.error("Failed to load task details:", e));
  }, [selectedTaskUuid]);

  useEffect(() => {
    fetchSelectedTask();
  }, [fetchSelectedTask]);

  // Re-fetch selected task on SSE task events (status changes, AC updates, etc.)
  useRealtimeEntityTypeEvent("task", fetchSelectedTask);

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

  // After the derive dialog creates the child, switch the panel to it.
  // router.refresh() repaints the underlying tree/list with the new edge;
  // onNavigate (the parent's openPanel) is what actually swaps the open panel —
  // a bare router.push of ?panel= changes the URL but not the hook's state.
  const handleDerived = (childUuid: string) => {
    toast.success(tLineage("deriveIdea"));
    router.refresh();
    onNavigate?.(childUuid);
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

  const handleVerify = async () => {
    if (!idea) return;
    setIsVerifying(true);
    setVerifyError(null);

    const result = await verifyElaborationAction(idea.uuid);

    setIsVerifying(false);

    if (result.success) {
      // Idea → elaborated; derived display status becomes `planning` and the
      // assigned daemon agent is woken (or backfilled when offline) to write
      // the proposal. Agent liveness isn't known client-side, so a single
      // queued hint covers both online + offline.
      setVerified(true);
      await fetchIdea();
      router.refresh();
    } else {
      setVerifyError(result.error || t("elaboration.verifyFailed"));
    }
  };

  const status = idea?.derivedStatus || "todo";
  const canAssign = idea ? idea.status !== "elaborated" : false;
  const elaborationResolved = idea?.elaborationStatus === "resolved";
  // Shared enable-predicate (same helper as the /ideas idea-detail panel) so
  // the two surfaces never drift.
  const canVerify = canVerifyElaboration({
    ideaStatus: idea?.status,
    elaborationStatus: idea?.elaborationStatus,
    elaboration,
  });
  const showHelpText =
    idea?.status === "elaborating" && !elaborationResolved && !canVerify && !verified;

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
                      {formatDateTime(idea.createdAt)}
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
            {idea && !isEditing && (
              <Button
                variant="outline"
                size="sm"
                className="h-8 gap-1.5 border-[#E5E0D8] px-2.5"
                onClick={() => setShowDeriveDialog(true)}
                title={tLineage("deriveIdea")}
                aria-label={tLineage("deriveIdea")}
              >
                <GitFork className="h-3.5 w-3.5 text-[#C67A52]" />
                <span className="text-[12px] font-medium text-[#C67A52]">{tLineage("derive")}</span>
              </Button>
            )}
            {idea && !isEditing && (
              <Button
                variant="outline"
                size="icon"
                className="h-8 w-8 border-[#E5E0D8]"
                onClick={() => setShowMoveDialog(true)}
                title={t("ideas.actions.move")}
                aria-label={t("ideas.actions.move")}
              >
                <ArrowRightLeft className="h-4 w-4 text-[#6B6B6B]" />
              </Button>
            )}
            {idea && idea.status !== "elaborated" && !isEditing && (
              <Button
                variant="outline"
                size="icon"
                className="h-8 w-8 border-[#E5E0D8]"
                onClick={handleStartEdit}
                title={t("ideas.editIdea")}
              >
                <Pencil className="h-4 w-4 text-[#6B6B6B]" />
              </Button>
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
                  className={`relative flex items-center gap-1.5 px-3 py-2.5 text-[13px] font-medium transition-colors cursor-pointer ${
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
                        onSelectTask={openTask}
                      />

                      {/* Lineage section — parent breadcrumb + set-parent + derived children */}
                      <div className="mt-5 space-y-2">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-1.5">
                            <GitFork className="h-3.5 w-3.5 text-[#C67A52]" />
                            <span className="text-[12px] font-semibold text-[#5F5E5A]">{tLineage("title")}</span>
                          </div>
                          <Button
                            variant="outline"
                            size="sm"
                            className="h-7 gap-1 border-[#E5E0D8] px-2 text-[11px] text-[#6B6B6B]"
                            onClick={() => setShowSetParentDialog(true)}
                          >
                            <Pencil className="h-3 w-3" />
                            {idea.parentUuid ? tLineage("changeParent") : tLineage("setParent")}
                          </Button>
                        </div>

                        {/* Parent breadcrumb */}
                        {idea.parent ? (
                          <button
                            type="button"
                            onClick={() => onNavigate?.(idea.parent!.uuid)}
                            className="flex w-full items-center gap-2 rounded-lg bg-[#FAF8F4] px-3 py-2.5 text-left transition-colors hover:bg-[#F5F2EC]"
                          >
                            <CornerLeftUp className="h-3.5 w-3.5 shrink-0 text-[#888780]" />
                            <span className="shrink-0 text-[12px] text-[#888780]">{tLineage("derivedFrom")}</span>
                            {/* min-w-0 flex-1 so a long parent title truncates
                                instead of stretching the breadcrumb past the panel. */}
                            <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-[#5F5E5A]">{idea.parent.title}</span>
                          </button>
                        ) : (
                          <p className="px-1 text-[12px] text-[#A8A498]">{tLineage("noParent")}</p>
                        )}

                        {/* Derived children list */}
                        {idea.children && idea.children.length > 0 && (
                          <>
                            <div className="flex items-center gap-1.5 px-1 pt-1">
                              <span className="text-[12px] font-medium text-[#5F5E5A]">{tLineage("derivedIdeas")}</span>
                              <span className="text-[11px] text-[#888780]">{idea.children.length}</span>
                            </div>
                            <div className="overflow-hidden rounded-lg border border-[#EFEBE3]">
                              {idea.children.map((child, idx) => (
                                <div key={child.uuid}>
                                  {idx > 0 && <div className="h-px bg-[#F0EEEA]" />}
                                  <button
                                    type="button"
                                    onClick={() => onNavigate?.(child.uuid)}
                                    className="flex w-full items-center justify-between gap-2 px-3 py-2.5 text-left transition-colors hover:bg-[#FAF8F4]"
                                  >
                                    <span className="flex min-w-0 items-center gap-2">
                                      <CornerDownRight className="h-3.5 w-3.5 shrink-0 text-[#C2BDB2]" />
                                      <span className="truncate text-[12px] text-[#2C2C2A]">{child.title}</span>
                                    </span>
                                    <Badge className={`shrink-0 border-0 text-[10px] ${derivedStatusColors[child.derivedStatus] || derivedStatusColors.todo}`}>
                                      {tStatus(derivedStatusI18nKeys[child.derivedStatus] || "todo")}
                                    </Badge>
                                  </button>
                                </div>
                              ))}
                            </div>
                          </>
                        )}
                      </div>

                      <ReportsList
                        projectUuid={projectUuid}
                        ideaUuid={idea.uuid}
                        proposals={proposals}
                        onDocClick={openDoc}
                      />
                    </div>
                  )}

                  {/* Elaboration Tab */}
                  {visibleTabs.includes("elaboration") && visitedTabs.has("elaboration") && (
                    <div style={{ display: activeTab === "elaboration" ? "block" : "none" }}>
                      <ElaborationView
                        idea={idea}
                        elaboration={elaboration}
                        isLoading={isLoadingElaboration}
                        onRefresh={async () => {
                          await fetchElaboration();
                          await fetchIdea();
                        }}
                      />
                    </div>
                  )}

                  {/* Proposal Tab */}
                  {visibleTabs.includes("proposal") && visitedTabs.has("proposal") && (
                    <div style={{ display: activeTab === "proposal" ? "block" : "none" }}>
                      <ProposalView
                        idea={idea}
                        projectUuid={projectUuid}
                        onTaskClick={openTask}
                        onDocClick={openDoc}
                        initialProposals={proposals}
                      />
                    </div>
                  )}

                  {/* Tasks Tab */}
                  {visibleTabs.includes("tasks") && visitedTabs.has("tasks") && (
                    <div style={{ display: activeTab === "tasks" ? "block" : "none" }}>
                      <TaskListView
                        tasks={tasks}
                        projectUuid={projectUuid}
                        proposalUuids={proposals.filter((p) => p.status === "approved").map((p) => p.uuid)}
                        onSelectTask={openTask}
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
                <div className="flex-1 min-w-0 flex flex-wrap items-center gap-2">
                  {/* Verify Elaborate — human "elaboration confirmed, agent
                      writes the proposal" action, gated by the shared
                      predicate. No manual create-proposal fallback here. */}
                  {canVerify && !verified && (
                    <Button
                      className="bg-[#C67A52] hover:bg-[#B56A42] text-white"
                      onClick={handleVerify}
                      disabled={isVerifying}
                    >
                      {isVerifying ? (
                        <>
                          <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                          {t("elaboration.verifying")}
                        </>
                      ) : (
                        <>
                          <CheckCircle2 className="mr-2 h-4 w-4" />
                          {t("elaboration.verifyButton")}
                        </>
                      )}
                    </Button>
                  )}
                  {verified && (
                    <span className="text-[11px] text-[#00796B]">
                      {t("elaboration.verifiedQueuedHint")}
                    </span>
                  )}
                  {verifyError && (
                    <span className="text-[11px] text-destructive">{verifyError}</span>
                  )}
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
        onMoved={() => onClose()}
      />

      {/* Set Parent (lineage) Dialog */}
      {idea && (
        <SetParentDialog
          open={showSetParentDialog}
          onOpenChange={setShowSetParentDialog}
          ideaUuid={idea.uuid}
          ideaTitle={idea.title}
          projectUuid={projectUuid}
          currentParentUuid={idea.parentUuid ?? null}
          descendantUuids={idea.descendantUuids ?? []}
          onChanged={fetchIdea}
        />
      )}

      {/* Derive child idea — reuses the create-idea dialog, scoped to this parent */}
      {idea && (
        <NewIdeaDialog
          open={showDeriveDialog}
          onOpenChange={setShowDeriveDialog}
          projectUuid={projectUuid}
          parentUuid={idea.uuid}
          parentTitle={idea.title}
          onCreated={handleDerived}
        />
      )}

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
          mode={isWideScreen ? "sidebyside" : "overlay"}
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
          mode={isWideScreen ? "sidebyside" : "overlay"}
          onClose={() => setSelectedDoc(null)}
          onBack={() => setSelectedDoc(null)}
        />
      )}
    </>
  );
}
