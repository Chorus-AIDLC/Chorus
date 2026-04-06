"use client";

import { useState, useCallback } from "react";
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
import { PresenceIndicator } from "@/components/ui/presence-indicator";
import { useRealtimeEntityEvent } from "@/contexts/realtime-context";
import { UnifiedComments } from "@/components/unified-comments";
import { getCommentsAction } from "@/app/(dashboard)/projects/comment-actions";

interface DiscussionDrawerProps {
  proposalUuid: string;
  currentUserUuid?: string;
  commentCount: number;
}

export function DiscussionDrawer({
  proposalUuid,
  currentUserUuid,
  commentCount: initialCount,
}: DiscussionDrawerProps) {
  const t = useTranslations();
  const [count, setCount] = useState(initialCount);

  // Listen for SSE events to update badge count even when drawer is closed
  const refreshCount = useCallback(async () => {
    try {
      const result = await getCommentsAction("proposal", proposalUuid);
      if (!result.success) return;
      setCount(result.comments.length);
    } catch {
      // Ignore — badge stays at last known count
    }
  }, [proposalUuid]);

  useRealtimeEntityEvent("proposal", proposalUuid, refreshCount);

  return (
    <PresenceIndicator entityType="proposal" entityUuid={proposalUuid} subEntityType="comment">
      <Sheet>
        <SheetTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            className="gap-1.5 border-[#E5E0D8] text-[#3D3D3D]"
          >
            <MessageCircle className="h-4 w-4" />
            <span>{t("proposals.discussion")}</span>
            {count > 0 && (
              <Badge className="ml-0.5 h-5 min-w-5 justify-center rounded-full border-0 bg-[#E07A5F] px-1.5 text-[10px] font-semibold text-white">
                {count}
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
              {count > 0 && (
                <span className="rounded-full bg-[#F0EDE8] px-2 py-0.5 text-xs font-medium text-[#6B6B6B]">
                  {count}
                </span>
              )}
            </SheetTitle>
          </SheetHeader>
          <div className="flex-1 overflow-y-auto p-6">
            <UnifiedComments
              targetType="proposal"
              targetUuid={proposalUuid}
              currentUserUuid={currentUserUuid}
              onCountChange={setCount}
            />
          </div>
        </SheetContent>
      </Sheet>
    </PresenceIndicator>
  );
}
