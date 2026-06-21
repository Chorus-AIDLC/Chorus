"use client";

import { useState, useEffect, useCallback } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2, Ban, Info } from "lucide-react";
import { Button } from "@/components/ui/button";
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
import { cn } from "@/lib/utils";
import { setIdeaParentAction, getProjectIdeasForPickerAction } from "./actions";
import { clientLogger } from "@/lib/logger-client";

interface SetParentDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  ideaUuid: string;
  ideaTitle: string;
  projectUuid: string;
  /** The idea's current parent, if any (preselected / shows current state). */
  currentParentUuid?: string | null;
  /** Transitive descendants of this idea — disabled in the picker (would cycle). */
  descendantUuids: string[];
  /** Called after a successful parent change so the panel can refresh. */
  onChanged: () => void;
}

interface PickerIdea {
  uuid: string;
  title: string;
}

export function SetParentDialog({
  open,
  onOpenChange,
  ideaUuid,
  ideaTitle,
  projectUuid,
  currentParentUuid,
  descendantUuids,
  onChanged,
}: SetParentDialogProps) {
  const t = useTranslations("ideaTracker.lineage");
  const tCommon = useTranslations("common");
  const router = useRouter();

  const [candidates, setCandidates] = useState<PickerIdea[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The set of uuids that cannot be chosen as parent: the idea itself + all of
  // its transitive descendants (choosing one would form a cycle).
  const blocked = new Set<string>([ideaUuid, ...descendantUuids]);

  const loadCandidates = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      const result = await getProjectIdeasForPickerAction(projectUuid);
      if (result.success) {
        setCandidates(result.data);
        setTruncated(result.hasMore);
      } else {
        setError(result.error);
      }
    } catch (e) {
      clientLogger.error("Failed to load parent candidates:", e);
      setError(t("saveFailed"));
    }
    setIsLoading(false);
  }, [projectUuid, t]);

  useEffect(() => {
    if (open) loadCandidates();
  }, [open, loadCandidates]);

  const apply = async (parentUuid: string | null) => {
    if (isSaving) return;
    setIsSaving(true);
    setError(null);
    try {
      const result = await setIdeaParentAction(ideaUuid, parentUuid);
      if (result.success) {
        toast.success(parentUuid ? t("save") : t("detach"));
        onOpenChange(false);
        router.refresh();
        onChanged();
      } else {
        setError(result.error || t("saveFailed"));
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : t("saveFailed"));
    }
    setIsSaving(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t("setParentTitle")}</DialogTitle>
          <DialogDescription>
            {t("setParentDescription", { title: ideaTitle })}
          </DialogDescription>
        </DialogHeader>

        {/* min-w-0: DialogContent is display:grid and grid items default to
            min-width:auto, which refuses to shrink below content width. Without
            this the long-title rows below would stretch this wrapper (and the
            whole dialog) past sm:max-w-lg, defeating the candidate-row truncate
            and the CommandList overflow-x-hidden. */}
        <div className="min-w-0 space-y-3 pt-1">
          {isLoading ? (
            <div className="flex h-40 items-center justify-center">
              <Loader2 className="h-5 w-5 animate-spin text-[#9A9A9A]" />
            </div>
          ) : (
            <div className="rounded-md border border-[#E5E0D8]">
              <Command>
                <CommandInput placeholder={t("searchPlaceholder")} />
                {/* CommandList is already the scroll container
                    (max-h-[300px] overflow-y-auto). Do NOT nest a Radix
                    ScrollArea here: with only a max-height and no definite
                    height its size-full viewport collapses and never scrolls,
                    and the wrapping overflow-hidden CommandGroup then clips any
                    candidate past the cap, making most parents unreachable. */}
                <CommandList>
                  <CommandEmpty>{t("noCandidates")}</CommandEmpty>
                  <CommandGroup>
                    {candidates.map((idea) => {
                      const isBlocked = blocked.has(idea.uuid);
                      const isCurrent = idea.uuid === currentParentUuid;
                      return (
                        <CommandItem
                          key={idea.uuid}
                          value={idea.title}
                          disabled={isBlocked}
                          onSelect={() => {
                            if (isBlocked) return;
                            apply(idea.uuid);
                          }}
                          className={cn(
                            // min-w-0 lets the title span shrink so its
                            // `truncate` can ellipsize; without it the flex
                            // item's default min-width:auto refuses to shrink
                            // and a long title overflows the dialog.
                            "flex min-w-0 items-center justify-between gap-2",
                            isBlocked && "opacity-55",
                            isCurrent && "bg-[#C67A52]/10",
                          )}
                        >
                          <span className="min-w-0 flex-1 truncate text-[13px] text-[#2C2C2A]">
                            {idea.title}
                          </span>
                          {isBlocked && (
                            <span className="flex shrink-0 items-center gap-1 text-[11px] font-medium text-[#B0654A]">
                              <Ban className="h-3 w-3" />
                              {t("cycleBlocked")}
                            </span>
                          )}
                        </CommandItem>
                      );
                    })}
                  </CommandGroup>
                </CommandList>
              </Command>
            </div>
          )}

          {/* Cycle-prevention explainer */}
          <div className="flex items-start gap-2 rounded-md bg-[#FBF0EB] px-3 py-2.5">
            <Info className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#B0654A]" />
            <p className="text-[12px] leading-relaxed text-[#9A5238]">
              {t("cycleWarning")}
            </p>
          </div>

          {/* Truncation notice — the picker shows the first 200 ideas only. */}
          {truncated && (
            <p className="px-1 text-[12px] text-[#A8A498]" role="status">
              {t("pickerTruncated")}
            </p>
          )}

          {error && (
            <p className="text-xs text-destructive" role="alert">
              {error}
            </p>
          )}
        </div>

        <div className="flex items-center justify-between gap-3 pt-2">
          {/* Detach is offered only when the idea currently has a parent. */}
          {currentParentUuid ? (
            <Button
              variant="outline"
              className="border-[#E5E0D8]"
              onClick={() => apply(null)}
              disabled={isSaving}
            >
              {t("detach")}
            </Button>
          ) : (
            <span />
          )}
          <Button
            variant="outline"
            className="border-[#E5E0D8]"
            onClick={() => onOpenChange(false)}
            disabled={isSaving}
          >
            {tCommon("cancel")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
