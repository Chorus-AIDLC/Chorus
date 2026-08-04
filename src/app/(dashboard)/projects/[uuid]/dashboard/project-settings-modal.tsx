"use client";

import { useState } from "react";
import { useSearchParams } from "next/navigation";
import { useRouter } from "@/hooks/use-progress-router";
import { useTranslations } from "next-intl";
import { Settings, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
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
import { updateProjectAction, deleteProjectAction } from "../actions";
import {
  ProjectAgentCwdSettings,
  type ProjectAgentCwdMutations,
} from "@/components/project-agent-cwd-settings";

interface ProjectSettingsModalProps {
  projectUuid: string;
  projectName: string;
  projectDescription: string | null;
}

export function ProjectSettingsModal({
  projectUuid,
  projectName,
  projectDescription,
}: ProjectSettingsModalProps) {
  const t = useTranslations();
  const searchParams = useSearchParams();
  const router = useRouter();
  const [open, setOpen] = useState(searchParams.get("settings") === "agent-cwds");
  const [name, setName] = useState(projectName);
  const [description, setDescription] = useState(projectDescription || "");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [cwdMutations, setCwdMutations] = useState<ProjectAgentCwdMutations>({
    upserts: [],
    clears: [],
  });
  const [cwdError, setCwdError] = useState<{ agentUuid: string; message: string } | null>(null);
  const handleSave = async () => {
    setSaving(true);
    setCwdError(null);
    const result = await updateProjectAction(projectUuid, {
      name,
      description: description || null,
      agentCwds: {
        upserts: cwdMutations.upserts.map(({ agentUuid, validationRequestUuid }) => ({
          agentUuid,
          validationRequestUuid,
        })),
        clears: cwdMutations.clears,
      },
    });
    setSaving(false);
    if (result.success) {
      setOpen(false);
      router.refresh();
    } else if (result.error.agentUuid) {
      setCwdError({ agentUuid: result.error.agentUuid, message: result.error.message });
    }
  };

  const handleDelete = async () => {
    setDeleting(true);
    const result = await deleteProjectAction(projectUuid);
    if (result && !result.success) {
      setDeleting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5 rounded-lg border-[#E5E2DC] dark:border-[#2a2a2e] bg-card text-[12px] font-normal text-foreground hover:border-primary hover:bg-card"
        >
          <Settings className="h-3.5 w-3.5 text-muted-foreground" />
          {t("dashboard.settings")}
        </Button>
      </DialogTrigger>
      <DialogContent className="flex max-h-[90svh] flex-col gap-0 overflow-hidden rounded-2xl border-0 p-0 sm:max-w-[620px]">
        <DialogHeader className="px-7 py-6">
          <DialogTitle className="text-[20px] font-semibold tracking-tight text-foreground">
            {t("projectSettings.title")}
          </DialogTitle>
        </DialogHeader>

        <Separator className="bg-[#E5E2DC] dark:bg-[#26241f]" />

        <div className="min-h-0 overflow-y-auto">
        <div className="flex flex-col gap-7 p-5 sm:p-7">
          {/* Basic Information */}
          <div className="flex flex-col gap-5">
            <h3 className="text-[14px] font-semibold text-foreground">
              {t("projectSettings.basicInfo")}
            </h3>

            <div className="flex flex-col gap-1.5">
              <Label className="text-[12px] font-medium text-muted-foreground">
                {t("projectSettings.projectName")}
              </Label>
              <Input
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="h-11 rounded-[10px] border-[#E5E2DC] dark:border-[#2a2a2e] text-[14px] text-foreground focus-visible:ring-primary"
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label className="text-[12px] font-medium text-muted-foreground">
                {t("projectSettings.description")}
              </Label>
              <Textarea
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                rows={3}
                className="resize-none rounded-[10px] border-[#E5E2DC] dark:border-[#2a2a2e] text-[14px] text-foreground focus-visible:ring-primary"
              />
            </div>

            <Button
              onClick={handleSave}
              disabled={saving || !name.trim()}
              className="w-fit rounded-[10px] bg-primary px-6 text-[13px] font-semibold text-white hover:bg-[#B56A42]"
            >
              {saving ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  {t("projectSettings.saving")}
                </>
              ) : (
                t("projectSettings.saveChanges")
              )}
            </Button>
          </div>

          <Separator className="bg-[#E5E2DC] dark:bg-[#26241f]" />

          <ProjectAgentCwdSettings
            projectUuid={projectUuid}
            onDraftChange={setCwdMutations}
            agentError={cwdError}
          />

          <Separator className="bg-[#E5E2DC] dark:bg-[#26241f]" />

          {/* Danger Zone */}
          <div className="flex flex-col gap-4">
            <h3 className="text-[14px] font-semibold text-[#C4574C] dark:text-[#F0897E]">
              {t("projectSettings.dangerZone")}
            </h3>

            <div className="rounded-xl border border-[#C4574C40] bg-[#C4574C08] px-[18px] py-4">
              <div className="flex items-center justify-between">
                <div className="flex flex-col gap-1">
                  <span className="text-[13px] font-semibold text-foreground">
                    {t("projectSettings.deleteTitle")}
                  </span>
                  <span className="text-[12px] text-muted-foreground">
                    {t("projectSettings.deleteDescription")}
                  </span>
                </div>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button
                      variant="destructive"
                      size="sm"
                      className="ml-4 shrink-0 rounded-lg bg-[#C4574C] px-[18px] text-[12px] font-medium hover:bg-[#B3463B]"
                    >
                      {t("common.delete")}
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>
                        {t("projectOverview.deleteProject")}
                      </AlertDialogTitle>
                      <AlertDialogDescription>
                        {t("projectOverview.deleteProjectConfirm", {
                          name: projectName,
                        })}
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>
                        {t("common.cancel")}
                      </AlertDialogCancel>
                      <AlertDialogAction
                        variant="destructive"
                        onClick={handleDelete}
                        disabled={deleting}
                      >
                        {deleting ? (
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
            </div>
          </div>
        </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}
