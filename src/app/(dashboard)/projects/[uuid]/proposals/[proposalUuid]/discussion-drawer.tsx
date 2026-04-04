"use client";

import { useTranslations } from "next-intl";
import { MessageCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "@/components/ui/sheet";
import { ProposalComments } from "./proposal-comments";

interface DiscussionDrawerProps {
  proposalUuid: string;
  currentUserUuid?: string;
  commentCount: number;
}

export function DiscussionDrawer({
  proposalUuid,
  currentUserUuid,
  commentCount,
}: DiscussionDrawerProps) {
  const t = useTranslations();

  return (
    <Sheet>
      <SheetTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="gap-1.5 border-[#E5E0D8] text-[#3D3D3D]"
        >
          <MessageCircle className="h-4 w-4" />
          <span>{t("proposals.discussion")}</span>
          {commentCount > 0 && (
            <Badge className="ml-0.5 h-5 min-w-5 justify-center rounded-full border-0 bg-[#E07A5F] px-1.5 text-[10px] font-semibold text-white">
              {commentCount}
            </Badge>
          )}
        </Button>
      </SheetTrigger>
      <SheetContent
        side="right"
        className="w-full sm:w-[420px] sm:max-w-[420px] p-0 flex flex-col"
      >
        <SheetHeader className="border-b border-[#F0EDE8] px-6 py-4">
          <SheetTitle className="flex items-center gap-2 text-base">
            <MessageCircle className="h-[18px] w-[18px]" />
            {t("proposals.discussion")}
            {commentCount > 0 && (
              <span className="rounded-full bg-[#F0EDE8] px-2 py-0.5 text-xs font-medium text-[#6B6B6B]">
                {commentCount}
              </span>
            )}
          </SheetTitle>
        </SheetHeader>
        <div className="flex-1 overflow-y-auto p-6">
          <ProposalComments
            proposalUuid={proposalUuid}
            currentUserUuid={currentUserUuid}
          />
        </div>
      </SheetContent>
    </Sheet>
  );
}
