"use client";

import { useTransition } from "react";
import { useTranslations } from "next-intl";
import { ArrowRightLeft, Check, Loader2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";

interface MoveProjectConfirmDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectName: string;
  sourceGroupName: string;
  targetGroupName: string;
  onConfirm: () => Promise<void>;
}

export function MoveProjectConfirmDialog({
  open,
  onOpenChange,
  projectName,
  sourceGroupName,
  targetGroupName,
  onConfirm,
}: MoveProjectConfirmDialogProps) {
  const t = useTranslations();
  const [isPending, startTransition] = useTransition();

  const handleConfirm = () => {
    startTransition(async () => {
      await onConfirm();
      onOpenChange(false);
    });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="sm:max-w-[440px] gap-0 p-0 rounded-[16px]"
        showCloseButton={false}
      >
        <DialogTitle className="sr-only">
          {t("projectGroups.moveTitle")}
        </DialogTitle>

        <div className="flex flex-col items-center gap-4 p-6">
          <div className="flex h-12 w-12 items-center justify-center rounded-full bg-primary/[0.13]">
            <ArrowRightLeft className="h-[22px] w-[22px] text-primary" />
          </div>

          <p className="text-base font-semibold text-foreground">
            {t("projectGroups.moveTitle")}
          </p>

          <DialogDescription className="text-center text-[13px] leading-[1.5] text-muted-foreground">
            {t("projectGroups.moveDescription", {
              projectName,
              sourceGroupName,
              targetGroupName,
            })}
          </DialogDescription>
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
            onClick={handleConfirm}
            disabled={isPending}
            className="rounded-lg bg-primary hover:bg-[#B56A42] text-white text-[13px] gap-1.5"
          >
            {isPending ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : (
              <Check className="h-3.5 w-3.5" />
            )}
            {isPending
              ? t("common.processing")
              : t("projectGroups.confirmMove")}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
