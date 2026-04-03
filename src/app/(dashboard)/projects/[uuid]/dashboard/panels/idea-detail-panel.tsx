"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { X, Loader2, Bot, User, Send, Trash2, ArrowRightLeft, Pencil, Check } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { usePanelUrl } from "@/hooks/use-panel-url";
import { useRealtimeEvent, useRealtimeEntityEvent } from "@/contexts/realtime-context";
import { BasicView } from "./basic-view";
import { ElaborationView } from "./elaboration-view";
import { ProposalView } from "./proposal-view";
import { TaskDetailPanel } from "@/app/(dashboard)/projects/[uuid]/tasks/task-detail-panel";
import { DocumentPanel } from "./document-panel";
import { ContentWithMentions } from "@/components/mention-renderer";
import { MentionEditor, type MentionEditorRef } from "@/components/mention-editor";
import {
  getIdeaCommentsAction,
  createIdeaCommentAction,
} from "@/app/(dashboard)/projects/[uuid]/ideas/[ideaUuid]/comment-actions";
import { getIdeaActivitiesAction } from "@/app/(dashboard)/projects/[uuid]/ideas/[ideaUuid]/activity-actions";
import { deleteIdeaAction, updateIdeaAction } from "@/app/(dashboard)/projects/[uuid]/ideas/actions";
import { AssignIdeaModal } from "@/app/(dashboard)/projects/[uuid]/ideas/assign-idea-modal";
import type { IdeaResponse } from "@/services/idea.service";
import type { ActivityResponse } from "@/services/activity.service";
import type { CommentResponse } from "@/services/comment.service";

// Task shape needed by TaskDetailPanel (matches the tasks page interface)
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

// Derive a simplified status from the idea's lifecycle for panel routing
function derivedStatus(idea: IdeaResponse): string {
  const status = idea.status;
  const elaborationStatus = idea.elaborationStatus;

  if (status === "open") return "todo";
  if (status === "elaborating") {
    return elaborationStatus === "pending_answers" ? "human_conduct_required" : "in_progress";
  }
  if (status === "proposal_created") return "human_conduct_required";
  if (status === "completed") return "done";
  if (status === "closed") return "done";
  return "todo";
}

// Status badge colors for derived statuses
const derivedStatusColors: Record<string, string> = {
  todo: "bg-[#FFF3E0] text-[#E65100]",
  in_progress: "bg-[#E3F2FD] text-[#1976D2]",
  human_conduct_required: "bg-[#F3E5F5] text-[#7B1FA2]",
  done: "bg-[#E0F2F1] text-[#00796B]",
};

