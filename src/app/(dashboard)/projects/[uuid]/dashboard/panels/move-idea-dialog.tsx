"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2, AlertTriangle, Check, ChevronsUpDown } from "lucide-react";
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
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
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
  const [isPickerOpen, setIsPickerOpen] = useState(false);

  // Look up the selected project's display name for the trigger label.
  const selectedProjectName = (() => {
    if (!selectedProjectUuid) return null;
    for (const g of moveGroups) {
      const hit = g.projects.find((p) => p.uuid === selectedProjectUuid);
      if (hit) return hit.name;
    }
    return null;
  })();

  // Preview state — drives the count summary block and gates the Confirm button.
  const [preview, setPreview] = useState<MoveCounts | null>(null);
  const [isLoadingPreview, setIsLoadingPreview] = useState(false);
  const [previewError, setPreviewError] = useState<string | null>(null);

  const [isMoving, setIsMoving] = useState(false);
  const [moveError, setMoveError] = useState<string | null>(null);

  // Bump on each preview request to discard stale responses if the user picks
  // a different project before the previous fetch resolves.
  const previewReqIdRef = useRef(0);

  // Stable ref callback for the popover root — see PopoverContent below for
  // why this matters. useCallback identity prevents repeated re-attachment.
  const popoverRef = useCallback((el: HTMLDivElement | null) => {
    if (!el) return;
    const handler = (e: WheelEvent) => e.stopPropagation();
    el.addEventListener("wheel", handler, { passive: true });
    // Radix tears the node down on close, so the listener dies with it.
  }, []);

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
            // Searchable picker — Popover trigger keeps the dialog focused on
            // its own concerns (preview + confirm), while Command provides the
            // type-to-filter behavior the previous (pre-cascade) move dialog
            // had via CommandInput.
            <Popover open={isPickerOpen} onOpenChange={setIsPickerOpen}>
              <PopoverTrigger asChild>
                <Button
                  id="move-target-project"
                  variant="outline"
                  role="combobox"
                  aria-expanded={isPickerOpen}
                  className={cn(
                    "w-full justify-between border-[#E5E0D8] font-normal",
                    !selectedProjectName && "text-[#9A9A9A]",
                  )}
                >
                  {selectedProjectName ?? t("moveDialog.targetProjectPlaceholder")}
                  <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                </Button>
              </PopoverTrigger>
              <PopoverContent
                // Radix Dialog uses react-remove-scroll which attaches a
                // non-passive wheel listener on the document with
                // preventDefault on every wheel event outside its
                // shouldPreventScroll allow-list. The portaled popover lives
                // outside that list, so wheel events never reach the inner
                // CommandList's overflow-y-auto. Fix: attach our own passive
                // wheel listener at the popover root and stopPropagation in
                // bubble phase before remove-scroll's document handler sees
                // it. Also pointer-events-auto so clicks work despite the
                // body lock. ref must be stable (useCallback) — without it
                // every keystroke in CommandInput rerenders the parent and
                // attaches another listener on the same node.
                ref={popoverRef}
                className="w-[--radix-popover-trigger-width] p-0 pointer-events-auto"
                align="start"
              >
                <Command>
                  <CommandInput placeholder={t("moveDialog.searchProjects")} />
                  <CommandList>
                    <CommandEmpty>{t("noProjectsFound")}</CommandEmpty>
                    {moveGroups.map((group) => (
                      <CommandGroup key={group.uuid} heading={group.name}>
                        {group.projects.map((p) => (
                          <CommandItem
                            key={p.uuid}
                            // `value` is what cmdk filters against — include
                            // the project name + group name so users can find
                            // a project by either.
                            value={`${p.name} ${group.name}`}
                            onSelect={() => {
                              setSelectedProjectUuid(p.uuid);
                              setIsPickerOpen(false);
                            }}
                          >
                            <Check
                              className={cn(
                                "mr-2 h-4 w-4",
                                selectedProjectUuid === p.uuid ? "opacity-100" : "opacity-0",
                              )}
                            />
                            {p.name}
                          </CommandItem>
                        ))}
                      </CommandGroup>
                    ))}
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
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
