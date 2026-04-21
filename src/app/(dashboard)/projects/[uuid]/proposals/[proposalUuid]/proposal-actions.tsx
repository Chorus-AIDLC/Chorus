"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { useTranslations } from "next-intl";
import { MoreHorizontal, Send, Check, X, Archive, Trash2, Undo2, FileText, ListChecks } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { approveProposalAction, rejectProposalAction, closeProposalAction, revokeProposalAction, submitProposalAction, deleteProposalAction } from "./actions";

interface MaterializedEntities {
  tasks: { uuid: string; title: string; status: string }[];
  documents: { uuid: string; title: string }[];
}

interface ProposalActionsProps {
  proposalUuid: string;
  projectUuid: string;
  status: string;
  materializedEntities?: MaterializedEntities | null;
}

export function ProposalActions({ proposalUuid, projectUuid, status, materializedEntities }: ProposalActionsProps) {
  const t = useTranslations();
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [approveDialogOpen, setApproveDialogOpen] = useState(false);
  const [approveNote, setApproveNote] = useState("");
  const [rejectDialogOpen, setRejectDialogOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState("");
  const [closeDialogOpen, setCloseDialogOpen] = useState(false);
  const [closeReason, setCloseReason] = useState("");
  const [revokeDialogOpen, setRevokeDialogOpen] = useState(false);
  const [revokeReason, setRevokeReason] = useState("");
  const [submitDialogOpen, setSubmitDialogOpen] = useState(false);
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false);

  const handleSubmit = () => {
    startTransition(async () => {
      const result = await submitProposalAction(proposalUuid);
      if (result.success) {
        setSubmitDialogOpen(false);
        router.refresh();
      }
    });
  };

  const handleApprove = () => {
    startTransition(async () => {
      const result = await approveProposalAction(proposalUuid, approveNote.trim() || undefined);
      if (result.success) {
        setApproveDialogOpen(false);
        setApproveNote("");
        router.refresh();
      }
    });
  };

  const handleReject = () => {
    startTransition(async () => {
      const result = await rejectProposalAction(proposalUuid, rejectReason);
      if (result.success) {
        setRejectDialogOpen(false);
        setRejectReason("");
        router.refresh();
      }
    });
  };

  const handleClose = () => {
    startTransition(async () => {
      const result = await closeProposalAction(proposalUuid, closeReason);
      if (result.success) {
        setCloseDialogOpen(false);
        setCloseReason("");
        router.refresh();
      }
    });
  };

  const handleRevoke = () => {
    startTransition(async () => {
      const result = await revokeProposalAction(proposalUuid, revokeReason.trim() || undefined);
      if (result.success) {
        setRevokeDialogOpen(false);
        setRevokeReason("");
        router.refresh();
      }
    });
  };

  const handleDelete = () => {
    startTransition(async () => {
      const result = await deleteProposalAction(proposalUuid, projectUuid);
      if (result.success) {
        setDeleteDialogOpen(false);
        router.push(`/projects/${projectUuid}/proposals`);
        router.refresh();
      }
    });
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            className="border-[#E5E0D8] text-[#3D3D3D] gap-1.5"
            disabled={isPending}
          >
            <MoreHorizontal className="h-4 w-4" />
            <span className="hidden sm:inline">{t("common.actions")}</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-48">
          {status === "draft" && (
            <DropdownMenuItem onClick={() => setSubmitDialogOpen(true)}>
              <Send className="h-4 w-4" />
              {t("proposals.submitForReview")}
            </DropdownMenuItem>
          )}
          {status === "pending" && (
            <>
              <DropdownMenuItem onClick={() => setApproveDialogOpen(true)}>
                <Check className="h-4 w-4 text-[#5A9E6F]" />
                {t("common.approve")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setRejectDialogOpen(true)}>
                <X className="h-4 w-4 text-[#D32F2F]" />
                {t("common.reject")}
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setCloseDialogOpen(true)}>
                <Archive className="h-4 w-4" />
                {t("proposals.closeProposal")}
              </DropdownMenuItem>
            </>
          )}
          {status === "approved" && (
            <DropdownMenuItem onClick={() => setRevokeDialogOpen(true)}>
              <Undo2 className="h-4 w-4" />
              {t("proposals.revokeProposal")}
            </DropdownMenuItem>
          )}
          {(status === "draft" || status === "pending" || status === "approved") && <DropdownMenuSeparator />}
          <DropdownMenuItem
            variant="destructive"
            onClick={() => setDeleteDialogOpen(true)}
          >
            <Trash2 className="h-4 w-4" />
            {t("proposals.deleteProposal")}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Dialog open={submitDialogOpen} onOpenChange={setSubmitDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("proposals.confirmSubmit")}</DialogTitle>
            <DialogDescription>{t("proposals.confirmSubmitDesc")}</DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              onClick={() => setSubmitDialogOpen(false)}
              className="border-[#E5E0D8] text-[#6B6B6B]"
            >
              {t("common.cancel")}
            </Button>
            <Button
              onClick={handleSubmit}
              disabled={isPending}
              className="bg-[#C67A52] hover:bg-[#B56A42] text-white"
            >
              {isPending ? t("common.processing") : t("proposals.submitForReview")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={approveDialogOpen} onOpenChange={setApproveDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("proposals.approveProposal")}</DialogTitle>
            <DialogDescription>{t("proposals.approveProposalDesc")}</DialogDescription>
          </DialogHeader>
          <Textarea
            value={approveNote}
            onChange={(e) => setApproveNote(e.target.value)}
            placeholder={t("proposals.approveNotePlaceholder")}
            className="min-h-[100px] border-[#E5E0D8]"
          />
          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              onClick={() => setApproveDialogOpen(false)}
              className="border-[#E5E0D8] text-[#6B6B6B]"
            >
              {t("common.cancel")}
            </Button>
            <Button
              onClick={handleApprove}
              disabled={isPending}
              className="bg-[#5A9E6F] hover:bg-[#4A8E5F] text-white"
            >
              {isPending ? t("common.processing") : t("common.approve")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={rejectDialogOpen} onOpenChange={setRejectDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("proposals.rejectProposal")}</DialogTitle>
            <DialogDescription>{t("proposals.rejectProposalDesc")}</DialogDescription>
          </DialogHeader>
          <Textarea
            value={rejectReason}
            onChange={(e) => setRejectReason(e.target.value)}
            placeholder={t("proposals.rejectReasonPlaceholder")}
            className="min-h-[100px] border-[#E5E0D8]"
          />
          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              onClick={() => setRejectDialogOpen(false)}
              className="border-[#E5E0D8] text-[#6B6B6B]"
            >
              {t("common.cancel")}
            </Button>
            <Button
              onClick={handleReject}
              disabled={isPending || !rejectReason.trim()}
              className="bg-[#D32F2F] hover:bg-[#B71C1C] text-white"
            >
              {isPending ? t("common.processing") : t("common.reject")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={closeDialogOpen} onOpenChange={setCloseDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("proposals.closeProposal")}</DialogTitle>
            <DialogDescription>{t("proposals.closeProposalDesc")}</DialogDescription>
          </DialogHeader>
          <Textarea
            value={closeReason}
            onChange={(e) => setCloseReason(e.target.value)}
            placeholder={t("proposals.closeReasonPlaceholder")}
            className="min-h-[100px] border-[#E5E0D8]"
          />
          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              onClick={() => setCloseDialogOpen(false)}
              className="border-[#E5E0D8] text-[#6B6B6B]"
            >
              {t("common.cancel")}
            </Button>
            <Button
              onClick={handleClose}
              disabled={isPending || !closeReason.trim()}
              className="bg-[#6B6B6B] hover:bg-[#555555] text-white"
            >
              {isPending ? t("common.processing") : t("proposals.closeProposal")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={revokeDialogOpen} onOpenChange={setRevokeDialogOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>{t("proposals.revokeProposal")}</DialogTitle>
            <DialogDescription>{t("proposals.revokeProposalDesc")}</DialogDescription>
          </DialogHeader>
          {materializedEntities && (materializedEntities.tasks.length > 0 || materializedEntities.documents.length > 0) && (
            <div className="space-y-3 rounded-lg border border-[#FFCDD2] bg-[#FFF5F5] p-3">
              {materializedEntities.tasks.length > 0 && (
                <div>
                  <div className="flex items-center gap-1.5 text-xs font-semibold text-[#D32F2F] mb-1.5">
                    <ListChecks className="h-3.5 w-3.5" />
                    {t("proposals.revokeTasksToClose", { count: materializedEntities.tasks.length })}
                  </div>
                  <ul className="space-y-1 pl-5">
                    {materializedEntities.tasks.map((task) => (
                      <li key={task.uuid} className="text-xs text-[#6B6B6B]">
                        {task.title}
                        <span className="ml-1.5 text-[10px] text-muted-foreground">({task.status})</span>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {materializedEntities.documents.length > 0 && (
                <div>
                  <div className="flex items-center gap-1.5 text-xs font-semibold text-[#D32F2F] mb-1.5">
                    <FileText className="h-3.5 w-3.5" />
                    {t("proposals.revokeDocsToDelete", { count: materializedEntities.documents.length })}
                  </div>
                  <ul className="space-y-1 pl-5">
                    {materializedEntities.documents.map((doc) => (
                      <li key={doc.uuid} className="text-xs text-[#6B6B6B]">
                        {doc.title}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
          <Textarea
            value={revokeReason}
            onChange={(e) => setRevokeReason(e.target.value)}
            placeholder={t("proposals.revokeReasonPlaceholder")}
            className="min-h-[100px] border-[#E5E0D8]"
          />
          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              onClick={() => setRevokeDialogOpen(false)}
              className="border-[#E5E0D8] text-[#6B6B6B]"
            >
              {t("common.cancel")}
            </Button>
            <Button
              onClick={handleRevoke}
              disabled={isPending}
              className="bg-[#D32F2F] hover:bg-[#B71C1C] text-white"
            >
              {isPending ? t("common.processing") : t("proposals.revokeProposal")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={deleteDialogOpen} onOpenChange={setDeleteDialogOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{t("proposals.deleteProposal")}</DialogTitle>
            <DialogDescription>{t("proposals.deleteProposalDesc")}</DialogDescription>
          </DialogHeader>
          <DialogFooter className="gap-2">
            <Button
              variant="outline"
              onClick={() => setDeleteDialogOpen(false)}
              className="border-[#E5E0D8] text-[#6B6B6B]"
            >
              {t("common.cancel")}
            </Button>
            <Button
              onClick={handleDelete}
              disabled={isPending}
              className="bg-[#D32F2F] hover:bg-[#B71C1C] text-white"
            >
              {isPending ? t("common.processing") : t("common.delete")}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
