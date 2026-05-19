"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Loader2, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { deleteDocumentAction } from "@/app/(dashboard)/projects/[uuid]/documents/actions";

interface DeleteDocumentButtonProps {
  documentUuid: string;
  documentTitle: string;
  projectUuid: string;
}

export function DeleteDocumentButton({
  documentUuid,
  documentTitle,
  projectUuid,
}: DeleteDocumentButtonProps) {
  const t = useTranslations("documents");
  const tCommon = useTranslations("common");
  const router = useRouter();

  const [open, setOpen] = React.useState(false);
  const [pending, setPending] = React.useState(false);
  const [inlineError, setInlineError] = React.useState<string | null>(null);

  const handleOpenChange = (next: boolean) => {
    if (pending) return;
    setOpen(next);
    if (!next) setInlineError(null);
  };

  const handleConfirm = async () => {
    setPending(true);
    setInlineError(null);
    const result = await deleteDocumentAction(documentUuid);
    if (result.success) {
      toast.success(t("deleteSuccess"));
      setOpen(false);
      setPending(false);
      router.replace(`/projects/${result.projectUuid}/documents`);
      router.refresh();
      return;
    }
    const message =
      result.error === "not_found" ? t("deleteFailedNotFound") : t("deleteFailed");
    setInlineError(message);
    toast.error(message);
    setPending(false);
  };

  return (
    <AlertDialog open={open} onOpenChange={handleOpenChange}>
      <AlertDialogTrigger asChild>
        <Button variant="destructive" size="sm">
          <Trash2 className="mr-2 h-4 w-4" />
          {tCommon("delete")}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{t("deleteDocument")}</AlertDialogTitle>
          <AlertDialogDescription>
            {t("deleteDocumentDescription", { title: documentTitle })}
          </AlertDialogDescription>
        </AlertDialogHeader>
        {inlineError && (
          <p className="text-sm text-destructive" role="alert">
            {inlineError}
          </p>
        )}
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>{tCommon("cancel")}</AlertDialogCancel>
          <Button
            variant="destructive"
            disabled={pending}
            onClick={handleConfirm}
          >
            {pending ? (
              <>
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                {tCommon("delete")}
              </>
            ) : (
              tCommon("delete")
            )}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export default DeleteDocumentButton;
