"use client";

import { useState, useEffect, useCallback } from "react";
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
import { BasicView } from "./basic-view";
import { ElaborationView } from "./elaboration-view";
import { ProposalView } from "./proposal-view";
import { TaskDetailPanel } from "@/app/(dashboard)/projects/[uuid]/tasks/task-detail-panel";
import { DocumentPanel } from "./document-panel";
import { ActivityTimeline } from "./activity-timeline";
import { CommentsSection } from "./comments-section";
import { MoveIdeaDialog } from "./move-idea-dialog";
import { deleteIdeaAction, updateIdeaAction } from "@/app/(dashboard)/projects/[uuid]/ideas/actions";
import { getIdeaAction, getTaskAction } from "./actions";
import { AssignIdeaModal } from "@/app/(dashboard)/projects/[uuid]/ideas/assign-idea-modal";
import type { IdeaResponse } from "@/services/idea.service";

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
  derivePanelStatus,
  DERIVED_STATUS_COLORS as derivedStatusColors,
  DERIVED_STATUS_I18N_KEYS as derivedStatusI18nKeys,
} from "../utils";

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
  const [idea, setIdea] = useState<IdeaResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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

  // Fetch task when selected from proposal view
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

  const status = idea ? derivePanelStatus(idea.status, idea.elaborationStatus) : "todo";
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
            {idea && idea.status !== "completed" && idea.status !== "closed" && !isEditing && (
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
              <>
                <PanelContent
                  idea={idea}
                  projectUuid={projectUuid}
                  currentUserUuid={currentUserUuid}
                  onRefresh={fetchIdea}
                  onTaskClick={setSelectedTaskUuid}
                  onDocClick={setSelectedDoc}
                />

                <ActivityTimeline ideaUuid={ideaUuid} />

                <CommentsSection
                  ideaUuid={ideaUuid}
                  currentUserUuid={currentUserUuid}
                />
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

// Route to the correct view based on the idea's raw status
function PanelContent({
  idea,
  projectUuid,
  currentUserUuid,
  onRefresh,
  onTaskClick,
  onDocClick,
}: {
  idea: IdeaResponse;
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
