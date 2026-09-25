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
  type ProjectAgentCwdDraft,
} from "@/components/project-agent-cwd-settings";

interface CreateProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  groupUuid: string | null;
  groupName: string;
  /** Refresh data only: may run for a late success after this dialog was reopened. */
  onCreated?: () => void;
}

type Phase = "idle" | "validating" | "posting" | "unconfirmed" | "confirmed" | "success";
interface CreationAttempt {
  controller: AbortController;
  phase: Phase;
  dismissed: boolean;
  timer?: ReturnType<typeof setTimeout>;
}

const CREATE_WAIT_MS = 20_000;
// These API rejections occur before creation or after the cwd transaction rolls back.
const REJECTION_CODES = new Set([
  "BAD_REQUEST", "UNAUTHORIZED", "FORBIDDEN", "NOT_FOUND", "CONFLICT", "VALIDATION_ERROR",
]);

export function CreateProjectDialog({
  open,
  onOpenChange,
  groupUuid,
  groupName,
  onCreated,
}: CreateProjectDialogProps) {
  const t = useTranslations();
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>("idle");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [cwdError, setCwdError] = useState<{ agentUuid: string; message: string } | null>(null);
  const [cwdDrafts, setCwdDrafts] = useState<Record<string, ProjectAgentCwdDraft>>({});
  const cwdSettingsRef = useRef<ProjectAgentCwdSettingsHandle>(null);
  const attemptRef = useRef<CreationAttempt | null>(null);
  const mountedRef = useRef(false);
  const callbacksRef = useRef({ onOpenChange, onCreated, router });
  const isPending = phase === "validating" || phase === "posting";
  const success = phase === "success";
  const dismissalBlocked = phase === "posting" || success;

  useEffect(() => {
    callbacksRef.current = { onOpenChange, onCreated, router };
  });

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      const attempt = attemptRef.current;
      attempt?.controller.abort();
      clearTimeout(attempt?.timer);
      attemptRef.current = null;
    };
  }, []);

  // Also handle a host closing the dialog without going through Radix's callback.
  useEffect(() => {
    const attempt = attemptRef.current;
    if (!open && attempt) {
      attempt.dismissed = true;
      if (attempt.phase === "validating") {
        attempt.controller.abort();
        attemptRef.current = null;
        setPhase("idle");
      }
    }
  }, [open]);

  const displayGroupName = groupName || t("projectGroups.ungrouped");
  const isCurrent = (attempt: CreationAttempt) =>
    mountedRef.current && attemptRef.current === attempt;
  const blocksDismissal = () =>
    attemptRef.current?.phase === "posting" || attemptRef.current?.phase === "success";

  const handleOpenChange = (nextOpen: boolean) => {
    if (blocksDismissal()) return;
    const attempt = attemptRef.current;
    if (!nextOpen && attempt) {
      attempt.dismissed = true;
      if (attempt.phase === "validating") {
        attempt.controller.abort();
        attemptRef.current = null;
        setPhase("idle");
      }
    }
    onOpenChange(nextOpen);
  };

  const refreshProjects = () => {
    if (mountedRef.current) callbacksRef.current.onCreated?.();
    if (mountedRef.current) callbacksRef.current.router.refresh();
  };

  const handleSubmit = async () => {
    if (attemptRef.current || !mountedRef.current || !open || !title.trim()) return;
    // Identity and lock are installed synchronously, before the first await.
    const attempt: CreationAttempt = {
      controller: new AbortController(), phase: "validating", dismissed: false,
    };
    attemptRef.current = attempt;
    setPhase("validating");
    const submittedProject = {
      name: title.trim(),
      description: description.trim() || undefined,
      groupUuid: groupUuid || undefined,
    };
    setError(null);
    setCwdError(null);

    const release = () => {
      if (!isCurrent(attempt)) return;
      clearTimeout(attempt.timer);
      attemptRef.current = null;
      setPhase("idle");
    };
    const markUnconfirmed = () => {
      if (!isCurrent(attempt)) return;
      clearTimeout(attempt.timer);
      attempt.phase = "unconfirmed";
      setPhase("unconfirmed");
    };
    const confirmDismissedSuccess = () => {
      if (isCurrent(attempt)) {
        // Preserve edits made after reopening, but don't silently enable a
        // duplicate submission of a draft whose project has already been created.
        attempt.phase = "confirmed";
        setPhase("confirmed");
      }
      refreshProjects();
    };

    try {
      const validated = await cwdSettingsRef.current?.validate(attempt.controller.signal);
      if (!isCurrent(attempt) || attempt.controller.signal.aborted) return;
      if (!validated) { release(); return; }

      attempt.phase = "posting";
      setPhase("posting");
      // Bound the UI wait, including response-body reading. Aborting a POST does
      // not roll back the server, so keep listening for a definitive late result.
      attempt.timer = setTimeout(markUnconfirmed, CREATE_WAIT_MS);
      const res = await fetch("/api/projects", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          ...submittedProject,
          agentCwds: validated.upserts.map(({ agentUuid, validationRequestUuid }) => ({
            agentUuid,
            validationRequestUuid,
          })),
        }),
      });
      if (!mountedRef.current) return;
      const data = await res.json();
      if (!mountedRef.current) return;
      clearTimeout(attempt.timer);

      if (res.ok && data?.success === true && typeof data.data?.uuid === "string") {
        if (!isCurrent(attempt) || attempt.dismissed) {
          confirmDismissedSuccess();
          return;
        }
        attempt.phase = "success";
        setPhase("success");
        attempt.timer = setTimeout(() => {
          if (!isCurrent(attempt)) return;
          if (attempt.dismissed) {
            confirmDismissedSuccess();
            return;
          }
          setTitle("");
          setDescription("");
          setCwdDrafts({});
          release();
          callbacksRef.current.onOpenChange(false);
          refreshProjects();
        }, 600);
      } else if (data?.success === false && res.status >= 400 && res.status < 500
        && REJECTION_CODES.has(data.error?.code)) {
        if (!isCurrent(attempt)) return;
        release();
        if (attempt.dismissed) return;
        const message = typeof data.error.message === "string"
          ? data.error.message : t("projects.createFailed");
        const agentUuid = data.error.details?.agentUuid;
        if (typeof agentUuid === "string") setCwdError({ agentUuid, message });
        else setError(message);
      } else {
        markUnconfirmed();
      }
    } catch {
      if (!isCurrent(attempt)) return;
      if (attempt.phase === "validating") {
        if (!attempt.controller.signal.aborted) {
          setError(t("common.genericError"));
        }
        release();
      } else {
        markUnconfirmed();
      }
    }
  };

  const allowNewAttempt = () => {
    if (attemptRef.current?.phase !== "unconfirmed"
      && attemptRef.current?.phase !== "confirmed") return;
    // An informed new operation, NOT proof that the earlier POST failed.
    clearTimeout(attemptRef.current.timer);
    attemptRef.current = null;
    setPhase("idle");
    setError(null);
    setCwdError(null);
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent
        className="flex max-h-[90svh] flex-col gap-0 overflow-hidden rounded-[16px] p-0 sm:max-w-[620px]"
        showCloseButton={false}
        onEscapeKeyDown={(event) => {
          if (blocksDismissal()) event.preventDefault();
        }}
        onInteractOutside={(event) => {
          if (blocksDismissal()) event.preventDefault();
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
          {(phase === "unconfirmed" || phase === "confirmed") && (
            <div role="alert" className="rounded-lg border border-border bg-muted p-3 text-sm text-foreground">
              <p>{t(phase === "confirmed" ? "projects.creationConfirmed" : "projects.creationUnconfirmed")}</p>
              {phase === "unconfirmed" && (
                <p className="mt-2 text-muted-foreground">{t("projects.creationRetryWarning")}</p>
              )}
              <Button
                variant="outline"
                className="mt-3 h-auto whitespace-normal text-left"
                onClick={allowNewAttempt}
              >
                {t(phase === "confirmed" ? "projects.confirmAnotherCreation" : "projects.confirmNewCreation")}
              </Button>
            </div>
          )}
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
              initialDrafts={cwdDrafts}
              onDraftsChange={setCwdDrafts}
            />
          </div>
        </div>

        <div className="flex justify-end gap-3 p-[16px_24px] border-t border-[#E5E2DC] dark:border-[#2a2a2e]">
          <Button
            variant="outline"
            onClick={() => handleOpenChange(false)}
            disabled={dismissalBlocked}
            className="rounded-lg border-[#E5E2DC] dark:border-[#2a2a2e] text-[13px]"
          >
            {t("common.cancel")}
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={phase !== "idle" || !title.trim()}
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