const derivedStatusI18nKeys: Record<string, string> = {
  todo: "todo",
  in_progress: "inProgress",
  human_conduct_required: "humanConductRequired",
  done: "done",
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function formatRelativeTime(dateString: string, t: any): string {
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
  return date.toLocaleDateString();
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function formatActivityMessage(activity: ActivityResponse, t: any): string {
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
      return `${actorName}: ${action}`;
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

  const [idea, setIdea] = useState<IdeaResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Activity & Comments state
  const [activities, setActivities] = useState<ActivityResponse[]>([]);
  const [isLoadingActivities, setIsLoadingActivities] = useState(true);
  const [comments, setComments] = useState<CommentResponse[]>([]);
  const [isLoadingComments, setIsLoadingComments] = useState(true);
  const [comment, setComment] = useState("");
  const [isSubmittingComment, setIsSubmittingComment] = useState(false);
  const editorRef = useRef<MentionEditorRef>(null);
  const router = useRouter();

  // Footer state
  const [showAssignModal, setShowAssignModal] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);

  // Edit mode state
  const [isEditing, setIsEditing] = useState(false);
  const [editTitle, setEditTitle] = useState("");
  const [editContent, setEditContent] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);

  // Move to project state
  const [showMoveDialog, setShowMoveDialog] = useState(false);
  const [moveGroups, setMoveGroups] = useState<{ uuid: string; name: string; projects: { uuid: string; name: string }[] }[]>([]);
  const [isLoadingProjects, setIsLoadingProjects] = useState(false);
  const [selectedMoveProject, setSelectedMoveProject] = useState<{ uuid: string; name: string } | null>(null);
  const [isMoving, setIsMoving] = useState(false);
  const [moveError, setMoveError] = useState<string | null>(null);

  // Task detail panel state
  const [selectedTaskUuid, setSelectedTaskUuid] = useState<string | null>(null);
  const [selectedTask, setSelectedTask] = useState<TaskForPanel | null>(null);
  const [isLoadingTask, setIsLoadingTask] = useState(false);

  // Document panel state
  const [selectedDoc, setSelectedDoc] = useState<{ title: string; type: string; content: string } | null>(null);

  // Track slide-in animation
  const [hasAnimated, setHasAnimated] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setHasAnimated(true), 300);
    return () => clearTimeout(timer);
  }, []);

  // Use panel URL for URL state management
  usePanelUrl(`/projects/${projectUuid}/dashboard`, ideaUuid);

  // Fetch idea details
  const fetchIdea = useCallback(async () => {
    try {
      const res = await fetch(
        `/api/projects/${projectUuid}/ideas?pageSize=100`
      );
      const json = await res.json();
      if (json.success) {
        const found = json.data.find(
          (i: IdeaResponse) => i.uuid === ideaUuid
        );
        if (found) {
          setIdea(found);
          setError(null);
        } else {
          setError(tTracker("panel.notFound"));
        }
      } else {
        setError(tTracker("panel.loadFailed"));
      }
    } catch {
      setError(tTracker("panel.loadFailed"));
    } finally {
      setIsLoading(false);
    }
  }, [ideaUuid, projectUuid, tTracker]);

  useEffect(() => {
    setIsLoading(true);
    fetchIdea();
  }, [fetchIdea]);

  // Load activities & comments
  useEffect(() => {
    async function loadActivities() {
      setIsLoadingActivities(true);
      const result = await getIdeaActivitiesAction(ideaUuid);
      setActivities(result.activities);
      setIsLoadingActivities(false);
    }
    async function loadComments() {
      setIsLoadingComments(true);
      const result = await getIdeaCommentsAction(ideaUuid);
      setComments(result.comments);
      setIsLoadingComments(false);
    }
    loadActivities();
    loadComments();
  }, [ideaUuid]);

  // Listen for SSE events to refresh data
  useRealtimeEvent(fetchIdea);

  // Auto-refresh comments when another user adds a comment
  useRealtimeEntityEvent("idea", ideaUuid, (event) => {
    if (event.actorUuid === currentUserUuid) return;
    getIdeaCommentsAction(ideaUuid).then((result) => {
      setComments(result.comments);
    });
  });

  // Fetch task details when a task is selected from the proposal view
  useEffect(() => {
    if (!selectedTaskUuid) {
      setSelectedTask(null);
      return;
    }
    setIsLoadingTask(true);
    fetch(`/api/projects/${projectUuid}/tasks?pageSize=200`)
      .then((res) => res.json())
      .then((json) => {
        if (json.success) {
          const found = (json.data || []).find(
            (t: TaskForPanel) => t.uuid === selectedTaskUuid
          );
          if (found) setSelectedTask(found);
        }
      })
      .catch(() => {})
      .finally(() => setIsLoadingTask(false));
  }, [selectedTaskUuid, projectUuid]);

  const handleSubmitComment = async () => {
    if (!comment.trim() || isSubmittingComment) return;

    setIsSubmittingComment(true);
    const result = await createIdeaCommentAction(ideaUuid, comment);
    setIsSubmittingComment(false);

    if (result.success && result.comment) {
      setComments((prev) => [...prev, result.comment!]);
      setComment("");
      editorRef.current?.clear();
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

  const handleOpenMoveDialog = async () => {
    setShowMoveDialog(true);
    setSelectedMoveProject(null);
    setMoveError(null);
    setIsLoadingProjects(true);
    try {
      const [projRes, groupRes] = await Promise.all([
        fetch("/api/projects?pageSize=100"),
        fetch("/api/project-groups"),
      ]);
      const [projJson, groupJson] = await Promise.all([projRes.json(), groupRes.json()]);

      if (projJson.success) {
        const projects = projJson.data
          .filter((p: { uuid: string }) => p.uuid !== projectUuid)
          .map((p: { uuid: string; name: string; groupUuid: string | null }) => ({
            uuid: p.uuid, name: p.name, groupUuid: p.groupUuid,
          }));

        const groupMap = new Map<string, string>();
        if (groupJson.success) {
          const groups = groupJson.data.groups || groupJson.data;
          for (const g of groups) {
            groupMap.set(g.uuid, g.name);
          }
        }

        const grouped = new Map<string, { uuid: string; name: string; projects: { uuid: string; name: string }[] }>();
        const ungrouped: { uuid: string; name: string }[] = [];

        for (const p of projects) {
          if (p.groupUuid && groupMap.has(p.groupUuid)) {
            if (!grouped.has(p.groupUuid)) {
              grouped.set(p.groupUuid, { uuid: p.groupUuid, name: groupMap.get(p.groupUuid)!, projects: [] });
            }
            grouped.get(p.groupUuid)!.projects.push({ uuid: p.uuid, name: p.name });
          } else {
            ungrouped.push({ uuid: p.uuid, name: p.name });
          }
        }

        const groups = [...grouped.values()];
        if (ungrouped.length > 0) {
          groups.push({ uuid: "ungrouped", name: t("ideas.ungrouped"), projects: ungrouped });
        }
        setMoveGroups(groups);
      }
    } catch {
      setMoveGroups([]);
    }
    setIsLoadingProjects(false);
  };

  const handleMoveIdea = async () => {
    if (!selectedMoveProject || isMoving || !idea) return;
    setIsMoving(true);
    setMoveError(null);

    try {
      const res = await fetch(`/api/ideas/${idea.uuid}/move`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ targetProjectUuid: selectedMoveProject.uuid }),
      });
      const json = await res.json();
      if (json.success) {
        setShowMoveDialog(false);
        onClose();
        router.refresh();
      } else {
        setMoveError(typeof json.error === "string" ? json.error : json.error?.message || t("ideas.moveFailed"));
      }
    } catch {
      setMoveError(t("ideas.moveFailed"));
    }
    setIsMoving(false);
  };

  const status = idea ? derivedStatus(idea) : "todo";
  const canAssign = idea ? idea.status !== "completed" && idea.status !== "closed" : false;
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
                      {tStatus(derivedStatusI18nKeys[status] || "todo")}
                    </Badge>
                    <span className="text-xs text-[#9A9A9A]">
                      {new Date(idea.createdAt).toLocaleDateString()}
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
            {idea && idea.status !== "completed" && idea.status !== "closed" && !isEditing && (
              <>
                <Button
                  variant="outline"
                  size="icon"
                  className="h-8 w-8 border-[#E5E0D8]"
                  onClick={handleOpenMoveDialog}
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
                /* Edit Mode */
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
              <>
                <PanelContent
                  idea={idea}
                  status={status}
                  projectUuid={projectUuid}
                  currentUserUuid={currentUserUuid}
                  onRefresh={fetchIdea}
                  onTaskClick={setSelectedTaskUuid}
                  onDocClick={setSelectedDoc}
                />

                {/* Activity Section */}
                <div className="mt-5">
                  <label className="text-[11px] font-medium uppercase tracking-wider text-[#9A9A9A]">
                    {t("common.activity")}
                  </label>
                  <div className="mt-2">
                    {isLoadingActivities ? (
                      <div className="flex items-center justify-center py-4">
                        <Loader2 className="h-4 w-4 animate-spin text-[#9A9A9A]" />
                      </div>
                    ) : activities.length === 0 ? (
                      <p className="text-sm text-[#9A9A9A] italic">{t("common.noActivity")}</p>
                    ) : (
                      activities.map((activity, idx) => (
                        <div key={activity.uuid} className="flex items-stretch gap-2.5">
                          {/* Timeline: hollow dot + connecting line */}
                          <div className="flex flex-col items-center w-2 shrink-0">
                            <div className="mt-1.5 h-2 w-2 shrink-0 rounded-full border-[1.5px] border-[#D9D9D9] bg-white" />
                            {idx < activities.length - 1 && (
                              <div className="flex-1 w-px bg-[#E5E0D8] mt-1" />
                            )}
                          </div>
                          <div className="flex-1 pb-3">
                            <p className="text-[13px] text-[#2C2C2C]">
                              {formatActivityMessage(activity, t)}
                            </p>
                            <p className="text-[11px] text-[#9A9A9A]">{formatRelativeTime(activity.createdAt, t)}</p>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </div>

                {/* Comments Section */}
                <div className="mt-5">
                  <label className="text-[11px] font-medium uppercase tracking-wider text-[#9A9A9A]">
                    {t("comments.title")}
                  </label>
                  <div className="mt-2 space-y-3">
                    {isLoadingComments ? (
                      <div className="flex items-center justify-center py-4">
                        <Loader2 className="h-4 w-4 animate-spin text-[#9A9A9A]" />
                      </div>
                    ) : comments.length === 0 ? (
                      <p className="text-sm text-[#9A9A9A] italic">{t("comments.noComments")}</p>
                    ) : (
                      comments.map((c) => (
                        <div key={c.uuid} className="flex gap-2.5">
                          <Avatar className="h-6 w-6 shrink-0">
                            <AvatarFallback className={c.author.type === "agent" ? "bg-[#C67A52] text-white" : "bg-[#E5E0D8] text-[#6B6B6B] text-[10px]"}>
                              {c.author.type === "agent" ? (
                                <Bot className="h-3 w-3" />
                              ) : (
                                c.author.name.charAt(0).toUpperCase()
                              )}
                            </AvatarFallback>
                          </Avatar>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className={`text-xs font-semibold ${c.author.type === "agent" ? "text-[#C67A52]" : "text-[#2C2C2C]"}`}>{c.author.name}</span>
                              <span className="text-[11px] text-[#9A9A9A]">{formatRelativeTime(c.createdAt, t)}</span>
                            </div>
                            <div className="mt-1 text-xs leading-relaxed text-[#2C2C2C]">
                              <ContentWithMentions>{c.content}</ContentWithMentions>
                            </div>
                          </div>
                        </div>
                      ))
                    )}
                  </div>

                  {/* Comment Input */}
                  <Separator className="my-3 bg-[#F5F2EC]" />
                  <div className="flex items-start gap-2.5">
                    <Avatar className="mt-1.5 h-6 w-6">
                      <AvatarFallback className="bg-[#C67A52] text-white text-[10px]">
                        <User className="h-3 w-3" />
                      </AvatarFallback>
                    </Avatar>
                    <div className="flex-1">
                      <MentionEditor
                        ref={editorRef}
                        value={comment}
                        onChange={setComment}
                        onSubmit={handleSubmitComment}
                        placeholder={t("comments.addComment")}
                        className="border-none bg-[#FAF8F4] text-sm"
                        disabled={isSubmittingComment}
                      />
                    </div>
                    <Button
                      size="icon"
                      variant="ghost"
                      className="mt-1 h-7 w-7"
                      disabled={!comment.trim() || isSubmittingComment}
                      onClick={handleSubmitComment}
                    >
                      {isSubmittingComment ? (
                        <Loader2 className="h-3.5 w-3.5 animate-spin text-[#9A9A9A]" />
                      ) : (
                        <Send className="h-3.5 w-3.5 text-[#C67A52]" />
                      )}
                    </Button>
                  </div>
                </div>
              </>
              )
            ) : null}
          </div>
        </ScrollArea>

        {/* Footer */}
        {idea && !isLoading && (
          <div className="border-t border-[#F5F2EC] px-6 py-4">
            {isEditing ? (
              /* Edit mode footer: Cancel + Save */
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
              /* Normal footer: Reassign + help + Delete */
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
      <Dialog open={showMoveDialog} onOpenChange={setShowMoveDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("ideas.moveIdeaTitle")}</DialogTitle>
            <DialogDescription>
              {t("ideas.moveIdeaDescription")}
            </DialogDescription>
          </DialogHeader>
          {moveError && (
            <p className="text-xs text-destructive">{moveError}</p>
          )}
          {isLoadingProjects ? (
            <div className="flex items-center justify-center h-[320px] border border-[#E5E0D8] rounded-lg">
              <Loader2 className="h-4 w-4 animate-spin text-[#9A9A9A]" />
            </div>
          ) : (
            <Command className="border border-[#E5E0D8] rounded-lg" filter={(value, search, keywords) => {
              const searchLower = search.toLowerCase();
              if (value.toLowerCase().includes(searchLower)) return 1;
              if (keywords?.some(k => k.toLowerCase().includes(searchLower))) return 1;
              return 0;
            }}>
              <CommandInput placeholder={t("ideas.searchProjects")} />
              <CommandList className="h-[280px]">
                <CommandEmpty>{t("ideas.noProjectsFound")}</CommandEmpty>
                {moveGroups.map((group) => (
                  <CommandGroup key={group.uuid} heading={group.name}>
                    {group.projects.map((p) => (
                      <CommandItem
                        key={p.uuid}
                        value={p.name}
                        keywords={[group.name]}
                        onSelect={() => setSelectedMoveProject(p)}
                        className={
                          selectedMoveProject?.uuid === p.uuid
                            ? "bg-[#C67A52] text-white data-[selected=true]:bg-[#B56A42] data-[selected=true]:text-white"
                            : ""
                        }
                      >
                        <Check className={`mr-2 h-4 w-4 ${selectedMoveProject?.uuid === p.uuid ? "opacity-100" : "opacity-0"}`} />
                        {p.name}
                      </CommandItem>
                    ))}
                  </CommandGroup>
                ))}
              </CommandList>
            </Command>
          )}
          <div className="flex justify-end gap-3 pt-2">
            <Button
              variant="outline"
              className="border-[#E5E0D8]"
              onClick={() => setShowMoveDialog(false)}
              disabled={isMoving}
            >
              {t("common.cancel")}
            </Button>
            <Button
              className="bg-[#C67A52] hover:bg-[#B56A42] text-white"
              onClick={handleMoveIdea}
              disabled={!selectedMoveProject || isMoving}
            >
              {isMoving ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {t("ideas.moving")}
                </>
              ) : (
                t("ideas.moveToProject")
              )}
            </Button>
          </div>
        </DialogContent>
      </Dialog>

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

      {/* Task Detail Panel — slides in from right on top of idea panel */}
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

      {/* Document Panel — slides in from right on top of idea panel */}
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

// Route to the correct view based on the idea's raw status (lifecycle stage)
function PanelContent({
  idea,
  projectUuid,
  currentUserUuid,
  onRefresh,
  onTaskClick,
  onDocClick,
}: {
  idea: IdeaResponse;
  status: string;
  projectUuid: string;
  currentUserUuid: string;
  onRefresh: () => void;
  onTaskClick?: (taskUuid: string) => void;
  onDocClick?: (doc: { title: string; type: string; content: string }) => void;
}) {
  const t = useTranslations("ideaTracker");
  const rawStatus = idea.status;

  switch (rawStatus) {
    case "open":
      return (
        <BasicView
          idea={idea}
          projectUuid={projectUuid}
          currentUserUuid={currentUserUuid}
          onRefresh={onRefresh}
        />
      );
    case "elaborating":
      return (
        <ElaborationView
          idea={idea}
          onRefresh={onRefresh}
        />
      );
    case "proposal_created":
      return (
        <ProposalView
          idea={idea}
          projectUuid={projectUuid}
          onTaskClick={onTaskClick}
          onDocClick={onDocClick}
        />
      );
    case "completed":
    case "closed":
      return (
        <div className="flex items-center justify-center py-12 text-sm text-[#9A9A9A]">
          {t("panel.donePlaceholder")}
        </div>
      );
    default:
      return (
        <BasicView
          idea={idea}
          projectUuid={projectUuid}
          currentUserUuid={currentUserUuid}
          onRefresh={onRefresh}
        />
      );
  }
}
