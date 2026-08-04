"use client";

import { useState, useTransition } from "react";
import { useRouter } from "@/hooks/use-progress-router";
import { useTranslations } from "next-intl";
import { motion, AnimatePresence } from "framer-motion";
import { Check, Loader2, Plus } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { isImeComposing } from "@/lib/ime";
import {
  ProjectAgentCwdSettings,
  type ProjectAgentCwdMutations,
} from "@/components/project-agent-cwd-settings";

interface CreateProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  groupUuid: string | null;
  groupName: string;
  onCreated?: () => void;
}

export function CreateProjectDialog({
  open,
  onOpenChange,
  groupUuid,
  groupName,
  onCreated,
}: CreateProjectDialogProps) {
  const t = useTranslations();
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [cwdError, setCwdError] = useState<{ agentUuid: string; message: string } | null>(null);
  const [success, setSuccess] = useState(false);
  const [cwdDrafts, setCwdDrafts] = useState<ProjectAgentCwdMutations>({
    upserts: [],
    clears: [],
  });

  const displayGroupName = groupName || t("projectGroups.ungrouped");

  const handleSubmit = () => {
    if (!title.trim()) return;
    setError(null);
    setCwdError(null);

    startTransition(async () => {
      try {
        const res = await fetch("/api/projects", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: title.trim(),
            description: description.trim() || undefined,
            groupUuid: groupUuid || undefined,
            agentCwds: cwdDrafts.upserts.map(({ agentUuid, validationRequestUuid }) => ({
              agentUuid,
              validationRequestUuid,
            })),
          }),
        });
        const data = await res.json();

        if (data.success) {
          setSuccess(true);
          setTimeout(() => {
            setTitle("");
            setDescription("");
            setCwdDrafts({ upserts: [], clears: [] });
            onOpenChange(false);
            onCreated?.();
            router.refresh();
            setSuccess(false);
          }, 600);
        } else {
          const message = typeof data.error === "object" && data.error
            ? data.error.message
            : data.error;
          const agentUuid = typeof data.error === "object" && data.error
            && typeof data.error.details?.agentUuid === "string"
            ? data.error.details.agentUuid
            : null;
          if (agentUuid) {
            setCwdError({ agentUuid, message: message || t("projects.createFailed") });
          } else {
            setError(message || t("projects.createFailed"));
          }
        }
      } catch {
        setError(t("common.genericError"));
      }
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="flex max-h-[90svh] flex-col gap-0 overflow-hidden rounded-[16px] p-0 sm:max-w-[620px]"
        showCloseButton={false}
      >
        <DialogHeader className="flex flex-row items-center justify-between p-[20px_24px] border-b border-[#E5E2DC] dark:border-[#2a2a2e]">
          <div className="flex flex-col gap-1">
            <DialogTitle className="text-lg font-semibold tracking-[-0.3px] text-foreground">
              {t("projectGroups.newProjectTitle")}
            </DialogTitle>
            <p className="text-xs text-muted-foreground">
              {t("projectGroups.creatingIn", { groupName: displayGroupName })}
            </p>
          </div>
        </DialogHeader>
        <DialogDescription className="sr-only">
          {t("projectGroups.newProjectTitle")}
        </DialogDescription>

        <div className="flex min-h-0 flex-col gap-5 overflow-y-auto p-6">
          {error && (
            <div className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
              {error}
            </div>
          )}

          <div className="flex flex-col gap-1.5">
            <Label className="text-[13px] font-medium text-foreground">
              {t("projectGroups.projectTitle")}
            </Label>
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder={t("projectGroups.projectTitlePlaceholder")}
              className="h-10 rounded-lg border-[#E5E2DC] dark:border-[#2a2a2e]"
              onKeyDown={(e) => {
                if (isImeComposing(e)) return;
                if (e.key === "Enter" && title.trim()) handleSubmit();
              }}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label className="text-[13px] font-medium text-foreground">
              {t("common.description")}
            </Label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t("projectGroups.projectDescriptionPlaceholder")}
              className="min-h-[80px] rounded-lg border-[#E5E2DC] dark:border-[#2a2a2e]"
            />
          </div>

          <div className="border-t border-border pt-5">
            <ProjectAgentCwdSettings
              onDraftChange={setCwdDrafts}
              agentError={cwdError}
            />
          </div>
        </div>

        <div className="flex justify-end gap-3 p-[16px_24px] border-t border-[#E5E2DC] dark:border-[#2a2a2e]">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            className="rounded-lg border-[#E5E2DC] dark:border-[#2a2a2e] text-[13px]"
          >
            {t("common.cancel")}
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={isPending || success || !title.trim()}
            className="rounded-lg bg-primary hover:bg-[#B56A42] text-white text-[13px] gap-1.5"
          >
            <AnimatePresence mode="wait">
              {success ? (
                <motion.span
                  key="success"
                  initial={{ opacity: 0, scale: 0.5 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.15 }}
                  className="flex items-center gap-2"
                >
                  <Check className="h-3.5 w-3.5" />
                </motion.span>
              ) : isPending ? (
                <motion.span key="loading" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex items-center gap-2">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  {t("common.creating")}
                </motion.span>
              ) : (
                <motion.span key="idle" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} className="flex items-center gap-2">
                  <Plus className="h-3.5 w-3.5" />
                  {t("projectGroups.createProject")}
                </motion.span>
              )}
            </AnimatePresence>
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
