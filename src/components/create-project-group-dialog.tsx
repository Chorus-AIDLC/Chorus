"use client";

import { useState, useTransition } from "react";
import { useRouter } from "@/hooks/use-progress-router";
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
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";

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
  const [visibility, setVisibility] = useState<"public" | "private">("public");

  const handleSubmit = () => {
    if (!name.trim() || isPending) return;
    setError(null);

    startTransition(async () => {
      try {
        const res = await fetch("/api/project-groups", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: name.trim(),
            description: description.trim() || undefined,
            visibility,
          }),
        });
        const data = await res.json();

        if (data.success) {
          setName("");
          setDescription("");
          setVisibility("public");
          onOpenChange(false);
          onCreated?.();
          router.refresh();
        } else {
          setError(t("projectGroups.createFailed"));
        }
      } catch {
        setError(t("common.genericError"));
      }
    });
  };

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!isPending) onOpenChange(next); }}>
      <DialogContent
        className="max-h-[90svh] overflow-y-auto sm:max-w-[480px] gap-0 p-0 rounded-[16px]"
        showCloseButton={false}
      >
        <DialogHeader className="flex flex-row items-center justify-between p-[20px_24px] border-b border-[#E5E2DC] dark:border-[#2a2a2e]">
          <div className="flex items-center gap-2.5">
            <Layers className="h-5 w-5 text-primary" />
            <DialogTitle className="text-lg font-semibold tracking-[-0.3px] text-foreground">
              {t("projectGroups.newGroupTitle")}
            </DialogTitle>
          </div>
        </DialogHeader>
        <DialogDescription className="sr-only">
          {t("projectGroups.newGroupTitle")}
        </DialogDescription>

        <div className="flex flex-col gap-5 p-6">
          {error && (
            <div role="alert" className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
              {error}
            </div>
          )}

          <div className="flex flex-col gap-1.5">
            <Label className="text-[13px] font-medium text-foreground">
              {t("projectGroups.groupName")}
            </Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder={t("projectGroups.groupNamePlaceholder")}
              className="h-10 rounded-lg border-[#E5E2DC] dark:border-[#2a2a2e]"
              onKeyDown={(e) => {
                if (isImeComposing(e)) return;
                if (e.key === "Enter" && name.trim()) handleSubmit();
              }}
            />
          </div>
          <div className="space-y-2">
            <Label id="create-group-visibility-label">{t("projectAccess.visibility.title")}</Label>
            <RadioGroup aria-labelledby="create-group-visibility-label" value={visibility} disabled={isPending} onValueChange={(value) => setVisibility(value as "public" | "private")} className="grid gap-2 sm:grid-cols-2">
              {(["public", "private"] as const).map((option) => (
                <Label key={option} htmlFor={`create-group-${option}`} className="flex cursor-pointer items-start gap-2 rounded-lg border border-border p-3 font-normal">
                  <RadioGroupItem id={`create-group-${option}`} value={option} />
                  <span className="space-y-1">
                    <span className="block text-sm font-medium">{t(`projectAccess.visibility.${option}`)}</span>
                    <span className="block text-xs text-muted-foreground">{t(`projectGroups.${option}Hint`)}</span>
                  </span>
                </Label>
              ))}
            </RadioGroup>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label className="text-[13px] font-medium text-foreground">
              {t("projectGroups.descriptionOptional")}
            </Label>
            <Textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder={t("projectGroups.descriptionPlaceholder")}
              className="min-h-[80px] rounded-lg border-[#E5E2DC] dark:border-[#2a2a2e]"
            />
          </div>
        </div>

        <div className="flex justify-end gap-3 p-[16px_24px] border-t border-[#E5E2DC] dark:border-[#2a2a2e]">
          <Button
            variant="outline"
            disabled={isPending}
            onClick={() => onOpenChange(false)}
            className="rounded-lg border-[#E5E2DC] dark:border-[#2a2a2e] text-[13px]"
          >
            {t("common.cancel")}
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={isPending || !name.trim()}
            className="rounded-lg bg-primary hover:bg-[#B56A42] text-white text-[13px] gap-1.5"
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
