"use client";

import { useState, useEffect, useTransition, useMemo } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { X, Pencil, Trash2, Loader2, Check, Zap, GitBranch, Plus, ClipboardCheck } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Switch } from "@/components/ui/switch";
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
import { Streamdown } from "streamdown";
import { code } from "@streamdown/code";
import {
  addTaskDraftAction,
  updateTaskDraftAction,
  removeTaskDraftAction,
} from "./actions";

interface AcceptanceCriteriaItem {
  description: string;
  required?: boolean;
}

interface TaskDraft {
  uuid: string;
  title: string;
  description?: string;
  storyPoints?: number;
  priority?: string;
  acceptanceCriteria?: string;
  acceptanceCriteriaItems?: AcceptanceCriteriaItem[];
  dependsOnDraftUuids?: string[];
}

// Priority color mapping (Industrial Humanist palette)
const priorityColors: Record<string, { bg: string; text: string }> = {
  high: { bg: "bg-[#FFEBEE]", text: "text-[#C4574C]" },
  medium: { bg: "bg-[#FFF3E0]", text: "text-[#E65100]" },
  low: { bg: "bg-[#F5F2EC]", text: "text-[#6B6B6B]" },
};

interface TaskDraftDetailPanelProps {
  taskDraft: TaskDraft | null; // null = create mode
  allTaskDrafts: TaskDraft[];
  proposalUuid: string;
  canEdit: boolean;
  onClose: () => void;
  onSaved: () => void;
  onDeleted?: () => void;
}

