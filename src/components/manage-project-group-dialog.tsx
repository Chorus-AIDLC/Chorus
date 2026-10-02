"use client";

import { useCallback, useEffect, useId, useState } from "react";
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
import { Textarea } from "@/components/ui/textarea";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
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
  const formId = useId();
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
  } | null>(null);

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
    <Dialog open={open} onOpenChange={(next) => { if (!saving && !deleting) handleOpenChange(next); }}>
      <DialogContent className="max-h-[90svh] max-w-[620px] gap-0 overflow-y-auto p-0">
        <DialogHeader className="border-b border-border px-6 py-5">
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
            <Label htmlFor={`${formId}-name`} className="text-[13px] font-medium text-foreground">
              {t("groupName")}
            </Label>
            <Input
              id={`${formId}-name`}
              value={name}
              disabled={!access?.canManage || saving}
              onChange={(e) => setName(e.target.value)}
              className="h-10 rounded-lg border-border text-[13px] focus-visible:ring-primary"
            />
          </div>

          {/* Edit Description */}
          <div className="space-y-1.5">
            <Label htmlFor={`${formId}-description`} className="text-[13px] font-medium text-foreground">
              {t("descriptionOptional")}
            </Label>
            <Textarea
              id={`${formId}-description`}
              value={description}
              disabled={!access?.canManage || saving}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              className="rounded-lg border-border py-2.5 text-[13px] focus-visible:ring-primary"
              placeholder={t("descriptionPlaceholder")}
            />
          </div>

          {/* Save Button */}
          <div className="flex justify-end">
            <Button
              onClick={handleSave}
              disabled={!access?.canManage || saving || !name.trim() || (name === groupName && description === (groupDescription ?? ""))}
              className="rounded-lg text-[13px] font-medium"
            >
              {saving ? t("saving") : t("saveChanges")}
            </Button>
          </div>
          </>}
          {access && <ProjectAccessTab
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
            <Button
              variant="outline"
              onClick={() => setShowDeleteConfirm(true)}
              className="h-auto w-full justify-start whitespace-normal rounded-lg border-destructive/30 bg-destructive/10 px-4 py-3 text-left text-[13px] text-destructive hover:bg-destructive/20 hover:text-destructive"
            >
              <Trash2 className="h-4 w-4" />
              {t("deleteGroup")}
            </Button>
          ) : (
            <div className="space-y-3 rounded-lg border border-destructive/30 bg-destructive/10 p-4">
              <div id={`${formId}-delete-title`} className="flex items-center gap-2 text-[13px] font-semibold text-destructive">
                <AlertTriangle className="h-4 w-4" />
                {t("deleteConfirmTitle")}
              </div>
              <p className="text-[12px] text-destructive">
                {t("deleteConfirmDesc")}
              </p>

              {projectCount > 0 && (
                <RadioGroup
                  aria-labelledby={`${formId}-delete-title`}
                  value={deleteProjects ? "delete" : "keep"}
                  onValueChange={(value) => setDeleteProjects(value === "delete")}
                  className="gap-2 pt-1"
                >
                  <div className="flex items-center gap-2">
                    <RadioGroupItem id={`${formId}-keep`} value="keep" />
                    <Label htmlFor={`${formId}-keep`} className="cursor-pointer text-[12px] font-normal text-foreground">
                      {t("deleteKeepProjects", { count: projectCount })}
                    </Label>
                  </div>
                  <div className="flex items-center gap-2">
                    <RadioGroupItem id={`${formId}-delete`} value="delete" />
                    <Label htmlFor={`${formId}-delete`} className="cursor-pointer text-[12px] font-normal text-destructive">
                      {t("deleteWithProjects", { count: projectCount })}
                    </Label>
                  </div>
                </RadioGroup>
              )}

              <div className="flex flex-wrap gap-2 pt-1">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setShowDeleteConfirm(false)}
                  className="rounded-lg border-border text-[12px]"
                >
                  {t("cancel")}
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  onClick={handleDelete}
                  disabled={deleting}
                  className="rounded-lg text-[12px]"
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
