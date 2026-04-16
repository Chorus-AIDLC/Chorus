"use client";

import { useState, useEffect, useCallback } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import { Loader2, Check } from "lucide-react";
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
import { moveIdeaAction, getProjectsAndGroupsAction } from "./actions";
import { clientLogger } from "@/lib/logger-client";

interface MoveGroup {
  uuid: string;
  name: string;
  projects: { uuid: string; name: string }[];
}

interface MoveIdeaDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  ideaUuid: string;
  projectUuid: string;
  onMoved: () => void;
}

export function MoveIdeaDialog({ open, onOpenChange, ideaUuid, projectUuid, onMoved }: MoveIdeaDialogProps) {
  const t = useTranslations();
  const router = useRouter();

  const [moveGroups, setMoveGroups] = useState<MoveGroup[]>([]);
  const [isLoadingProjects, setIsLoadingProjects] = useState(false);
  const [selectedProject, setSelectedProject] = useState<{ uuid: string; name: string } | null>(null);
  const [isMoving, setIsMoving] = useState(false);
  const [moveError, setMoveError] = useState<string | null>(null);

  const loadProjects = useCallback(async () => {
    setSelectedProject(null);
    setMoveError(null);
    setIsLoadingProjects(true);
    try {
      const result = await getProjectsAndGroupsAction();
      if (result.success) {
        const { projects: allProjects, groups: allGroups } = result.data;
        const projects = allProjects
          .filter((p: { uuid: string }) => p.uuid !== projectUuid)
          .map((p: { uuid: string; name: string; groupUuid: string | null }) => ({
            uuid: p.uuid, name: p.name, groupUuid: p.groupUuid,
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
    } catch (e) {
      clientLogger.error("Failed to load projects for move dialog:", e);
      setMoveGroups([]);
    }
    setIsLoadingProjects(false);
  }, [projectUuid, t]);

  // Load projects when dialog opens
  useEffect(() => {
    if (open) {
      loadProjects();
    }
  }, [open, loadProjects]);

  const handleMove = async () => {
    if (!selectedProject || isMoving) return;
    setIsMoving(true);
    setMoveError(null);

    try {
      const result = await moveIdeaAction(ideaUuid, selectedProject.uuid);
      if (result.success) {
        onOpenChange(false);
        onMoved();
        router.refresh();
      } else {
        setMoveError(result.error || t("ideas.moveFailed"));
      }
    } catch {
      setMoveError(t("ideas.moveFailed"));
    }
    setIsMoving(false);
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
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
                      onSelect={() => setSelectedProject(p)}
                      className={
                        selectedProject?.uuid === p.uuid
                          ? "bg-[#C67A52] text-white data-[selected=true]:bg-[#B56A42] data-[selected=true]:text-white"
                          : ""
                      }
                    >
                      <Check className={`mr-2 h-4 w-4 ${selectedProject?.uuid === p.uuid ? "opacity-100" : "opacity-0"}`} />
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
            onClick={() => onOpenChange(false)}
            disabled={isMoving}
          >
            {t("common.cancel")}
          </Button>
          <Button
            className="bg-[#C67A52] hover:bg-[#B56A42] text-white"
            onClick={handleMove}
            disabled={!selectedProject || isMoving}
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
  );
}
