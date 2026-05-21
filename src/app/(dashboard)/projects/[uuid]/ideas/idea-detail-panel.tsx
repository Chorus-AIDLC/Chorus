"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { X, Bot, User, FileText, Loader2, Pencil, Check, Trash2, ArrowRightLeft } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
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
import { UnifiedComments } from "@/components/unified-comments";
import { getIdeaActivitiesAction } from "./[ideaUuid]/activity-actions";
import { updateIdeaAction, deleteIdeaAction } from "./actions";
import type { ActivityResponse } from "@/services/activity.service";
import { MarkdownContent } from "@/components/markdown-content";
import { ContentWithMentions } from "@/components/mention-renderer";
import { AssignIdeaModal } from "./assign-idea-modal";
import { MoveIdeaDialog } from "@/app/(dashboard)/projects/[uuid]/dashboard/panels/move-idea-dialog";
import { ElaborationPanel } from "@/components/elaboration-panel";
import { getElaborationAction, skipElaborationAction } from "./[ideaUuid]/elaboration-actions";
import { useRealtimeEntityTypeEvent, useRealtimeEntityEvent } from "@/contexts/realtime-context";
import type { ElaborationResponse } from "@/types/elaboration";
import { motion } from "framer-motion";
import { fadeIn } from "@/lib/animation";
import { formatDateTime } from "@/lib/format-date";

interface Idea {
  uuid: string;
  title: string;
  content: string | null;
  status: string;
  elaborationStatus?: string;
  assignee: {
    type: string;
    uuid: string;
    name: string;
    assignedAt: string | null;
    assignedBy: { type: string; uuid: string; name: string } | null;
  } | null;
  createdAt: string;
}

interface IdeaDetailPanelProps {
  idea: Idea;
  projectUuid: string;
  currentUserUuid: string;
  isUsedInProposal: boolean;
  onClose: () => void;
  onDeleted?: () => void;
}

// Status color configuration
const statusColors: Record<string, string> = {
  open: "bg-[#FFF3E0] text-[#E65100]",
  elaborating: "bg-[#E3F2FD] text-[#1976D2]",
  elaborated: "bg-[#E0F2F1] text-[#00796B]",
};

