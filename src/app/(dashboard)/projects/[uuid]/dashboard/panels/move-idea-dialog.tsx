"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  moveIdeaAction,
  moveIdeaPreviewAction,
  getProjectsAndGroupsAction,
} from "./actions";
import { clientLogger } from "@/lib/logger-client";

interface MoveGroup {
  uuid: string;
  name: string;
  projects: { uuid: string; name: string }[];
}

interface MoveCounts {
  proposals: number;
  documents: number;
  tasks: number;
  activities: number;
}

interface MoveIdeaDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  ideaUuid: string;
  /** Current project — excluded from the target list. */
  projectUuid: string;
  /** Called after a successful move. The dialog closes and `router.refresh()` runs
   *  before this fires; callers typically use it to close their parent panel. */
  onMoved: (moved: MoveCounts) => void;
}

export function MoveIdeaDialog({
  open,
  onOpenChange,
  ideaUuid,
  projectUuid,
  onMoved,
}: MoveIdeaDialogProps) {
  const t = useTranslations("ideas");
  const tCommon = useTranslations("common");
  const router = useRouter();

  const [moveGroups, setMoveGroups] = useState<MoveGroup[]>([]);
  const [isLoadingProjects, setIsLoadingProjects] = useState(false);
  const [selectedProjectUuid, setSelectedProjectUuid] = useState<string | null>(null);

  // Preview state — drives the count summary block and gates the Confirm button.
  const [preview, setPreview] = useState<MoveCounts | null>(null);
  const [isLoadingPreview, setIsLoadingPreview] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const [isMoving, setIsMoving] = useState(false);
  const [moveError, setMoveError] = useState<string | null>(null);

  // Bump on each preview request to discard stale responses if the user picks
  // a different project before the previous fetch resolves.
  const previewReqIdRef = useRef(0);

  const loadProjects = useCallback(async () => {
    setSelectedProjectUuid(null);
    setPreview(null);
    setPreviewError(null);
    setMoveError(null);
    setIsLoadingProjects(true);
    try {
      const result = await getProjectsAndGroupsAction();
      if (result.success) {
        const { projects: allProjects, groups: allGroups } = result.data;
        const projects = allProjects
          .filter((p: { uuid: string }) => p.uuid !== projectUuid)
          .map((p: { uuid: string; name: string; groupUuid: string | null }) => ({
            uuid: p.uuid,
            name: p.name,
            groupUuid: p.groupUuid,
          }));

        const groupMap = new Map<string, string>();
        for (const g of allGroups) {
          groupMap.set(g.uuid, g.name);
        }

        const grouped = new Map<string, MoveGroup>();
        const ungrouped: { uuid: string; name: string }[] = [];

        for (const p of projects) {
          if (p.groupUuid && groupMap.has(p.groupUuid)) {
            if (!grouped.has(p.groupUuid)) {
              grouped.set(p.groupUuid, {
                uuid: p.groupUuid,
                name: groupMap.get(p.groupUuid)!,
                projects: [],
              });
            }
            grouped.get(p.groupUuid)!.projects.push({ uuid: p.uuid, name: p.name });
          } else {
            ungrouped.push({ uuid: p.uuid, name: p.name });
          }
        }

        const groups = [...grouped.values()];
        if (ungrouped.length > 0) {
          groups.push({ uuid: "ungrouped", name: t("ungrouped"), projects: ungrouped });
        }
        setMoveGroups(groups);
      }
    } catch (e) {
      clientLogger.error("Failed to load projects for move dialog:", e);
      setMoveGroups([]);
    }
    setIsLoadingProjects(false);
  }, [projectUuid, t]);

  // Load projects when dialog opens.
  useEffect(() => {
    if (open) {
      loadProjects();
    }
  }, [open, loadProjects]);

  // When the user picks a target, fetch the cascade preview. Stale responses
  // from a previously-selected target are dropped via previewReqIdRef.
  useEffect(() => {
    if (!selectedProjectUuid) {
      setPreview(null);
      setPreviewError(null);
      return;
    }
    const reqId = ++previewReqIdRef.current;
    setIsLoadingPreview(true);
    setPreviewError(null);
    setPreview(null);
    moveIdeaPreviewAction(ideaUuid, selectedProjectUuid)
      .then((result) => {
        if (reqId !== previewReqIdRef.current) return;
        if (result.success) {
          setPreview(result.moved);
        } else {
          setPreviewError(result.error || t("moveDialog.error", { message: "" }));
        }
      })
      .catch((e) => {
        if (reqId !== previewReqIdRef.current) return;
        clientLogger.error("Failed to fetch move preview:", e);
        setPreviewError(t("moveDialog.error", { message: e instanceof Error ? e.message : String(e) }));
      })
      .finally(() => {
        if (reqId !== previewReqIdRef.current) return;
        setIsLoadingPreview(false);
      });
  }, [selectedProjectUuid, ideaUuid, t]);

  const handleMove = async () => {
    if (!selectedProjectUuid || !preview || isMoving) return;
    setIsMoving(true);
    setMoveError(null);

    try {
      const result = await moveIdeaAction(ideaUuid, selectedProjectUuid);
      if (result.success) {
        const moved = result.moved;
        toast.success(t("moveDialog.successToast", { ...moved }), {
          action: {
            label: t("moveDialog.viewMovedIdea"),
            onClick: () => {
              router.push(
                `/projects/${selectedProjectUuid}/dashboard?panel=${ideaUuid}&tab=overview`,
              );
            },
          },
        });
        onOpenChange(false);
        // router.refresh() before onMoved so the parent re-renders against the
        // already-moved data once it closes.
        router.refresh();
        onMoved(moved);
      } else {
        setMoveError(t("moveDialog.error", { message: result.error || t("moveFailed") }));
      }
    } catch (e) {
      setMoveError(
        t("moveDialog.error", {
          message: e instanceof Error ? e.message : t("moveFailed"),
        }),
      );
    }
    setIsMoving(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("moveDialog.title")}</DialogTitle>
          <DialogDescription>{t("moveDialog.description")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-3 pt-1">
          <Label htmlFor="move-target-project" className="text-[13px] font-medium text-[#2C2C2C]">
            {t("moveDialog.targetProjectLabel")}
          </Label>

          {isLoadingProjects ? (
            <div className="flex items-center justify-center h-10 border border-[#E5E0D8] rounded-md">
              <Loader2 className="h-4 w-4 animate-spin text-[#9A9A9A]" />
            </div>
          ) : (
            <Select
              // Empty string keeps the Select in controlled mode from the
              // start so React doesn't warn about uncontrolled→controlled
              // when the first value is selected.
              value={selectedProjectUuid ?? ""}
              onValueChange={(v) => setSelectedProjectUuid(v)}
            >
              <SelectTrigger id="move-target-project" className="border-[#E5E0D8]">
                <SelectValue placeholder={t("moveDialog.targetProjectPlaceholder")} />
              </SelectTrigger>
              <SelectContent>
                {moveGroups.length === 0 ? (
                  <div className="px-2 py-3 text-xs text-[#9A9A9A]">
                    {t("noProjectsFound")}
                  </div>
                ) : (
                  moveGroups.map((group) => (
                    <SelectGroup key={group.uuid}>
                      <SelectLabel>{group.name}</SelectLabel>
                      {group.projects.map((p) => (
                        <SelectItem key={p.uuid} value={p.uuid}>
                          {p.name}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  ))
                )}
              </SelectContent>
            </Select>
          )}

          {/* Preview block — only rendered after a target is picked. */}
          {selectedProjectUuid && (
            <div
              role="status"
              aria-live="polite"
              className="rounded-lg border border-[#E5E0D8] bg-[#FAF8F4] p-3 text-[13px] text-[#2C2C2C]"
            >
              {isLoadingPreview ? (
                <div className="flex items-center gap-2 text-[#6B6B6B]">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  <span>{t("moveDialog.previewLoading")}</span>
                </div>
              ) : previewError ? (
                <div className="flex items-start gap-2 text-destructive">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>{previewError}</span>
                </div>
              ) : preview ? (
                <div className="space-y-1">
                  <p>{t("moveDialog.previewSummary", { ...preview })}</p>
                  <p className="text-[12px] text-[#9A9A9A]">{t("moveDialog.previewWarning")}</p>
                </div>
              ) : null}
            </div>
          )}

          {moveError && (
            <p className="text-xs text-destructive" role="alert">
              {moveError}
            </p>
          )}
        </div>

        <div className="flex justify-end gap-3 pt-2">
          <Button
            variant="outline"
            className="border-[#E5E0D8]"
            onClick={() => onOpenChange(false)}
            disabled={isMoving}
          >
            {tCommon("cancel")}
          </Button>
          <Button
            className="bg-[#C67A52] hover:bg-[#B56A42] text-white"
            onClick={handleMove}
            disabled={!selectedProjectUuid || !preview || isMoving || isLoadingPreview}
          >
            {isMoving ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                {t("moving")}
              </>
            ) : (
              t("moveDialog.confirm")
            )}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
