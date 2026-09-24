"use client";

import { useEffect, useRef, useState } from "react";
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
  type ProjectAgentCwdSettingsHandle,
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
  const [isPending, setIsPending] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [cwdError, setCwdError] = useState<{ agentUuid: string; message: string } | null>(null);
  const [success, setSuccess] = useState(false);
  const cwdSettingsRef = useRef<ProjectAgentCwdSettingsHandle>(null);
  const submittingRef = useRef(false);
  const mountedRef = useRef(false);
  const successTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (successTimerRef.current !== null) {
        clearTimeout(successTimerRef.current);
      }
    };
  }, []);

  const displayGroupName = groupName || t("projectGroups.ungrouped");

  const handleOpenChange = (nextOpen: boolean) => {
    if (!submittingRef.current) onOpenChange(nextOpen);
  };

  const handleSubmit = async () => {
    if (submittingRef.current || !mountedRef.current || !title.trim()) return;
    // Lock before validation: React state alone cannot exclude same-tick events.
    submittingRef.current = true;
    setIsPending(true);
    const submittedProject = {
      name: title.trim(),
      description: description.trim() || undefined,
      groupUuid: groupUuid || undefined,
    };
    setError(null);
    setCwdError(null);
    let created = false;

    try {
      const cwdDrafts = await cwdSettingsRef.current?.validate();
      if (!mountedRef.current || !cwdDrafts) return;

      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...submittedProject,
          agentCwds: cwdDrafts.upserts.map(({ agentUuid, validationRequestUuid }) => ({
            agentUuid,
            validationRequestUuid,
          })),
        }),
      });
      if (!mountedRef.current) return;
      const data = await res.json();
      if (!mountedRef.current) return;

      if (data.success) {
        created = true;
        setSuccess(true);
        // Keep the lock until successful closure, including the feedback interval.
        successTimerRef.current = setTimeout(() => {
          successTimerRef.current = null;
          if (!mountedRef.current) return;
          setTitle("");
          setDescription("");
          setSuccess(false);
          setIsPending(false);
          onOpenChange(false);
          submittingRef.current = false;
          if (mountedRef.current) onCreated?.();
          if (mountedRef.current) router.refresh();
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
      if (mountedRef.current) setError(t("common.genericError"));
    } finally {
      if (!created && mountedRef.current) {
        submittingRef.current = false;
        setIsPending(false);
      }
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="flex max-h-[90svh] flex-col gap-0 overflow-hidden rounded-[16px] p-0 sm:max-w-[620px]"
        showCloseButton={false}
        onEscapeKeyDown={(event) => {
          if (submittingRef.current) event.preventDefault();
        }}
        onInteractOutside={(event) => {
          if (submittingRef.current) event.preventDefault();
        }}
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
              ref={cwdSettingsRef}
              agentError={cwdError}
            />
          </div>
        </div>

        <div className="flex justify-end gap-3 p-[16px_24px] border-t border-[#E5E2DC] dark:border-[#2a2a2e]">
          <Button
            variant="outline"
            onClick={() => handleOpenChange(false)}
            disabled={isPending}
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