const statusI18nKeys: Record<string, string> = {
  open: "open",
  elaborating: "elaborating",
  elaborated: "elaborated",
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
  return formatDateTime(date);
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

export function IdeaDetailPanel({
  idea,
  projectUuid,
  currentUserUuid,
  isUsedInProposal,
  onClose,
  onDeleted,
}: IdeaDetailPanelProps) {
  const t = useTranslations();
  const router = useRouter();
  const [activities, setActivities] = useState<ActivityResponse[]>([]);
  const [isLoadingActivities, setIsLoadingActivities] = useState(true);
  const [showAssignModal, setShowAssignModal] = useState(false);

  // Elaboration state
  const [elaboration, setElaboration] = useState<ElaborationResponse | null>(null);
  const isLoadingElaboration = false; // Loaded via useRealtimeEvent

  // Reload elaboration data (called on mount + SSE events)
  const reloadElaboration = useCallback(async () => {
    const result = await getElaborationAction(idea.uuid);
    if (result.success && result.data) {
      setElaboration(result.data);
    }
  }, [idea.uuid]);

  // Load elaboration on mount
  useEffect(() => {
    reloadElaboration();
  }, [reloadElaboration]);

  // Subscribe to SSE events to refresh elaboration when idea changes
  useRealtimeEntityTypeEvent("idea", reloadElaboration);

  // Skip elaboration state
  const [showSkipDialog, setShowSkipDialog] = useState(false);
  const [skipReason, setSkipReason] = useState("");
  const [isSkipping, setIsSkipping] = useState(false);
  const [skipError, setSkipError] = useState<string | null>(null);

  // Edit mode state
  const [isEditing, setIsEditing] = useState(false);
  const [editTitle, setEditTitle] = useState(idea.title);
  const [editContent, setEditContent] = useState(idea.content || "");
  const [isSaving, setIsSaving] = useState(false);
  const [editError, setEditError] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  // Move-to-project dialog open state. The dialog itself owns project list +
  // preview + execute logic — see MoveIdeaDialog under dashboard/panels/.
  const [showMoveDialog, setShowMoveDialog] = useState(false);

  // Track whether the initial slide-in animation has completed
  // so that server re-renders don't replay the entrance animation
  const [hasAnimated, setHasAnimated] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setHasAnimated(true), 300);
    return () => clearTimeout(timer);
  }, []);

  const canAssign = idea.status !== "elaborated";
  const elaborationResolved = idea.elaborationStatus === "resolved";
  const canCreateProposal =
    (idea.status === "elaborating" || idea.status === "elaborated") &&
    elaborationResolved;
  const canSkipElaboration =
    idea.status === "elaborating" &&
    (!idea.elaborationStatus || idea.elaborationStatus !== "resolved") &&
    (idea.assignee?.uuid === currentUserUuid);
  const canEdit = idea.status !== "elaborated";

  useEffect(() => {
    async function loadActivities() {
      setIsLoadingActivities(true);
      const result = await getIdeaActivitiesAction(idea.uuid);
      setActivities(result.activities);
      setIsLoadingActivities(false);
    }
    loadActivities();
  }, [idea.uuid]);

  // Reset edit state when idea changes
  useEffect(() => {
    setIsEditing(false);
    setEditTitle(idea.title);
    setEditContent(idea.content || "");
    setEditError(null);
  }, [idea.uuid, idea.title, idea.content]);

  const handleStartEdit = () => {
    setEditTitle(idea.title);
    setEditContent(idea.content || "");
    setEditError(null);
    setIsEditing(true);
  };

  const handleCancelEdit = () => {
    setIsEditing(false);
    setEditTitle(idea.title);
    setEditContent(idea.content || "");
    setEditError(null);
  };

  const handleSaveEdit = async () => {
    if (!editTitle.trim()) {
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
      router.refresh();
    } else {
      setEditError(result.error || t("ideas.updateFailed"));
    }
  };

  const handleDelete = async () => {
    setIsDeleting(true);
    const result = await deleteIdeaAction(idea.uuid, projectUuid);
    setIsDeleting(false);

    if (result.success) {
      onDeleted?.();
      onClose();
      router.refresh();
    }
  };

  const handleSkipElaboration = async () => {
    if (!skipReason.trim()) {
      setSkipError(t("elaboration.skipReasonRequired"));
      return;
    }

    setIsSkipping(true);
    setSkipError(null);

    const result = await skipElaborationAction(idea.uuid, skipReason.trim());

    setIsSkipping(false);

    if (result.success) {
      setShowSkipDialog(false);
      setSkipReason("");
      router.refresh();
    } else {
      setSkipError(result.error || t("common.genericError"));
    }
  };

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
                {t("ideas.editIdea")}
              </h2>
            ) : (
              <>
                <h2 className="text-base font-semibold text-[#2C2C2C] truncate">
                  {idea.title}
                </h2>
                <div className="mt-1.5 flex items-center gap-2">
                  <Badge className={statusColors[idea.status] || ""}>
                    {t(`status.${statusI18nKeys[idea.status] || idea.status}`)}
                  </Badge>
                  <span className="text-xs text-[#9A9A9A]">
                    {formatDateTime(idea.createdAt)}
                  </span>
                </div>
              </>
            )}
          </div>

          <div className="flex items-center gap-2 ml-4">
            {!isEditing && (
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
            {canEdit && !isEditing && (
              <Button
                variant="outline"
                size="icon"
                className="h-8 w-8 border-[#E5E0D8]"
                onClick={handleStartEdit}
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

        {/* Panel Body - Scrollable */}
        <ScrollArea className="flex-1 min-h-0 [&_[data-slot=scroll-area-viewport]>div]:!block">
          <div className="flex min-h-full flex-col px-6 py-5">
            {isEditing ? (
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
              /* View Mode */
              <motion.div variants={fadeIn} initial="initial" animate="animate">
                {/* Assignee Section */}
                <div>
                  <label className="text-[11px] font-medium uppercase tracking-wider text-[#9A9A9A]">
                    {t("common.assignee")}
                  </label>
                  <div className="mt-2 flex items-center gap-2.5 rounded-lg bg-[#FAF8F4] p-3">
                    {idea.assignee ? (
                      <>
                        <Avatar className="h-7 w-7">
                          <AvatarFallback className={idea.assignee.type === "agent" ? "bg-[#C67A52] text-white" : "bg-[#E5E0D8] text-[#6B6B6B]"}>
                            {idea.assignee.type === "agent" ? (
                              <Bot className="h-3.5 w-3.5" />
                            ) : (
                              idea.assignee.name.charAt(0).toUpperCase()
                            )}
                          </AvatarFallback>
                        </Avatar>
                        <div>
                          <div className="text-sm font-medium text-[#2C2C2C]">
                            {idea.assignee.name}
                          </div>
                          <div className="text-xs text-[#6B6B6B]">
                            {idea.assignee.type === "agent"
                              ? `${t("common.agent")} • ${idea.assignee.assignedAt ? formatDateTime(idea.assignee.assignedAt) : ""}`
                              : t("common.user")}
                          </div>
                        </div>
                      </>
                    ) : (
                      <span className="text-sm text-[#9A9A9A]">{t("common.unassigned")}</span>
                    )}
                  </div>
                </div>

                {/* Elaboration Section */}
                {!isLoadingElaboration && elaboration && elaboration.rounds.length > 0 && (
                  <div className="mt-5">
                    <ElaborationPanel
                      ideaUuid={idea.uuid}
                      elaboration={elaboration}
                      onRefresh={async () => {
                        const result = await getElaborationAction(idea.uuid);
                        if (result.success && result.data) {
                          setElaboration(result.data);
                        }
                      }}
                    />
                  </div>
                )}

                {/* Content Section */}
                <div className="mt-5">
                  <label className="text-[11px] font-medium uppercase tracking-wider text-[#9A9A9A]">
                    {t("common.content")}
                  </label>
                  <div className="mt-2">
                    {idea.content ? (
                      <div className="prose prose-sm max-w-none text-[13px] leading-relaxed text-[#2C2C2C]">
                        <MarkdownContent>{idea.content}</MarkdownContent>
                      </div>
                    ) : (
                      <p className="text-sm italic text-[#9A9A9A]">{t("common.noContent")}</p>
                    )}
                  </div>
                </div>

                {/* Activity Section */}
                <div className="mt-5 flex-1">
                  <label className="text-[11px] font-medium uppercase tracking-wider text-[#9A9A9A]">
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
                          <div className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-[#9A9A9A]" />
                          <div className="flex-1">
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
                  <div className="mt-2">
                    <UnifiedComments
                      targetType="idea"
                      targetUuid={idea.uuid}
                      currentUserUuid={currentUserUuid}
                      compact
                    />
                  </div>
                </div>
              </motion.div>
            )}
          </div>
        </ScrollArea>

        {/* Panel Footer */}
        <div className="border-t border-[#F5F2EC] px-6 py-4">
          <div className="flex items-center justify-between gap-3">
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
                      {t("ideas.saveChanges")}
                    </>
                  )}
                </Button>
              </>
            ) : (
              <>
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
                {/* Middle area: help text or action buttons */}
                <div className="flex-1 min-w-0">
                  {canSkipElaboration && (
                    <Button
                      variant="outline"
                      size="sm"
                      className="border-[#E5E0D8]"
                      onClick={() => {
                        setSkipReason("");
                        setSkipError(null);
                        setShowSkipDialog(true);
                      }}
                    >
                      {t("elaboration.skipButton")}
                    </Button>
                  )}
                  {canCreateProposal && (
                    <Link href={`/projects/${projectUuid}/proposals/new?ideaUuid=${idea.uuid}`}>
                      <Button className="bg-[#C67A52] hover:bg-[#B56A42] text-white">
                        <FileText className="mr-2 h-4 w-4" />
                        {t("proposals.createProposal")}
                      </Button>
                    </Link>
                  )}
                  {idea.status === "elaborating" && !elaborationResolved && !canSkipElaboration && (
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
              </>
            )}
          </div>
        </div>
      </div>

      {/* Skip Elaboration Dialog */}
      <AlertDialog open={showSkipDialog} onOpenChange={setShowSkipDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t("elaboration.skipConfirmTitle")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("elaboration.skipConfirmDescription")}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <div className="space-y-2 py-2">
            <Label htmlFor="skip-reason" className="text-[13px] font-medium text-[#2C2C2C]">
              {t("elaboration.skipReasonLabel")}
            </Label>
            <Input
              id="skip-reason"
              value={skipReason}
              onChange={(e) => {
                setSkipReason(e.target.value);
                if (skipError) setSkipError(null);
              }}
              placeholder={t("elaboration.skipReasonPlaceholder")}
              className="border-[#E5E0D8] text-sm focus-visible:ring-[#C67A52]"
              autoFocus
            />
            {skipError && (
              <p className="text-xs text-destructive">{skipError}</p>
            )}
          </div>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isSkipping}>{t("common.cancel")}</AlertDialogCancel>
            <AlertDialogAction
              onClick={(e) => {
                e.preventDefault();
                handleSkipElaboration();
              }}
              disabled={isSkipping || !skipReason.trim()}
              className="bg-[#C67A52] hover:bg-[#B56A42] text-white"
            >
              {isSkipping ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {t("common.processing")}
                </>
              ) : (
                t("elaboration.skipButton")
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      {/* Move to Project Dialog — shared component handles preview + execute. */}
      <MoveIdeaDialog
        open={showMoveDialog}
        onOpenChange={setShowMoveDialog}
        ideaUuid={idea.uuid}
        projectUuid={projectUuid}
        onMoved={() => {
          // After a successful move the idea no longer belongs to this project,
          // so collapse the panel and let the parent list re-render.
          onClose();
        }}
      />

      {/* Assign Idea Modal */}
      {showAssignModal && (
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
            onClose();
          }}
        />
      )}
    </>
  );
}
