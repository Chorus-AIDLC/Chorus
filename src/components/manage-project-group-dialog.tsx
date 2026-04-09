"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { useRouter } from "next/navigation";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Settings, Trash2, AlertTriangle } from "lucide-react";
import { authFetch } from "@/lib/auth-client";

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
    if (!name.trim()) return;
    setSaving(true);
    try {
      const res = await authFetch(`/api/project-groups/${groupUuid}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: name.trim(), description: description.trim() || null }),
      });
      const json = await res.json();
      if (json.success) {
        onUpdated();
      }
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    setDeleting(true);
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
      }
    } finally {
      setDeleting(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogContent className="max-w-[480px] gap-0 p-0">
        <DialogHeader className="border-b border-[#E5E2DC] px-6 py-5">
          <div className="flex items-center gap-2.5">
            <Settings className="h-5 w-5 text-[#C67A52]" />
            <DialogTitle className="text-[18px] font-semibold tracking-tight text-[#2C2C2C]">
              {t("manageGroup")}
            </DialogTitle>
          </div>
        </DialogHeader>

        <div className="space-y-5 px-6 py-5">
          {/* Edit Name */}
          <div className="space-y-1.5">
            <Label className="text-[13px] font-medium text-[#2C2C2C]">
              {t("groupName")}
            </Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              className="h-10 rounded-lg border-[#E5E2DC] text-[13px] focus-visible:ring-[#C67A52]"
            />
          </div>

          {/* Edit Description */}
          <div className="space-y-1.5">
            <Label className="text-[13px] font-medium text-[#2C2C2C]">
              {t("descriptionOptional")}
            </Label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              className="w-full rounded-lg border border-[#E5E2DC] px-3 py-2.5 text-[13px] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[#C67A52] focus-visible:ring-offset-1"
              placeholder={t("descriptionPlaceholder")}
            />
          </div>

          {/* Save Button */}
          <div className="flex justify-end">
            <Button
              onClick={handleSave}
              disabled={saving || !name.trim() || (name === groupName && description === (groupDescription ?? ""))}
              className="rounded-lg bg-[#C67A52] text-[13px] font-medium text-white hover:bg-[#B56A42]"
            >
              {saving ? t("saving") : t("saveChanges")}
            </Button>
          </div>
        </div>

        {/* Danger Zone */}
        <div className="border-t border-[#E5E2DC] px-6 py-5">
          {!showDeleteConfirm ? (
            <button
              onClick={() => setShowDeleteConfirm(true)}
              className="flex w-full cursor-pointer items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-4 py-3 text-left text-[13px] font-medium text-red-600 transition-colors hover:border-red-300 hover:bg-red-100"
            >
              <Trash2 className="h-4 w-4" />
              {t("deleteGroup")}
            </button>
          ) : (
            <div className="space-y-3 rounded-lg border border-red-200 bg-red-50 p-4">
              <div className="flex items-center gap-2 text-[13px] font-semibold text-red-700">
                <AlertTriangle className="h-4 w-4" />
                {t("deleteConfirmTitle")}
              </div>
              <p className="text-[12px] text-red-600">
                {t("deleteConfirmDesc")}
              </p>

              {projectCount > 0 && (
                <div className="space-y-2 pt-1">
                  <label className="flex cursor-pointer items-center gap-2 text-[12px] text-[#2C2C2C]">
                    <input
                      type="radio"
                      name="deleteOption"
                      checked={!deleteProjects}
                      onChange={() => setDeleteProjects(false)}
                      className="accent-[#C67A52]"
                    />
                    {t("deleteKeepProjects", { count: projectCount })}
                  </label>
                  <label className="flex cursor-pointer items-center gap-2 text-[12px] text-red-600">
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

              <div className="flex gap-2 pt-1">
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => setShowDeleteConfirm(false)}
                  className="rounded-lg border-[#E5E2DC] text-[12px]"
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
        </div>
      </DialogContent>
    </Dialog>
  );
}
