"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Layers, Loader2, Plus } from "lucide-react";
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

interface CreateProjectGroupDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated?: () => void;
}

export function CreateProjectGroupDialog({
  open,
  onOpenChange,
  onCreated,
}: CreateProjectGroupDialogProps) {
  const t = useTranslations();
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = () => {
    if (!name.trim()) return;
    setError(null);

    startTransition(async () => {
      try {
        const res = await fetch("/api/project-groups", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: name.trim(),
            description: description.trim() || undefined,
          }),
        });
        const data = await res.json();

        if (data.success) {
          setName("");
          setDescription("");
          onOpenChange(false);
          onCreated?.();
          router.refresh();
        } else {
          setError(data.error || t("projectGroups.createFailed"));
        }
      } catch {
        setError(t("common.genericError"));
      }
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-[480px] gap-0 p-0 rounded-[16px]"
        showCloseButton={false}
      >
        <DialogHeader className="flex flex-row items-center justify-between p-[20px_24px] border-b border-[#E5E2DC]">
          <div className="flex items-center gap-2.5">
            <Layers className="h-5 w-5 text-[#C67A52]" />
            <DialogTitle className="text-lg font-semibold tracking-[-0.3px] text-[#2C2C2C]">
              {t("projectGroups.newGroupTitle")}
            </DialogTitle>
          </div>
        </DialogHeader>
        <DialogDescription className="sr-only">
          {t("projectGroups.newGroupTitle")}
        </DialogDescription>

        <div className="flex flex-col gap-5 p-6">
          {error && (
            <div className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
              {error}
            </div>
          )}

          <div className="flex flex-col gap-1.5">
            <Label className="text-[13px] font-medium text-[#2C2C2C]">
              {t("projectGroups.groupName")}
            </Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("projectGroups.groupNamePlaceholder")}
              className="h-10 rounded-lg border-[#E5E2DC]"
              onKeyDown={(e) => {
                if (isImeComposing(e)) return;
                if (e.key === "Enter" && name.trim()) handleSubmit();
              }}
            />
          </div>

          <div className="flex flex-col gap-1.5">
            <Label className="text-[13px] font-medium text-[#2C2C2C]">
              {t("projectGroups.descriptionOptional")}
            </Label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t("projectGroups.descriptionPlaceholder")}
              className="min-h-[80px] rounded-lg border-[#E5E2DC]"
            />
          </div>
        </div>

        <div className="flex justify-end gap-3 p-[16px_24px] border-t border-[#E5E2DC]">
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            className="rounded-lg border-[#E5E2DC] text-[13px]"
          >
            {t("common.cancel")}
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={isPending || !name.trim()}
            className="rounded-lg bg-[#C67A52] hover:bg-[#B56A42] text-white text-[13px] gap-1.5"
          >
            {isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Plus className="h-3.5 w-3.5" />
            )}
            {isPending
              ? t("common.creating")
              : t("projectGroups.createGroup")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
