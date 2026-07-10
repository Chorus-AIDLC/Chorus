"use client";

import { useState } from "react";
import { useRouter } from "@/hooks/use-progress-router";
import { useTranslations } from "next-intl";
import { Trash2, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
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
import { deleteProjectAction } from "./actions";

interface ProjectActionsProps {
  projectUuid: string;
  projectName: string;
}

export function ProjectActions({ projectUuid, projectName }: ProjectActionsProps) {
  const [isDeleting, setIsDeleting] = useState(false);
  const t = useTranslations();
  const router = useRouter();

  const handleDelete = async () => {
    setIsDeleting(true);
    const result = await deleteProjectAction(projectUuid);
    // If redirect succeeds, we won't reach here.
    // If it fails, reset state.
    if (result && !result.success) {
      setIsDeleting(false);
    }
  };

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button
          variant="outline"
          size="icon"
          className="h-9 w-9 border-border text-[#D32F2F] dark:text-[#F08078] hover:bg-[#FFEBEE] dark:hover:bg-[#331619] hover:text-[#D32F2F] hover:border-[#D32F2F]"
        >
          <Trash2 className="h-4 w-4" />
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("projectOverview.deleteProject")}</AlertDialogTitle>
          <AlertDialogDescription>
            {t("projectOverview.deleteProjectConfirm", { name: projectName })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{t("common.cancel")}</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            onClick={handleDelete}
            disabled={isDeleting}
          >
            {isDeleting ? (
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
  );
}
