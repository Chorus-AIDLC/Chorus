"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "@/hooks/use-progress-router";
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
import { Settings, Trash2, AlertTriangle } from "lucide-react";
import { authFetch } from "@/lib/auth-client";
import { ProjectAccessTab, type ProjectAccessLevel, type ProjectVisibility } from "@/app/(dashboard)/projects/[uuid]/dashboard/project-access-tab";

interface ManageProjectGroupDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  groupUuid: string;
  groupName: string;
  groupDescription: string | null;
  projectCount: number;
  onUpdated: () => void;
}

export function ManageProjectGroupDialog({
  open,
  onOpenChange,
  groupUuid,
  groupName,
  groupDescription,
  projectCount,
  onUpdated,
}: ManageProjectGroupDialogProps) {
  const t = useTranslations("projectGroups");
  const router = useRouter();
  const [name, setName] = useState(groupName);
  const [description, setDescription] = useState(groupDescription ?? "");
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deleteProjects, setDeleteProjects] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [access, setAccess] = useState<{
    visibility: ProjectVisibility;
    accessLevel: ProjectAccessLevel;
    explicitRole: ProjectAccessLevel | null;
    canManage: boolean;
    accessInitialized: boolean;
  } | null>(null);
  const [initializing, setInitializing] = useState(false);

  const loadAccess = useCallback(async () => {
    try {
      const res = await authFetch(`/api/project-groups/${groupUuid}`);
      const json = await res.json();
      if (!res.ok || !json.success) throw new Error();
      setAccess(json.data);
    } catch {
      setAccess(null);
      setError(t("loadFailed"));
    }
  }, [groupUuid, t]);

  useEffect(() => {
    if (!open) return;
    setName(groupName);
    setDescription(groupDescription ?? "");
    setShowDeleteConfirm(false);
    setDeleteProjects(false);
    setError(null);
    setAccess(null);
    void loadAccess();
  }, [open, groupName, groupDescription, loadAccess]);

  const initializeAccess = async () => {
    setInitializing(true);
    setError(null);
    try {
      const res = await authFetch(`/api/project-groups/${groupUuid}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ initializeAccess: true }),
      });
      const json = await res.json();
      if (!res.ok || !json.success) {
        setError(t("initializeFailed"));
        return;
      }
      await loadAccess();
    } catch {
      setError(t("initializeFailed"));
    } finally {
      setInitializing(false);
    }
  };

  // Reset state when dialog opens
  const handleOpenChange = (open: boolean) => {
    if (open) {
      setName(groupName);
      setDescription(groupDescription ?? "");
      setShowDeleteConfirm(false);
      setDeleteProjects(false);
    }
    onOpenChange(open);
  };

  const handleSave = async () => {
    if (!name.trim() || !access?.canManage) return;
    setSaving(true);
    setError(null);
    try {
      const res = await authFetch(`/api/project-groups/${groupUuid}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), description: description.trim() || null }),
      });
      const json = await res.json();
      if (json.success) {
        onUpdated();
      } else {
        setError(t("saveFailed"));
      }
    } catch {
      setError(t("saveFailed"));
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (access?.accessLevel !== "admin") return;
    setDeleting(true);
    setError(null);
    try {
      const url = deleteProjects
        ? `/api/project-groups/${groupUuid}?deleteProjects=true`
        : `/api/project-groups/${groupUuid}`;
      const res = await authFetch(url, {
        method: "DELETE",
      });
      const json = await res.json();
      if (json.success) {
        onOpenChange(false);
        router.push("/projects");
      } else {
        setError(t("deleteFailed"));
      }
    } catch {
      setError(t("deleteFailed"));
    } finally {
      setDeleting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!saving && !deleting && !initializing) handleOpenChange(next); }}>
      <DialogContent className="max-h-[90svh] max-w-[620px] gap-0 overflow-y-auto p-0">
        <DialogHeader className="border-b border-[#E5E2DC] dark:border-[#2a2a2e] px-6 py-5">
          <div className="flex items-center gap-2.5">
            <Settings className="h-5 w-5 text-primary" />
            <DialogTitle className="text-[18px] font-semibold tracking-tight text-foreground">
              {t(access?.canManage === false ? "viewMembers" : "manageGroup")}
            </DialogTitle>
          </div>
          <DialogDescription className="sr-only">{t("visibilityDescription")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-5 px-6 py-5">
          {error && <p role="alert" className="break-words text-sm text-destructive">{error}</p>}
          {!access && <p role="status" className="text-sm text-muted-foreground">{t("loading")}</p>}
          {access?.canManage && <>
          {/* Edit Name */}
          <div className="space-y-1.5">
            <Label className="text-[13px] font-medium text-foreground">
              {t("groupName")}
            </Label>
            <Input
              value={name}
              disabled={!access?.canManage || saving}
              onChange={(e) => setName(e.target.value)}
              className="h-10 rounded-lg border-[#E5E2DC] dark:border-[#2a2a2e] text-[13px] focus-visible:ring-primary"
            />
          </div>

          {/* Edit Description */}
          <div className="space-y-1.5">
            <Label className="text-[13px] font-medium text-foreground">
              {t("descriptionOptional")}
            </Label>
            <textarea
              value={description}
              disabled={!access?.canManage || saving}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              className="mobile-input-text w-full rounded-lg border border-[#E5E2DC] dark:border-[#2a2a2e] px-3 py-2.5 text-[13px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-1"
              placeholder={t("descriptionPlaceholder")}
            />
          </div>

          {/* Save Button */}
          <div className="flex justify-end">
            <Button
              onClick={handleSave}
              disabled={!access?.canManage || saving || !name.trim() || (name === groupName && description === (groupDescription ?? ""))}
              className="rounded-lg bg-primary text-[13px] font-medium text-white hover:bg-[#B56A42]"
            >
              {saving ? t("saving") : t("saveChanges")}
            </Button>
          </div>
          </>}
          {access && !access.accessInitialized && (
            <section className="space-y-3 rounded-lg border border-border bg-muted/40 p-3">
              <h3 className="text-sm font-semibold">{t("initializeTitle")}</h3>
              <p className="text-xs text-muted-foreground">{t("initializeHint")}</p>
              {access.canManage && <Button onClick={() => void initializeAccess()} disabled={initializing} className="h-auto whitespace-normal">
                {initializing ? t("initializing") : t("initializeAction")}
              </Button>}
            </section>
          )}
          {access?.accessInitialized && <ProjectAccessTab
            resourceType="project-groups"
            projectUuid={groupUuid}
            visibility={access.visibility}
            accessLevel={access.explicitRole ?? "viewer"}
            canReadMembers={access.explicitRole != null}
            onVisibilityChange={(visibility) => setAccess((prev) => prev ? { ...prev, visibility } : prev)}
            onMembersChanged={() => { void loadAccess(); onUpdated(); }}
          />}
        </div>

        {/* Danger Zone */}
        {access?.accessLevel === "admin" && <div className="border-t border-border px-6 py-5">
          {!showDeleteConfirm ? (
            <button
              onClick={() => setShowDeleteConfirm(true)}
              className="flex w-full cursor-pointer items-center gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-left text-[13px] font-medium text-destructive"
            >
              <Trash2 className="h-4 w-4" />
              {t("deleteGroup")}
            </button>
          ) : (
            <div className="space-y-3 rounded-lg border border-destructive/30 bg-destructive/10 p-4">
              <div className="flex items-center gap-2 text-[13px] font-semibold text-destructive">
                <AlertTriangle className="h-4 w-4" />
                {t("deleteConfirmTitle")}
              </div>
              <p className="text-[12px] text-destructive">
                {t("deleteConfirmDesc")}
              </p>

              {projectCount > 0 && (
                <div className="space-y-2 pt-1">
                  <label className="flex cursor-pointer items-center gap-2 text-[12px] text-foreground">
                    <input
                      type="radio"
                      name="deleteOption"
                      checked={!deleteProjects}
                      onChange={() => setDeleteProjects(false)}
                      className="accent-primary"
                    />
                    {t("deleteKeepProjects", { count: projectCount })}
                  </label>
                  <label className="flex cursor-pointer items-center gap-2 text-[12px] text-destructive">
                    <input
                      type="radio"
                      name="deleteOption"
                      checked={deleteProjects}
                      onChange={() => setDeleteProjects(true)}
                      className="accent-red-600"
                    />
                    {t("deleteWithProjects", { count: projectCount })}
                  </label>
                </div>
              )}

              <div className="flex flex-wrap gap-2 pt-1">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setShowDeleteConfirm(false)}
                  className="rounded-lg border-[#E5E2DC] dark:border-[#2a2a2e] text-[12px]"
                >
                  {t("cancel")}
                </Button>
                <Button
                  size="sm"
                  onClick={handleDelete}
                  disabled={deleting}
                  className="rounded-lg bg-red-600 text-[12px] text-white hover:bg-red-700"
                >
                  <Trash2 className="mr-1 h-3 w-3" />
                  {deleting ? t("deleting") : t("confirmDelete")}
                </Button>
              </div>
            </div>
          )}
        </div>}
      </DialogContent>
    </Dialog>
  );
}