export function TaskDraftDetailPanel({
  taskDraft,
  allTaskDrafts,
  proposalUuid,
  canEdit,
  onClose,
  onSaved,
  onDeleted,
}: TaskDraftDetailPanelProps) {
  const t = useTranslations();
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  // Track whether the initial slide-in animation has completed
  const [hasAnimated, setHasAnimated] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setHasAnimated(true), 300);
    return () => clearTimeout(timer);
  }, []);

  const isCreateMode = taskDraft === null;
  const [isEditing, setIsEditing] = useState(isCreateMode);

  // Form state
  const [editTitle, setEditTitle] = useState(taskDraft?.title || "");
  const [editDescription, setEditDescription] = useState(taskDraft?.description || "");
  const [editPriority, setEditPriority] = useState(taskDraft?.priority || "medium");
  const [editStoryPoints, setEditStoryPoints] = useState(
    taskDraft?.storyPoints?.toString() || ""
  );
  const [editAcceptanceCriteria, setEditAcceptanceCriteria] = useState(
    taskDraft?.acceptanceCriteria || ""
  );
  const [editCriteriaItems, setEditCriteriaItems] = useState<AcceptanceCriteriaItem[]>(
    taskDraft?.acceptanceCriteriaItems?.map((item) => ({ description: item.description, required: item.required ?? true })) || []
  );
  // Pending deps for create mode (stored locally until save)
  const [pendingDeps, setPendingDeps] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);

  // Current deps: from taskDraft in view mode, from pendingDeps in create mode
  const currentDeps = isCreateMode ? pendingDeps : (taskDraft?.dependsOnDraftUuids || []);

  // Dependency tasks resolved from UUIDs
  const depTasks = useMemo(() => {
    return currentDeps
      .map((uuid) => allTaskDrafts.find((d) => d.uuid === uuid))
      .filter(Boolean) as TaskDraft[];
  }, [currentDeps, allTaskDrafts]);

  // Available tasks for dependency picker (exclude self and existing deps)
  const availableDeps = useMemo(() => {
    const existingDeps = new Set(currentDeps);
    return allTaskDrafts.filter(
      (d) => d.uuid !== taskDraft?.uuid && !existingDeps.has(d.uuid)
    );
  }, [taskDraft?.uuid, currentDeps, allTaskDrafts]);

  // Cycle detection: BFS check
  const wouldCycle = (start: string, target: string): boolean => {
    const visited = new Set<string>();
    const queue = [start];
    while (queue.length > 0) {
      const current = queue.shift()!;
      if (current === target) return true;
      if (visited.has(current)) continue;
      visited.add(current);
      const task = allTaskDrafts.find((d) => d.uuid === current);
      if (task?.dependsOnDraftUuids) {
        queue.push(...task.dependsOnDraftUuids);
      }
    }
    return false;
  };

  const handleStartEdit = () => {
    if (!taskDraft) return;
    setEditTitle(taskDraft.title);
    setEditDescription(taskDraft.description || "");
    setEditPriority(taskDraft.priority || "medium");
    setEditStoryPoints(taskDraft.storyPoints?.toString() || "");
    setEditAcceptanceCriteria(taskDraft.acceptanceCriteria || "");
    setEditCriteriaItems(
      taskDraft.acceptanceCriteriaItems?.map((item) => ({ description: item.description, required: item.required ?? true })) || []
    );
    setError(null);
    setIsEditing(true);
  };

  const handleCancelEdit = () => {
    if (isCreateMode) {
      onClose();
      return;
    }
    setIsEditing(false);
    if (taskDraft) {
      setEditTitle(taskDraft.title);
      setEditDescription(taskDraft.description || "");
      setEditPriority(taskDraft.priority || "medium");
      setEditStoryPoints(taskDraft.storyPoints?.toString() || "");
      setEditAcceptanceCriteria(taskDraft.acceptanceCriteria || "");
      setEditCriteriaItems(
        taskDraft.acceptanceCriteriaItems?.map((item) => ({ description: item.description, required: item.required ?? true })) || []
      );
    }
    setError(null);
  };

  const handleSave = () => {
    if (!editTitle.trim()) {
      setError(t("proposals.titleRequired"));
      return;
    }

    setError(null);
    startTransition(async () => {
      // Filter out empty criteria items
      const validCriteriaItems = editCriteriaItems.filter((item) => item.description.trim().length > 0);

      const taskData = {
        title: editTitle.trim(),
        description: editDescription.trim() || undefined,
        priority: editPriority,
        storyPoints: editStoryPoints ? parseFloat(editStoryPoints) : undefined,
        acceptanceCriteria: editAcceptanceCriteria.trim() || undefined,
        acceptanceCriteriaItems: validCriteriaItems.length > 0
          ? validCriteriaItems.map((item) => ({ description: item.description.trim(), required: item.required ?? true }))
          : undefined,
        ...(isCreateMode && pendingDeps.length > 0
          ? { dependsOnDraftUuids: pendingDeps }
          : {}),
      };

      let result;
      if (isCreateMode) {
        result = await addTaskDraftAction(proposalUuid, taskData);
      } else {
        result = await updateTaskDraftAction(proposalUuid, taskDraft!.uuid, taskData);
      }

      if (result.success) {
        setIsEditing(false);
        router.refresh();
        onSaved();
      } else {
        setError(result.error || t("proposals.failedToSaveTaskDraft"));
      }
    });
  };

  const handleDelete = () => {
    if (!taskDraft) return;
    startTransition(async () => {
      const result = await removeTaskDraftAction(proposalUuid, taskDraft.uuid);
      if (result.success) {
        router.refresh();
        onDeleted?.();
      }
    });
  };

  const handleAddDependency = (depUuid: string) => {
    if (isCreateMode) {
      // In create mode, just add to local state
      setPendingDeps((prev) => [...prev, depUuid]);
      return;
    }

    if (!taskDraft) return;

    // Check for cycles
    if (wouldCycle(depUuid, taskDraft.uuid)) {
      setError(t("proposals.cyclicDependency"));
      return;
    }

    setError(null);
    const newDeps = [...(taskDraft.dependsOnDraftUuids || []), depUuid];
    startTransition(async () => {
      const result = await updateTaskDraftAction(proposalUuid, taskDraft.uuid, {
        dependsOnDraftUuids: newDeps,
      });
      if (result.success) {
        router.refresh();
        onSaved();
      } else {
        setError(result.error || t("proposals.failedToAddDependency"));
      }
    });
  };

  const handleRemoveDependency = (depUuid: string) => {
    if (isCreateMode) {
      // In create mode, just remove from local state
      setPendingDeps((prev) => prev.filter((uuid) => uuid !== depUuid));
      return;
    }

    if (!taskDraft) return;
    const newDeps = (taskDraft.dependsOnDraftUuids || []).filter(
      (uuid) => uuid !== depUuid
    );
    startTransition(async () => {
      const result = await updateTaskDraftAction(proposalUuid, taskDraft.uuid, {
        dependsOnDraftUuids: newDeps,
      });
      if (result.success) {
        router.refresh();
        onSaved();
      } else {
        setError(result.error || t("proposals.failedToAddDependency"));
      }
    });
  };

  const prio = priorityColors[taskDraft?.priority || "medium"] || priorityColors.medium;

  // Render dependency section (shared between view mode and edit/create form)
  const renderDependencies = () => (
    <div className="mt-5">
      <label className="text-[11px] font-medium uppercase tracking-wide text-[#9A9A9A]">
        {t("proposals.dependsOn")}
      </label>

      {depTasks.length > 0 ? (
        <div className="mt-2 space-y-1.5">
          {depTasks.map((dep) => (
            <div
              key={dep.uuid}
              className="group flex items-center justify-between rounded-lg bg-[#FAF8F4] p-2.5"
            >
              <div className="flex items-center gap-2 min-w-0">
                <GitBranch className="h-3.5 w-3.5 shrink-0 text-[#C67A52]" />
                <span className="text-xs text-[#2C2C2C] truncate">
                  {dep.title}
                </span>
              </div>
              {canEdit && (
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-6 w-6 opacity-0 group-hover:opacity-100 transition-opacity ml-2 shrink-0"
                  onClick={() => handleRemoveDependency(dep.uuid)}
                  disabled={isPending}
                >
                  <X className="h-3.5 w-3.5 text-[#9A9A9A] hover:text-[#D32F2F]" />
                </Button>
              )}
            </div>
          ))}
        </div>
      ) : (
        <p className="mt-2 text-sm italic text-[#9A9A9A]">
          {t("proposals.noDependencies")}
        </p>
      )}

      {/* Add Dependency Picker */}
      {canEdit && availableDeps.length > 0 && (
        <div className="mt-3">
          <Select
            key={depTasks.length}
            onValueChange={(uuid) => handleAddDependency(uuid)}
          >
            <SelectTrigger className="h-8 border-[#E5E0D8] text-xs text-[#6B6B6B] focus:ring-[#C67A52]">
              <div className="flex items-center gap-1.5">
                <Plus className="h-3 w-3" />
                <SelectValue placeholder={t("proposals.selectDependency")} />
              </div>
            </SelectTrigger>
            <SelectContent>
              {availableDeps.map((dep) => (
                <SelectItem key={dep.uuid} value={dep.uuid}>
                  <span className="truncate">{dep.title}</span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}
    </div>
  );

  // Render the edit/create form
  const renderEditForm = () => (
    <div className="space-y-5">
      {error && (
        <div className="rounded-lg bg-[#FFEBEE] p-3 text-sm text-[#C4574C]">{error}</div>
      )}

      <div className="space-y-2">
        <Label htmlFor="edit-title" className="text-[13px] font-medium text-[#2C2C2C]">
          {t("proposals.taskTitle")} *
        </Label>
        <Input
          id="edit-title"
          value={editTitle}
          onChange={(e) => setEditTitle(e.target.value)}
          placeholder={t("proposals.titlePlaceholder")}
          className="border-[#E5E2DC] text-sm focus-visible:ring-[#C67A52]"
          autoFocus
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="edit-description" className="text-[13px] font-medium text-[#2C2C2C]">
          {t("proposals.taskDescription")}
        </Label>
        <Textarea
          id="edit-description"
          value={editDescription}
          onChange={(e) => setEditDescription(e.target.value)}
          rows={4}
          className="border-[#E5E2DC] text-sm resize-none focus-visible:ring-[#C67A52]"
          placeholder={t("proposals.descriptionPlaceholder")}
        />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-2">
          <Label htmlFor="edit-priority" className="text-[13px] font-medium text-[#2C2C2C]">
            {t("proposals.taskPriority")}
          </Label>
          <Select value={editPriority} onValueChange={setEditPriority}>
            <SelectTrigger className="border-[#E5E2DC] text-sm focus:ring-[#C67A52]">
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
            {t("proposals.taskStoryPoints")}
          </Label>
          <Input
            id="edit-story-points"
            type="number"
            min="0"
            step="0.5"
            value={editStoryPoints}
            onChange={(e) => setEditStoryPoints(e.target.value)}
            placeholder={t("proposals.storyPointsPlaceholder")}
            className="border-[#E5E2DC] text-sm focus-visible:ring-[#C67A52]"
          />
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="edit-acceptance" className="text-[13px] font-medium text-[#2C2C2C]">
          {t("proposals.taskAcceptanceCriteria")}
        </Label>
        <Textarea
          id="edit-acceptance"
          value={editAcceptanceCriteria}
          onChange={(e) => setEditAcceptanceCriteria(e.target.value)}
          rows={4}
          className="border-[#E5E2DC] text-sm resize-none focus-visible:ring-[#C67A52] font-mono"
          placeholder="- [ ] Criterion 1&#10;- [ ] Criterion 2"
        />
      </div>

      {/* Acceptance Criteria Items (structured) */}
      <div className="space-y-3">
        <Label className="text-[13px] font-medium text-[#2C2C2C] flex items-center gap-1.5">
          <ClipboardCheck className="h-3.5 w-3.5 text-[#C67A52]" />
          {t("acceptanceCriteria.title")}
        </Label>
        {editCriteriaItems.length > 0 && (
          <div className="space-y-2">
            {editCriteriaItems.map((item, index) => (
              <div key={index} className="flex items-start gap-2 rounded-lg border border-[#E5E2DC] bg-[#FAF8F4] p-2.5">
                <div className="flex-1 min-w-0">
                  <Input
                    value={item.description}
                    onChange={(e) => {
                      const updated = [...editCriteriaItems];
                      updated[index] = { ...updated[index], description: e.target.value };
                      setEditCriteriaItems(updated);
                    }}
                    placeholder={t("acceptanceCriteria.criterionPlaceholder")}
                    className="border-[#E5E2DC] text-sm focus-visible:ring-[#C67A52] h-8"
                  />
                </div>
                <div className="flex items-center gap-2 shrink-0 pt-1">
                  <Switch
                    checked={item.required ?? true}
                    onCheckedChange={(checked) => {
                      const updated = [...editCriteriaItems];
                      updated[index] = { ...updated[index], required: checked };
                      setEditCriteriaItems(updated);
                    }}
                    className="data-[state=checked]:bg-[#C67A52]"
                  />
                  <span className="text-[10px] font-medium text-[#6B6B6B] min-w-[52px]">
                    {(item.required ?? true) ? t("acceptanceCriteria.required") : t("acceptanceCriteria.optional")}
                  </span>
                  <Button
                    variant="outline"
                    size="sm"
                    className="h-7 w-7 p-0 border-[#E5E2DC] text-[#9A9A9A] hover:text-[#D32F2F] hover:border-[#D32F2F] hover:bg-[#FFEBEE]"
                    onClick={() => {
                      setEditCriteriaItems(editCriteriaItems.filter((_, i) => i !== index));
                    }}
                  >
                    <Trash2 className="h-3 w-3" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        )}
        <Button
          variant="outline"
          size="sm"
          className="h-8 gap-1.5 border-[#E5E2DC] text-xs text-[#6B6B6B] hover:text-[#C67A52] hover:border-[#C67A52]"
          onClick={() => {
            setEditCriteriaItems([...editCriteriaItems, { description: "", required: true }]);
          }}
        >
          <Plus className="h-3 w-3" />
          {t("acceptanceCriteria.addCriterion")}
        </Button>
      </div>

      {/* Dependencies section in edit/create form */}
      {renderDependencies()}
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
                {isCreateMode ? t("proposals.newTaskDraft") : t("proposals.editTaskDraft")}
              </h2>
            ) : taskDraft ? (
              <>
                <h2 className="text-base font-semibold text-[#2C2C2C] truncate">
                  {taskDraft.title}
                </h2>
                <div className="mt-1.5 flex items-center gap-2">
                  {taskDraft.priority && (
                    <Badge className={`text-[10px] font-medium border-0 ${prio.bg} ${prio.text}`}>
                      {t(`priority.${taskDraft.priority}`)}
                    </Badge>
                  )}
                  {taskDraft.storyPoints != null && taskDraft.storyPoints > 0 && (
                    <span className="flex items-center gap-1 rounded bg-[#F5F2EC] px-2 py-0.5 text-xs font-medium text-[#6B6B6B]">
                      <Zap className="h-2.5 w-2.5 text-[#C67A52]" />
                      {taskDraft.storyPoints} SP
                    </span>
                  )}
                </div>
              </>
            ) : null}
          </div>

          <div className="flex items-center gap-2 ml-4">
            {taskDraft && !isEditing && canEdit && (
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
            ) : taskDraft ? (
              <>
                {/* Description Section */}
                <div>
                  <label className="text-[11px] font-medium uppercase tracking-wide text-[#9A9A9A]">
                    {t("common.description")}
                  </label>
                  <div className="mt-2">
                    {taskDraft.description ? (
                      <div className="prose prose-sm max-w-none text-[13px] leading-relaxed text-[#2C2C2C]">
                        <Streamdown plugins={{ code }}>{taskDraft.description}</Streamdown>
                      </div>
                    ) : (
                      <p className="text-sm italic text-[#9A9A9A]">{t("common.noDescription")}</p>
                    )}
                  </div>
                </div>

                {/* Acceptance Criteria Section (legacy markdown) */}
                {taskDraft.acceptanceCriteria && (
                  <div className="mt-5">
                    <label className="text-[11px] font-medium uppercase tracking-wide text-[#9A9A9A]">
                      {t("tasks.acceptanceCriteria")}
                    </label>
                    <div className="mt-2">
                      <div className="prose prose-sm max-w-none text-[13px] leading-relaxed text-[#2C2C2C]">
                        <Streamdown plugins={{ code }}>{taskDraft.acceptanceCriteria}</Streamdown>
                      </div>
                    </div>
                  </div>
                )}

                {/* Acceptance Criteria Items (structured) */}
                {taskDraft.acceptanceCriteriaItems && taskDraft.acceptanceCriteriaItems.length > 0 && (
                  <div className="mt-5">
                    <label className="text-[11px] font-medium uppercase tracking-wide text-[#9A9A9A] flex items-center gap-1.5">
                      <ClipboardCheck className="h-3 w-3" />
                      {t("acceptanceCriteria.title")}
                    </label>
                    <div className="mt-2 space-y-1.5">
                      {taskDraft.acceptanceCriteriaItems.map((item, index) => (
                        <div
                          key={index}
                          className="flex items-center gap-2.5 rounded-lg bg-[#FAF8F4] p-2.5"
                        >
                          <span className="flex-1 text-[13px] text-[#2C2C2C]">
                            {item.description}
                          </span>
                          <Badge
                            className={`text-[10px] font-medium border-0 shrink-0 ${
                              (item.required ?? true)
                                ? "bg-[#FFF3E0] text-[#E65100]"
                                : "bg-[#F5F2EC] text-[#6B6B6B]"
                            }`}
                          >
                            {(item.required ?? true) ? t("acceptanceCriteria.required") : t("acceptanceCriteria.optional")}
                          </Badge>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* Dependencies Section */}
                {error && (
                  <div className="mt-5 rounded-lg bg-[#FFEBEE] p-2.5 text-xs text-[#C4574C]">
                    {error}
                  </div>
                )}
                {renderDependencies()}
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
                  disabled={isPending}
                >
                  {t("common.cancel")}
                </Button>
                <Button
                  className="bg-[#C67A52] hover:bg-[#B56A42] text-white"
                  onClick={handleSave}
                  disabled={isPending || !editTitle.trim()}
                >
                  {isPending ? (
                    <>
                      <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      {t("common.saving")}
                    </>
                  ) : (
                    <>
                      <Check className="mr-2 h-4 w-4" />
                      {isCreateMode ? t("common.create") : t("common.save")}
                    </>
                  )}
                </Button>
              </>
            ) : taskDraft ? (
              <>
                {canEdit && (
                  <Button
                    variant="outline"
                    className="border-[#E5E0D8]"
                    onClick={handleStartEdit}
                  >
                    <Pencil className="mr-2 h-4 w-4" />
                    {t("common.edit")}
                  </Button>
                )}
                {canEdit && (
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
                          <AlertDialogTitle>{t("proposals.deleteTaskDraft")}</AlertDialogTitle>
                          <AlertDialogDescription>
                            {t("proposals.deleteTaskDraftConfirm")}
                          </AlertDialogDescription>
                        </AlertDialogHeader>
                        <AlertDialogFooter>
                          <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
                          <AlertDialogAction
                            onClick={handleDelete}
                            disabled={isPending}
                            className="bg-[#D32F2F] hover:bg-[#B71C1C] text-white"
                          >
                            {isPending ? (
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
              </>
            ) : null}
          </div>
        </div>
      </div>
    </>
  );
}
