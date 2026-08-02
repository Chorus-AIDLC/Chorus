"use client";

import { useEffect, useState } from "react";
import { useRouter } from "@/hooks/use-progress-router";
import { useTranslations } from "next-intl";
import { Settings, Loader2, FolderCog, RotateCcw, Trash2 } from "lucide-react";
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
  DirectoryBrowser,
  type ValidatedDirectory,
} from "@/components/agent-presence/directory-browser";
import type { InstanceCandidate } from "@/components/agent-presence/instance-picker";

interface AgentCwdItem {
  agent: { uuid: string; name: string };
  onlineInstances: InstanceCandidate[];
  preference: {
    host: string;
    cwd: string;
    status: "valid" | "offline" | "invalid";
  } | null;
}

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
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(projectName);
  const [description, setDescription] = useState(projectDescription || "");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [cwdItems, setCwdItems] = useState<AgentCwdItem[]>([]);
  const [cwdLoading, setCwdLoading] = useState(false);
  const [editingAgent, setEditingAgent] = useState<string | null>(null);
  const [cwdError, setCwdError] = useState(false);

  const loadCwds = async () => {
    setCwdLoading(true);
    setCwdError(false);
    try {
      const response = await fetch(
        `/api/projects/${encodeURIComponent(projectUuid)}/agent-cwds`,
      );
      const body = await response.json();
      if (!response.ok || !body.success) throw new Error("load failed");
      setCwdItems(body.data.agents);
    } catch {
      setCwdError(true);
    } finally {
      setCwdLoading(false);
    }
  };

  useEffect(() => {
    if (open) void loadCwds();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, projectUuid]);

  const saveCwd = async (selection: ValidatedDirectory) => {
    const response = await fetch(
      `/api/projects/${encodeURIComponent(projectUuid)}/agent-cwds`,
      {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          agentUuid: selection.agentUuid,
          validationRequestUuid: selection.validationRequestUuid,
        }),
      },
    );
    if (!response.ok) throw new Error("save failed");
    setEditingAgent(null);
    await loadCwds();
  };

  const clearCwd = async (agentUuid: string) => {
    const response = await fetch(
      `/api/projects/${encodeURIComponent(projectUuid)}/agent-cwds`,
      {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ agentUuid }),
      },
    );
    if (!response.ok) {
      setCwdError(true);
      return;
    }
    await loadCwds();
  };

  const handleSave = async () => {
    setSaving(true);
    const result = await updateProjectAction(projectUuid, {
      name,
      description: description || null,
    });
    setSaving(false);
    if (result.success) {
      setOpen(false);
      router.refresh();
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

          <div className="flex min-w-0 flex-col gap-4">
            <div>
              <h3 className="text-[14px] font-semibold text-foreground">
                {t("projectSettings.agentCwds.title")}
              </h3>
              <p className="mt-1 text-[12px] text-muted-foreground">
                {t("projectSettings.agentCwds.description")}
              </p>
            </div>

            {cwdLoading && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <Loader2 className="size-4 animate-spin" />
                {t("projectSettings.agentCwds.loading")}
              </div>
            )}
            {cwdError && (
              <div className="flex items-center justify-between gap-3" role="alert">
                <span className="text-xs text-destructive">
                  {t("projectSettings.agentCwds.loadFailed")}
                </span>
                <Button type="button" size="sm" variant="outline" onClick={loadCwds}>
                  <RotateCcw className="mr-2 size-3.5" />
                  {t("common.retry")}
                </Button>
              </div>
            )}
            {!cwdLoading && !cwdError && cwdItems.length === 0 && (
              <p className="text-xs text-muted-foreground">
                {t("projectSettings.agentCwds.empty")}
              </p>
            )}

            {cwdItems.map((item) => (
              <div
                key={item.agent.uuid}
                className="min-w-0 rounded-xl border border-[#E5E2DC] p-4 dark:border-[#2a2a2e]"
              >
                <div className="flex min-w-0 items-start justify-between gap-3">
                  <div className="min-w-0">
                    <p className="truncate text-[13px] font-semibold">{item.agent.name}</p>
                    {item.preference ? (
                      <>
                        <p className="mt-1 break-all font-mono text-[11px]">
                          {item.preference.cwd}
                        </p>
                        <p className="mt-1 truncate text-[11px] text-muted-foreground">
                          {item.preference.host}
                        </p>
                        <p
                          className={
                            item.preference.status === "valid"
                              ? "mt-1 text-[11px] text-emerald-700 dark:text-emerald-400"
                              : "mt-1 text-[11px] text-destructive"
                          }
                        >
                          {t(
                            `projectSettings.agentCwds.status.${item.preference.status}`,
                          )}
                        </p>
                      </>
                    ) : (
                      <p className="mt-1 text-[11px] text-muted-foreground">
                        {t("projectSettings.agentCwds.notConfigured")}
                      </p>
                    )}
                  </div>
                  <div className="flex shrink-0 gap-1">
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      title={t(
                        item.preference
                          ? "projectSettings.agentCwds.replace"
                          : "projectSettings.agentCwds.configure",
                      )}
                      aria-label={t(
                        item.preference
                          ? "projectSettings.agentCwds.replace"
                          : "projectSettings.agentCwds.configure",
                      )}
                      onClick={() =>
                        setEditingAgent(
                          editingAgent === item.agent.uuid ? null : item.agent.uuid,
                        )
                      }
                    >
                      <FolderCog className="size-4" />
                    </Button>
                    {item.preference && (
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        className="text-destructive"
                        title={t("projectSettings.agentCwds.clear")}
                        aria-label={t("projectSettings.agentCwds.clear")}
                        onClick={() => void clearCwd(item.agent.uuid)}
                      >
                        <Trash2 className="size-4" />
                      </Button>
                    )}
                  </div>
                </div>
                {editingAgent === item.agent.uuid && (
                  <div className="mt-4 border-t border-border pt-4">
                    <DirectoryBrowser
                      agentUuid={item.agent.uuid}
                      instances={item.onlineInstances}
                      confirmLabel={t("projectSettings.agentCwds.save")}
                      onValidated={saveCwd}
                    />
                  </div>
                )}
              </div>
            ))}
          </div>

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
