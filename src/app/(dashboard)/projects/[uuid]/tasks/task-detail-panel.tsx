"use client";

import { useState, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { X, Pencil, CheckCircle, Play, Eye, Bot, User, Send, FileText, Loader2, Check, Trash2, GitBranch, Plus, ArrowRight, Activity as ActivityIcon, CircleCheck, Timer, CircleX, AlertTriangle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
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
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { updateTaskStatusAction, createTaskAction, updateTaskFieldsAction, deleteTaskAction } from "./[taskUuid]/actions";
import { markCriteriaAction, selfCheckCriteriaAction, resetCriterionAction } from "./[taskUuid]/criteria-actions";
import {
  getTaskCommentsAction,
  createTaskCommentAction,
} from "./[taskUuid]/comment-actions";
import { getTaskActivitiesAction } from "./[taskUuid]/activity-actions";
import type { ActivityResponse } from "@/services/activity.service";
import {
  getTaskSourceAction,
  type ProposalSource,
} from "./[taskUuid]/source-actions";
import type { CommentResponse } from "@/services/comment.service";
import { Streamdown } from "streamdown";
import { code } from "@streamdown/code";
import { ContentWithMentions } from "@/components/mention-renderer";
import { MentionEditor, type MentionEditorRef } from "@/components/mention-editor";
import { AssignTaskModal } from "./assign-task-modal";
import {
  getTaskDependenciesAction,
  addTaskDependencyAction,
  removeTaskDependencyAction,
  getProjectTasksForDependencyAction,
} from "./[taskUuid]/dependency-actions";
import { getTaskSessionsAction } from "./session-actions";
import type { TaskSessionInfo } from "@/services/session.service";
import { useRealtimeEntityEvent } from "@/contexts/realtime-context";

interface DependencyTask {
  uuid: string;
  title: string;
  status: string;
}

interface AcceptanceCriterionItem {
  uuid: string;
  description: string;
  required: boolean;
  devStatus: string;
  devEvidence: string | null;
  status: string;
  evidence: string | null;
  sortOrder: number;
}

interface AcceptanceSummaryData {
  total: number;
  required: number;
  passed: number;
  failed: number;
  pending: number;
  requiredPassed: number;
  requiredFailed: number;
  requiredPending: number;
}

interface Task {
  uuid: string;
  title: string;
  description: string | null;
  status: string;
  priority: string;
  storyPoints: number | null;
  acceptanceCriteria?: string | null;
  acceptanceCriteriaItems?: AcceptanceCriterionItem[];
  acceptanceStatus?: string;
  acceptanceSummary?: AcceptanceSummaryData;
  proposalUuid: string | null;
  assignee: {
    type: string;
    uuid: string;
    name: string;
    assignedAt: string | null;
    assignedBy: { type: string; uuid: string; name: string } | null;
  } | null;
  dependsOn?: DependencyTask[];
  dependedBy?: DependencyTask[];
}

interface TaskDetailPanelProps {
  task: Task | null;
  projectUuid: string;
  currentUserUuid: string;
  onClose: () => void;
  onCreated?: () => void;
  onDependencyChange?: () => void;
}

// Status color configuration
const statusColors: Record<string, string> = {
  open: "bg-[#FFF3E0] text-[#E65100]",
  assigned: "bg-[#E3F2FD] text-[#1976D2]",
  in_progress: "bg-[#E8F5E9] text-[#5A9E6F]",
  to_verify: "bg-[#F3E5F5] text-[#7B1FA2]",
  done: "bg-[#E0F2F1] text-[#00796B]",
  closed: "bg-[#F5F5F5] text-[#9A9A9A]",
};

// Status to i18n key mapping
const statusI18nKeys: Record<string, string> = {
  open: "open",
  assigned: "assigned",
  in_progress: "inProgress",
  to_verify: "toVerify",
  done: "done",
  closed: "closed",
};

// Priority color configuration
const priorityColors: Record<string, string> = {
  low: "bg-[#F5F5F5] text-[#9A9A9A]",
  medium: "bg-[#FFF3E0] text-[#E65100]",
  high: "bg-[#FEE2E2] text-[#D32F2F]",
  critical: "bg-[#FFCDD2] text-[#B71C1C]",
};

// Priority to i18n key mapping
const priorityI18nKeys: Record<string, string> = {
  low: "lowPriority",
  medium: "mediumPriority",
  high: "highPriority",
  critical: "criticalPriority",
};

// Format relative time
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

// Activity dot color
function getActivityDotColor(action: string): string {
  switch (action) {
    case "task_created":
      return "bg-[#C67A52]";
    case "task_assigned":
    case "task_claimed":
      return "bg-[#1976D2]";
    case "task_started":
      return "bg-[#5A9E6F]";
    case "task_submitted":
      return "bg-[#7B1FA2]";
    case "task_completed":
    case "task_verified":
      return "bg-[#00796B]";
    case "task_released":
      return "bg-[#E65100]";
    default:
      return "bg-[#6B6B6B]";
  }
}

// Format Activity message
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function formatActivityMessage(activity: ActivityResponse, t: any): string {
  const actorDisplay = activity.sessionName
    ? `${activity.actorName} / ${activity.sessionName}`
    : activity.actorName;
  const { action } = activity;
  const actorName = actorDisplay;

  switch (action) {
    case "task_created":
      return t("activity.taskCreated", { actor: actorName });
    case "task_assigned":
      return t("activity.taskAssigned", { actor: actorName });
    case "task_claimed":
      return t("activity.taskClaimed", { actor: actorName });
    case "task_started":
      return t("activity.taskStarted", { actor: actorName });
    case "task_submitted":
      return t("activity.taskSubmitted", { actor: actorName });
    case "task_completed":
    case "task_verified":
      return t("activity.taskCompleted", { actor: actorName });
    case "task_released":
      return t("activity.taskReleased", { actor: actorName });
    case "task_status_changed":
      return t("activity.taskStatusChanged", { actor: actorName });
    default:
      return `${actorName}: ${action}`;
  }
}

export function TaskDetailPanel({
  task,
  projectUuid,
  currentUserUuid,
  onClose,
  onCreated,
  onDependencyChange,
}: TaskDetailPanelProps) {
  const t = useTranslations();
  const router = useRouter();

  // Track whether the initial slide-in animation has completed
  const [hasAnimated, setHasAnimated] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setHasAnimated(true), 300);
    return () => clearTimeout(timer);
  }, []);

  const [isLoading, setIsLoading] = useState(false);
  const [comment, setComment] = useState("");
  const [comments, setComments] = useState<CommentResponse[]>([]);
  const [isLoadingComments, setIsLoadingComments] = useState(true);
  const [isSubmittingComment, setIsSubmittingComment] = useState(false);
  const editorRef = useRef<MentionEditorRef>(null);
  const [activities, setActivities] = useState<ActivityResponse[]>([]);
  const [isLoadingActivities, setIsLoadingActivities] = useState(true);
  const [source, setSource] = useState<ProposalSource | null>(null);
  const [showAssignModal, setShowAssignModal] = useState(false);

  // Dependency state
  const [dependsOn, setDependsOn] = useState<DependencyTask[]>([]);
  const [dependedBy, setDependedBy] = useState<DependencyTask[]>([]);
  const [isLoadingDeps, setIsLoadingDeps] = useState(false);
  const [allProjectTasks, setAllProjectTasks] = useState<DependencyTask[]>([]);
  const [depError, setDepError] = useState<string | null>(null);

  // Active workers (sessions)
  const [activeWorkers, setActiveWorkers] = useState<TaskSessionInfo[]>([]);

  // Auto-refresh comments when another user adds a comment
  useRealtimeEntityEvent("task", task?.uuid ?? "", (event) => {
    if (event.actorUuid === currentUserUuid) return;
    if (!task) return;
    getTaskCommentsAction(task.uuid).then((result) => {
      setComments(result.comments);
    });
  });

  // Pending dependencies for create mode (stored locally until task is created)
  const [pendingDeps, setPendingDeps] = useState<DependencyTask[]>([]);

  // Edit / Create mode state
  const isCreateMode = task === null;
  const [isEditing, setIsEditing] = useState(isCreateMode);
  const [editTitle, setEditTitle] = useState(task?.title || "");
  const [editDescription, setEditDescription] = useState(task?.description || "");
  const [editPriority, setEditPriority] = useState(task?.priority || "medium");
  const [editStoryPoints, setEditStoryPoints] = useState<string>(
    task?.storyPoints != null ? String(task.storyPoints) : ""
  );
  const [editAcceptanceCriteria, setEditAcceptanceCriteria] = useState(
    task?.acceptanceCriteria || ""
  );
  const [isSaving, setIsSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  const isAssignedToMe = task?.assignee?.uuid === currentUserUuid;
  const canStart = isAssignedToMe && task?.status === "assigned";
  const canMarkToVerify = isAssignedToMe && task?.status === "in_progress";
  const canMarkDone = task?.status === "to_verify";

  // Load comments, activities, and source
  useEffect(() => {
    if (!task) return;

    async function loadComments() {
      setIsLoadingComments(true);
      const result = await getTaskCommentsAction(task!.uuid);
      setComments(result.comments);
      setIsLoadingComments(false);
    }
    async function loadActivities() {
      setIsLoadingActivities(true);
      const result = await getTaskActivitiesAction(task!.uuid);
      setActivities(result.activities);
      setIsLoadingActivities(false);
    }
    async function loadSource() {
      if (task!.proposalUuid) {
        const result = await getTaskSourceAction(task!.proposalUuid);
        setSource(result);
      }
    }
    async function loadDependencies() {
      setIsLoadingDeps(true);
      const [depsResult, projectTasksResult] = await Promise.all([
        getTaskDependenciesAction(task!.uuid),
        getProjectTasksForDependencyAction(projectUuid),
      ]);
      setDependsOn(depsResult.dependsOn);
      setDependedBy(depsResult.dependedBy);
      setAllProjectTasks(projectTasksResult.tasks);
      setIsLoadingDeps(false);
    }
    async function loadActiveWorkers() {
      const result = await getTaskSessionsAction(task!.uuid);
      if (result.success && result.data) {
        setActiveWorkers(result.data);
      }
    }
    loadComments();
    loadActivities();
    loadSource();
    loadDependencies();
    loadActiveWorkers();
  }, [task?.uuid, task?.proposalUuid, projectUuid]);

  // Load project tasks for dependency picker in create mode
  useEffect(() => {
    if (!isCreateMode) return;
    async function loadProjectTasks() {
      const result = await getProjectTasksForDependencyAction(projectUuid);
      setAllProjectTasks(result.tasks);
    }
    loadProjectTasks();
  }, [isCreateMode, projectUuid]);

  // Reset edit state when task changes
  useEffect(() => {
    if (task) {
      setIsEditing(false);
      setEditTitle(task.title);
      setEditDescription(task.description || "");
      setEditPriority(task.priority);
      setEditStoryPoints(task.storyPoints != null ? String(task.storyPoints) : "");
      setEditAcceptanceCriteria(task.acceptanceCriteria || "");
      setEditError(null);
    }
  }, [task?.uuid, task?.title, task?.description, task?.priority, task?.storyPoints, task?.acceptanceCriteria]);

  const handleStatusChange = async (newStatus: string) => {
    if (!task) return;
    setIsLoading(true);
    const result = await updateTaskStatusAction(task.uuid, newStatus);
    setIsLoading(false);
    if (result.success) {
      onClose();
      router.refresh();
    }
  };

  const handleSubmitComment = async () => {
    if (!task || !comment.trim() || isSubmittingComment) return;

    setIsSubmittingComment(true);
    const result = await createTaskCommentAction(task.uuid, comment);
    setIsSubmittingComment(false);

    if (result.success && result.comment) {
      setComments((prev) => [...prev, result.comment!]);
      setComment("");
      editorRef.current?.clear();
    }
  };

  const handleStartEdit = () => {
    if (!task) return;
    setEditTitle(task.title);
    setEditDescription(task.description || "");
    setEditPriority(task.priority);
    setEditStoryPoints(task.storyPoints != null ? String(task.storyPoints) : "");
    setEditAcceptanceCriteria(task.acceptanceCriteria || "");
    setEditError(null);
    setIsEditing(true);
  };

  const handleCancelEdit = () => {
    if (isCreateMode) {
      onClose();
      return;
    }
    setIsEditing(false);
    if (task) {
      setEditTitle(task.title);
      setEditDescription(task.description || "");
      setEditPriority(task.priority);
      setEditStoryPoints(task.storyPoints != null ? String(task.storyPoints) : "");
      setEditAcceptanceCriteria(task.acceptanceCriteria || "");
    }
    setEditError(null);
  };

  const handleSaveEdit = async () => {
    if (!editTitle.trim()) {
      setEditError(t("tasks.titleRequired"));
      return;
    }

    setIsSaving(true);
    setEditError(null);

    const storyPointsValue = editStoryPoints.trim() ? parseFloat(editStoryPoints) : null;

    if (isCreateMode) {
      const result = await createTaskAction({
        projectUuid,
        title: editTitle.trim(),
        description: editDescription.trim() || undefined,
        priority: editPriority,
        storyPoints: storyPointsValue,
        acceptanceCriteria: editAcceptanceCriteria.trim() || null,
      });

      setIsSaving(false);

      if (result.success) {
        // Add pending dependencies after task creation
        if (pendingDeps.length > 0 && result.taskUuid) {
          await Promise.all(
            pendingDeps.map((dep) => addTaskDependencyAction(result.taskUuid!, dep.uuid))
          );
          onDependencyChange?.();
        }
        onCreated?.();
        onClose();
        router.refresh();
      } else {
        setEditError(result.error || t("tasks.createFailed"));
      }
    } else {
      const result = await updateTaskFieldsAction({
        taskUuid: task!.uuid,
        projectUuid,
        title: editTitle.trim(),
        description: editDescription.trim() || null,
        priority: editPriority,
        storyPoints: storyPointsValue,
        acceptanceCriteria: editAcceptanceCriteria.trim() || null,
      });

      setIsSaving(false);

      if (result.success) {
        setIsEditing(false);
        router.refresh();
      } else {
        setEditError(result.error || t("tasks.updateFailed"));
      }
    }
  };

  const handleDelete = async () => {
    if (!task) return;
    setIsDeleting(true);
    const result = await deleteTaskAction(task.uuid, projectUuid);
    setIsDeleting(false);

    if (result.success) {
      onClose();
      router.refresh();
    }
  };

  const handleAddDependency = async (dependsOnUuid: string) => {
    if (!task) return;
    setDepError(null);
    const result = await addTaskDependencyAction(task.uuid, dependsOnUuid);
    if (result.success) {
      const addedTask = allProjectTasks.find(t => t.uuid === dependsOnUuid);
      if (addedTask) {
        setDependsOn(prev => [...prev, addedTask]);
      }
      onDependencyChange?.();
    } else {
      setDepError(result.error || t("tasks.failedToAddDep"));
    }
  };

  const handleRemoveDependency = async (dependsOnUuid: string) => {
    if (!task) return;
    setDepError(null);
    const result = await removeTaskDependencyAction(task.uuid, dependsOnUuid);
    if (result.success) {
      setDependsOn(prev => prev.filter(d => d.uuid !== dependsOnUuid));
      onDependencyChange?.();
    } else {
      setDepError(result.error || t("tasks.failedToRemoveDep"));
    }
  };

  const handleRemoveDependedBy = async (taskUuid: string) => {
    if (!task) return;
    setDepError(null);
    // Reverse: the other task depends on us, so remove from the other task's perspective
    const result = await removeTaskDependencyAction(taskUuid, task.uuid);
    if (result.success) {
      setDependedBy(prev => prev.filter(d => d.uuid !== taskUuid));
      onDependencyChange?.();
    } else {
      setDepError(result.error || t("tasks.failedToRemoveDep"));
    }
  };

  // Available tasks for dependency dropdown (filter out self and already-dependent tasks)
  const availableDepsForAdd = allProjectTasks.filter(
    t => t.uuid !== task?.uuid && !dependsOn.some(d => d.uuid === t.uuid)
  );

  // Available tasks for create mode dependency picker
  const availableDepsForCreate = allProjectTasks.filter(
    t => !pendingDeps.some(d => d.uuid === t.uuid)
  );

  // Render the edit/create form
  const renderEditForm = () => (
    <div className="space-y-5">
      {editError && (
        <div className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
          {editError}
        </div>
      )}

      <div className="space-y-2">
        <Label htmlFor="edit-title" className="text-[13px] font-medium text-[#2C2C2C]">
          {t("tasks.titleLabel")}
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
        <Label htmlFor="edit-description" className="text-[13px] font-medium text-[#2C2C2C]">
          {t("tasks.descriptionLabel")}
        </Label>
        <Textarea
          id="edit-description"
          value={editDescription}
          onChange={(e) => setEditDescription(e.target.value)}
          rows={4}
          className="border-[#E5E0D8] text-sm resize-none focus-visible:ring-[#C67A52]"
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="edit-priority" className="text-[13px] font-medium text-[#2C2C2C]">
          {t("tasks.priorityLabel")}
        </Label>
        <Select value={editPriority} onValueChange={setEditPriority}>
          <SelectTrigger className="border-[#E5E0D8] text-sm focus:ring-[#C67A52]">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="low">{t("priority.low")}</SelectItem>
            <SelectItem value="medium">{t("priority.medium")}</SelectItem>
            <SelectItem value="high">{t("priority.high")}</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-2">
        <Label htmlFor="edit-story-points" className="text-[13px] font-medium text-[#2C2C2C]">
          {t("tasks.storyPointsLabel")}
        </Label>
        <Input
          id="edit-story-points"
          type="number"
          min="0"
          step="0.5"
          value={editStoryPoints}
          onChange={(e) => setEditStoryPoints(e.target.value)}
          className="border-[#E5E0D8] text-sm focus-visible:ring-[#C67A52]"
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="edit-acceptance-criteria" className="text-[13px] font-medium text-[#2C2C2C]">
          {t("tasks.acceptanceCriteriaLabel")}
        </Label>
        <Textarea
          id="edit-acceptance-criteria"
          value={editAcceptanceCriteria}
          onChange={(e) => setEditAcceptanceCriteria(e.target.value)}
          rows={4}
          className="border-[#E5E0D8] text-sm resize-none focus-visible:ring-[#C67A52]"
        />
      </div>

      {/* Dependency picker for create mode */}
      {isCreateMode && (
        <div className="space-y-2">
          <Label className="text-[13px] font-medium text-[#2C2C2C]">
            {t("tasks.dependencies")}
          </Label>

          {/* Selected pending deps */}
          {pendingDeps.length > 0 && (
            <div className="space-y-1.5">
              {pendingDeps.map((dep) => (
                <div
                  key={dep.uuid}
                  className="group flex items-center justify-between rounded-lg bg-[#FAF8F4] p-2.5"
                >
                  <div className="flex items-center gap-2 min-w-0">
                    <GitBranch className="h-3.5 w-3.5 shrink-0 text-[#C67A52]" />
                    <span className="text-xs text-[#2C2C2C] truncate">{dep.title}</span>
                    <Badge className={`shrink-0 text-[10px] ${statusColors[dep.status] || ""}`}>
                      {t(`status.${statusI18nKeys[dep.status] || dep.status}`)}
                    </Badge>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity ml-2 shrink-0"
                    onClick={() => setPendingDeps(prev => prev.filter(d => d.uuid !== dep.uuid))}
                  >
                    <X className="h-3.5 w-3.5 text-[#9A9A9A] hover:text-[#D32F2F]" />
                  </Button>
                </div>
              ))}
            </div>
          )}

          {/* Add dependency select */}
          {availableDepsForCreate.length > 0 && (
            <Select
              key={pendingDeps.length}
              onValueChange={(uuid) => {
                const found = allProjectTasks.find(t => t.uuid === uuid);
                if (found) {
                  setPendingDeps(prev => [...prev, found]);
                }
              }}
            >
              <SelectTrigger className="h-8 border-[#E5E0D8] text-xs text-[#6B6B6B] focus:ring-[#C67A52]">
                <div className="flex items-center gap-1.5">
                  <Plus className="h-3 w-3" />
                  <SelectValue placeholder={t("tasks.addDependency")} />
                </div>
              </SelectTrigger>
              <SelectContent>
                {availableDepsForCreate.map((t) => (
                  <SelectItem key={t.uuid} value={t.uuid}>
                    <span className="truncate">{t.title}</span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>
      )}
    </div>
  );

  return (
    <>
      {/* Backdrop */}
      <div
        className="fixed inset-0 z-40 bg-black/20"
        onClick={onClose}
      />

      {/* Panel */}
      <div className={`fixed right-0 top-14 md:top-0 z-50 flex h-[calc(100%-3.5rem)] md:h-full w-full md:w-[480px] flex-col bg-white shadow-xl border-l border-[#E5E0D8] ${hasAnimated ? "" : "animate-in slide-in-from-right duration-300"}`}>
        {/* Panel Header */}
        <div className="flex items-center justify-between border-b border-[#F5F2EC] px-6 py-5">
          <div className="flex-1 min-w-0">
            {isEditing ? (
              <h2 className="text-base font-semibold text-[#2C2C2C]">
                {isCreateMode ? t("tasks.createTaskTitle") : t("tasks.editTask")}
              </h2>
            ) : task ? (
              <>
                <h2 className="text-base font-semibold text-[#2C2C2C] truncate">
                  {task.title}
                </h2>
                <div className="mt-1.5 flex items-center gap-2">
                  <Badge className={statusColors[task.status] || ""}>
                    {t(`status.${statusI18nKeys[task.status] || task.status}`)}
                  </Badge>
                  <Badge className={priorityColors[task.priority] || ""}>
                    {t(`priority.${priorityI18nKeys[task.priority] || task.priority}`)}
                  </Badge>
                  {task.storyPoints && (
                    <span className="rounded bg-[#F5F2EC] px-2 py-0.5 text-xs font-medium text-[#6B6B6B]">
                      {task.storyPoints}h
                    </span>
                  )}
                </div>
              </>
            ) : null}
          </div>

          <div className="flex items-center gap-2 ml-4">
            {task && !isEditing && (
              <Button
                variant="outline"
                size="sm"
                className="h-8 gap-1.5 border-[#E5E0D8] text-[#2C2C2C]"
                onClick={handleStartEdit}
              >
                <Pencil className="h-3.5 w-3.5 text-[#6B6B6B]" />
                <span className="text-xs">{t("common.edit")}</span>
              </Button>
            )}
            <Button
              variant="outline"
              size="icon"
              className="h-8 w-8 border-[#E5E0D8]"
              onClick={isEditing && !isCreateMode ? handleCancelEdit : onClose}
            >
              <X className="h-4 w-4 text-[#6B6B6B]" />
            </Button>
          </div>
        </div>

        {/* Panel Body - Scrollable */}
        <ScrollArea className="flex-1 min-h-0 [&_[data-slot=scroll-area-viewport]>div]:!block">
          <div className="flex min-h-full flex-col px-6 py-5">
            {isEditing ? (
              renderEditForm()
            ) : task ? (
              <>
                {/* Assignee Section */}
                <div>
                  <label className="text-[11px] font-medium uppercase tracking-wide text-[#9A9A9A]">
                    {t("common.assignee")}
                  </label>
                  <div className="mt-2 flex items-center gap-2.5 rounded-lg bg-[#FAF8F4] p-3">
                    {task.assignee ? (
                      <>
                        <Avatar className="h-7 w-7">
                          <AvatarFallback className={task.assignee.type === "agent" ? "bg-[#C67A52] text-white" : "bg-[#E5E0D8] text-[#6B6B6B]"}>
                            {task.assignee.type === "agent" ? (
                              <Bot className="h-3.5 w-3.5" />
                            ) : (
                              task.assignee.name.charAt(0).toUpperCase()
                            )}
                          </AvatarFallback>
                        </Avatar>
                        <div>
                          <div className="text-sm font-medium text-[#2C2C2C]">
                            {task.assignee.name}
                          </div>
                          <div className="text-xs text-[#6B6B6B]">
                            {task.assignee.type === "agent"
                              ? `${t("common.agent")} • ${task.assignee.assignedAt ? new Date(task.assignee.assignedAt).toLocaleDateString() : ''}`
                              : t("common.user")}
                          </div>
                        </div>
                      </>
                    ) : (
                      <span className="text-sm text-[#9A9A9A]">{t("common.unassigned")}</span>
                    )}
                  </div>
                </div>

                {/* Active Workers Section */}
                {activeWorkers.length > 0 && (
                  <div className="mt-5">
                    <label className="text-[11px] font-medium uppercase tracking-wide text-[#9A9A9A]">
                      {t("sessions.activeWorkers")}
                    </label>
                    <div className="mt-2 space-y-1.5">
                      {activeWorkers.map((worker) => (
                        <div
                          key={worker.sessionUuid}
                          className="flex items-center gap-2.5 rounded-lg bg-[#FAF8F4] p-2.5"
                        >
                          <div className="h-2 w-2 rounded-full bg-green-500 flex-shrink-0" />
                          <div className="min-w-0">
                            <div className="text-xs font-medium text-[#2C2C2C] truncate">
                              {worker.sessionName}
                            </div>
                            <div className="text-[10px] text-[#9A9A9A]">
                              {worker.agentName} · {formatRelativeTime(worker.checkinAt, t)}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Description Section */}
                <div className="mt-5">
                  <label className="text-[11px] font-medium uppercase tracking-wide text-[#9A9A9A]">
                    {t("common.description")}
                  </label>
                  <div className="mt-2">
                    {task.description ? (
                      <div className="prose prose-sm max-w-none text-[13px] leading-relaxed text-[#2C2C2C]">
                        <Streamdown plugins={{ code }}>{task.description}</Streamdown>
                      </div>
                    ) : (
                      <p className="text-sm italic text-[#9A9A9A]">{t("common.noDescription")}</p>
                    )}
                  </div>
                </div>

                {/* Acceptance Criteria Section - legacy only (structured criteria shown below dependencies) */}
                {task.acceptanceCriteria && !(task.acceptanceCriteriaItems && task.acceptanceCriteriaItems.length > 0) && (
                  <div className="mt-5">
                    <label className="text-[11px] font-medium uppercase tracking-wide text-[#9A9A9A]">
                      {t("tasks.acceptanceCriteria")}
                    </label>
                    <div className="mt-2">
                      <div className="prose prose-sm max-w-none text-[13px] leading-relaxed text-[#2C2C2C]">
                        <Streamdown plugins={{ code }}>{task.acceptanceCriteria}</Streamdown>
                      </div>
                    </div>
                  </div>
                )}

                {/* Source Section - only show if from proposal */}
                {source && (
                  <div className="mt-5">
                    <label className="text-[11px] font-medium uppercase tracking-wide text-[#9A9A9A]">
                      {t("common.source")}
                    </label>
                    <a
                      href={`/projects/${projectUuid}/proposals/${source.uuid}`}
                      className="mt-2 flex items-center justify-between rounded-lg bg-[#FAF8F4] p-3 hover:bg-[#F0EDE5] transition-colors"
                    >
                      <div className="flex items-center gap-2">
                        <FileText className="h-3.5 w-3.5 text-[#C67A52]" />
                        <span className="text-xs text-[#2C2C2C]">{source.title}</span>
                      </div>
                    </a>
                  </div>
                )}

                {/* Dependencies Section */}
                <div className="mt-5">
                  <label className="text-[11px] font-medium uppercase tracking-wide text-[#9A9A9A]">
                    {t("tasks.dependencies")}
                  </label>

                  {depError && (
                    <div className="mt-2 rounded-lg bg-destructive/10 p-2.5 text-xs text-destructive">
                      {depError}
                    </div>
                  )}

                  {isLoadingDeps ? (
                    <div className="mt-2 flex items-center justify-center py-4">
                      <Loader2 className="h-4 w-4 animate-spin text-[#9A9A9A]" />
                    </div>
                  ) : (
                    <>
                      {/* Depends On */}
                      {dependsOn.length > 0 && (
                        <div className="mt-2">
                          <div className="flex items-center gap-1.5 mb-1.5">
                            <ArrowRight className="h-3 w-3 text-[#9A9A9A]" />
                            <span className="text-[10px] font-medium uppercase tracking-wide text-[#9A9A9A]">
                              {t("tasks.dependsOn")}
                            </span>
                          </div>
                          <div className="space-y-1.5">
                            {dependsOn.map((dep) => (
                              <div
                                key={dep.uuid}
                                className="group flex items-center justify-between rounded-lg bg-[#FAF8F4] p-3"
                              >
                                <div className="flex items-center gap-2 min-w-0">
                                  <GitBranch className="h-3.5 w-3.5 shrink-0 text-[#C67A52]" />
                                  <span className="text-xs text-[#2C2C2C] truncate">
                                    {dep.title}
                                  </span>
                                  <Badge className={`shrink-0 text-[10px] ${statusColors[dep.status] || ""}`}>
                                    {t(`status.${statusI18nKeys[dep.status] || dep.status}`)}
                                  </Badge>
                                </div>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity ml-2 shrink-0"
                                  onClick={() => handleRemoveDependency(dep.uuid)}
                                >
                                  <X className="h-3.5 w-3.5 text-[#9A9A9A] hover:text-[#D32F2F]" />
                                </Button>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Depended By (blocked by this) */}
                      {dependedBy.length > 0 && (
                        <div className="mt-3">
                          <div className="flex items-center gap-1.5 mb-1.5">
                            <ArrowRight className="h-3 w-3 rotate-180 text-[#9A9A9A]" />
                            <span className="text-[10px] font-medium uppercase tracking-wide text-[#9A9A9A]">
                              {t("tasks.blockedByThis")}
                            </span>
                          </div>
                          <div className="space-y-1.5">
                            {dependedBy.map((dep) => (
                              <div
                                key={dep.uuid}
                                className="group flex items-center justify-between rounded-lg bg-[#FAF8F4] p-3"
                              >
                                <div className="flex items-center gap-2 min-w-0">
                                  <GitBranch className="h-3.5 w-3.5 shrink-0 text-[#6B6B6B]" />
                                  <span className="text-xs text-[#2C2C2C] truncate">
                                    {dep.title}
                                  </span>
                                  <Badge className={`shrink-0 text-[10px] ${statusColors[dep.status] || ""}`}>
                                    {t(`status.${statusI18nKeys[dep.status] || dep.status}`)}
                                  </Badge>
                                </div>
                                <Button
                                  variant="ghost"
                                  size="icon"
                                  className="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity ml-2 shrink-0"
                                  onClick={() => handleRemoveDependedBy(dep.uuid)}
                                >
                                  <X className="h-3.5 w-3.5 text-[#9A9A9A] hover:text-[#D32F2F]" />
                                </Button>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}

                      {dependsOn.length === 0 && dependedBy.length === 0 && (
                        <p className="mt-2 text-sm italic text-[#9A9A9A]">{t("tasks.noDependencies")}</p>
                      )}

                      {/* Add Dependency */}
                      {availableDepsForAdd.length > 0 && (
                        <div className="mt-3">
                          <Select
                            key={dependsOn.length}
                            onValueChange={(uuid) => handleAddDependency(uuid)}
                          >
                            <SelectTrigger className="h-8 border-[#E5E0D8] text-xs text-[#6B6B6B] focus:ring-[#C67A52]">
                              <div className="flex items-center gap-1.5">
                                <Plus className="h-3 w-3" />
                                <SelectValue placeholder={t("tasks.addDependency")} />
                              </div>
                            </SelectTrigger>
                            <SelectContent>
                              {availableDepsForAdd.map((t) => (
                                <SelectItem key={t.uuid} value={t.uuid}>
                                  <span className="truncate">{t.title}</span>
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                      )}
                    </>
                  )}
                </div>

                {/* Structured Acceptance Criteria Section */}
                {task && task.acceptanceCriteriaItems && task.acceptanceCriteriaItems.length > 0 && (() => {
                  const items = task.acceptanceCriteriaItems!;
                  const summary = task.acceptanceSummary;

                  const criterionStatusIcon = (status: string) => {
                    if (status === "passed") return <CircleCheck className="h-4 w-4 text-green-600" />;
                    if (status === "failed") return <CircleX className="h-4 w-4 text-red-600" />;
                    return <Timer className="h-4 w-4 text-yellow-600" />;
                  };

                  const criterionStatusColor = (status: string) => {
                    if (status === "passed") return "bg-green-50 text-green-700";
                    if (status === "failed") return "bg-red-50 text-red-700";
                    return "bg-yellow-50 text-yellow-700";
                  };

                  const handleMarkCriterion = async (criterionUuid: string, newStatus: "passed" | "failed") => {
                    const result = await markCriteriaAction(task.uuid, [{ uuid: criterionUuid, status: newStatus }]);
                    if (result.success) {
                      router.refresh();
                    }
                  };

                  return (
                    <div className="mt-5">
                      <div className="flex items-center justify-between">
                        <label className="text-[11px] font-medium uppercase tracking-wide text-[#9A9A9A]">
                          {t("acceptanceCriteria.title")}
                        </label>
                        {summary && (
                          <Badge className={criterionStatusColor(task.acceptanceStatus || "pending")} variant="secondary">
                            {t("acceptanceCriteria.progress", { passed: summary.passed, total: summary.total })}
                          </Badge>
                        )}
                      </div>

                      <div className="mt-2 space-y-2">
                        {items.map((item) => (
                          <Card key={item.uuid} className="p-3">
                            <div className="flex items-start gap-2">
                              <div className="mt-0.5 shrink-0">
                                {criterionStatusIcon(item.status)}
                              </div>
                              <div className="flex-1 min-w-0">
                                <div className="flex items-center gap-2 flex-wrap">
                                  <span className="text-xs text-[#2C2C2C]">{item.description}</span>
                                  <Badge variant="outline" className="text-[10px] shrink-0">
                                    {item.required ? t("acceptanceCriteria.required") : t("acceptanceCriteria.optional")}
                                  </Badge>
                                </div>

                                {/* Dual-track rows */}
                                <div className="mt-2 space-y-1">
                                  <div className="flex items-center gap-2 text-[10px]">
                                    <span className="text-[#9A9A9A] w-20 shrink-0">{t("acceptanceCriteria.devSelfCheck")}</span>
                                    <Badge className={`text-[10px] ${criterionStatusColor(item.devStatus)}`} variant="secondary">
                                      {criterionStatusIcon(item.devStatus)}
                                      <span className="ml-1">{t(`acceptanceCriteria.status.${item.devStatus}`)}</span>
                                    </Badge>
                                  </div>
                                  <div className="flex items-center gap-2 text-[10px]">
                                    <span className="text-[#9A9A9A] w-20 shrink-0">{t("acceptanceCriteria.verification")}</span>
                                    <Badge className={`text-[10px] ${criterionStatusColor(item.status)}`} variant="secondary">
                                      {criterionStatusIcon(item.status)}
                                      <span className="ml-1">{t(`acceptanceCriteria.status.${item.status}`)}</span>
                                    </Badge>
                                  </div>
                                </div>

                                {/* Evidence — show both tracks separately */}
                                {item.devEvidence && (
                                  <div className="mt-2 rounded bg-[#FAF8F4] p-2">
                                    <span className="text-[10px] font-medium text-[#9A9A9A]">{t("acceptanceCriteria.devEvidence")}</span>
                                    <p className="text-[11px] text-[#2C2C2C] mt-0.5">{item.devEvidence}</p>
                                  </div>
                                )}
                                {item.evidence && (
                                  <div className="mt-2 rounded bg-[#FAF8F4] p-2">
                                    <span className="text-[10px] font-medium text-[#9A9A9A]">{t("acceptanceCriteria.verifyEvidence")}</span>
                                    <p className="text-[11px] text-[#2C2C2C] mt-0.5">{item.evidence}</p>
                                  </div>
                                )}

                                {/* Admin action buttons */}
                                {item.status === "pending" ? (
                                  <div className="mt-2 flex gap-2">
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      className="h-8 min-h-[44px] sm:min-h-0 flex-1 sm:flex-none text-xs text-green-700 border-green-200 hover:bg-green-50"
                                      onClick={() => handleMarkCriterion(item.uuid, "passed")}
                                    >
                                      <CircleCheck className="h-3.5 w-3.5 mr-1" />
                                      {t("acceptanceCriteria.pass")}
                                    </Button>
                                    <Button
                                      size="sm"
                                      variant="outline"
                                      className="h-8 min-h-[44px] sm:min-h-0 flex-1 sm:flex-none text-xs text-red-700 border-red-200 hover:bg-red-50"
                                      onClick={() => handleMarkCriterion(item.uuid, "failed")}
                                    >
                                      <CircleX className="h-3.5 w-3.5 mr-1" />
                                      {t("acceptanceCriteria.fail")}
                                    </Button>
                                  </div>
                                ) : (
                                  <div className="mt-2">
                                    <Button
                                      size="sm"
                                      variant="ghost"
                                      className="h-7 min-h-[44px] sm:min-h-0 text-xs text-[#9A9A9A] hover:text-[#2C2C2C]"
                                      onClick={async () => {
                                        const result = await resetCriterionAction(task.uuid, item.uuid);
                                        if (result.success) router.refresh();
                                      }}
                                    >
                                      {t("acceptanceCriteria.undoVerification")}
                                    </Button>
                                  </div>
                                )}
                              </div>
                            </div>
                          </Card>
                        ))}

                        {/* Gate warning */}
                        {summary && (summary.requiredPending > 0 || summary.requiredFailed > 0) && (
                          <div className="flex items-center gap-2 rounded-lg bg-yellow-50 p-3 mt-2">
                            <AlertTriangle className="h-4 w-4 text-yellow-600 shrink-0" />
                            <span className="text-xs text-yellow-700">
                              {t("acceptanceCriteria.gateBlocked", { count: summary.requiredPending + summary.requiredFailed })}
                            </span>
                          </div>
                        )}
                        {summary && summary.requiredPending === 0 && summary.requiredFailed === 0 && summary.required > 0 && (
                          <div className="flex items-center gap-2 rounded-lg bg-green-50 p-3 mt-2">
                            <CircleCheck className="h-4 w-4 text-green-600 shrink-0" />
                            <span className="text-xs text-green-700">
                              {t("acceptanceCriteria.gateReady")}
                            </span>
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })()}

                {/* Activity Section - fills remaining space */}
                <div className="mt-5 flex-1">
                  <label className="text-[11px] font-medium uppercase tracking-wide text-[#9A9A9A]">
                    {t("common.activity")}
                  </label>
                  <div className="mt-2 space-y-3">
                    {isLoadingActivities ? (
                      <div className="flex items-center justify-center py-4">
                        <Loader2 className="h-4 w-4 animate-spin text-[#9A9A9A]" />
                      </div>
                    ) : activities.length === 0 ? (
                      <p className="text-sm text-[#9A9A9A] italic">{t("common.noActivity")}</p>
                    ) : (
                      activities.map((activity) => (
                        <div key={activity.uuid} className="flex items-start gap-2.5">
                          <div className="flex h-5 w-5 items-center justify-center rounded-full bg-[#F5F2EC]">
                            <div className={`h-2 w-2 rounded-full ${getActivityDotColor(activity.action)}`} />
                          </div>
                          <div className="flex-1">
                            <p className="text-xs text-[#2C2C2C]">
                              {formatActivityMessage(activity, t)}
                            </p>
                            <p className="text-[10px] text-[#9A9A9A]">{formatRelativeTime(activity.createdAt, t)}</p>
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </div>

                {/* Comments Section - at bottom */}
                <div className="mt-5">
                  <label className="text-[11px] font-medium uppercase tracking-wide text-[#9A9A9A]">
                    {t("comments.title")}
                  </label>
                  <div className="mt-3 space-y-3">
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
                              <span className="text-xs font-medium text-[#2C2C2C]">{c.author.name}</span>
                              <span className="text-[10px] text-[#9A9A9A]">{formatRelativeTime(c.createdAt, t)}</span>
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
            ) : null}
          </div>
        </ScrollArea>

        {/* Panel Footer */}
        <div className="border-t border-[#F5F2EC] px-6 py-4">
          <div className="flex items-center gap-3">
            {isEditing ? (
              <>
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
                      {t("common.saving")}
                    </>
                  ) : (
                    <>
                      <Check className="mr-2 h-4 w-4" />
                      {isCreateMode ? t("common.create") : t("tasks.saveChanges")}
                    </>
                  )}
                </Button>
              </>
            ) : task ? (
              <>
                {/* Assign button - always available except for done/closed */}
                {task.status !== "done" && task.status !== "closed" && (
                  <Button
                    variant="outline"
                    className="border-[#E5E0D8]"
                    onClick={() => setShowAssignModal(true)}
                    disabled={isLoading}
                  >
                    <User className="mr-2 h-4 w-4" />
                    {t("common.assign")}
                  </Button>
                )}
                {canStart && (
                  <Button
                    className="flex-1 bg-[#1976D2] hover:bg-[#1565C0] text-white"
                    onClick={() => handleStatusChange("in_progress")}
                    disabled={isLoading}
                  >
                    <Play className="mr-2 h-4 w-4" />
                    {t("tasks.startWork")}
                  </Button>
                )}
                {canMarkToVerify && (
                  <Button
                    className="flex-1 bg-[#7B1FA2] hover:bg-[#6A1B9A] text-white"
                    onClick={() => handleStatusChange("to_verify")}
                    disabled={isLoading}
                  >
                    <Eye className="mr-2 h-4 w-4" />
                    {t("tasks.submitForReview")}
                  </Button>
                )}
                {canMarkDone && (
                  <Button
                    className="flex-1 bg-[#22C55E] hover:bg-[#16A34A] text-white"
                    onClick={() => handleStatusChange("done")}
                    disabled={isLoading}
                  >
                    <CheckCircle className="mr-2 h-4 w-4" />
                    {t("tasks.markAsVerified")}
                  </Button>
                )}
                {(task.status === "done" || task.status === "closed") && (
                  <div className="text-sm text-[#9A9A9A] text-center w-full">
                    {t("tasks.taskCompleted")}
                  </div>
                )}
                <div className="ml-auto">
                  <AlertDialog>
                    <AlertDialogTrigger asChild>
                      <Button
                        variant="outline"
                        size="icon"
                        className="h-9 w-9 border-[#E5E0D8] text-[#D32F2F] hover:bg-[#FFEBEE] hover:text-[#D32F2F] hover:border-[#D32F2F]"
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </AlertDialogTrigger>
                    <AlertDialogContent>
                      <AlertDialogHeader>
                        <AlertDialogTitle>{t("tasks.deleteTask")}</AlertDialogTitle>
                        <AlertDialogDescription>
                          {t("tasks.deleteTaskConfirm", { title: task.title })}
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
              </>
            ) : null}
          </div>
        </div>
      </div>

      {/* Assign Task Modal */}
      {task && showAssignModal && (
        <AssignTaskModal
          task={task}
          projectUuid={projectUuid}
          currentUserUuid={currentUserUuid}
          onClose={() => setShowAssignModal(false)}
        />
      )}
    </>
  );
}
