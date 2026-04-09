"use client";

import { useState, useCallback, useEffect } from "react";
import { useTranslations } from "next-intl";
import { Bot, Loader2 } from "lucide-react";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { ElaborationPanel } from "@/components/elaboration-panel";
import { getElaborationAction } from "@/app/(dashboard)/projects/[uuid]/ideas/[ideaUuid]/elaboration-actions";
import { useRealtimeEntityTypeEvent } from "@/contexts/realtime-context";
import { Streamdown } from "streamdown";
import { code } from "@streamdown/code";
import { motion } from "framer-motion";
import { fadeIn } from "@/lib/animation";
import type { IdeaResponse } from "@/services/idea.service";
import type { ElaborationResponse } from "@/types/elaboration";
import { AssigneeSection } from "./assignee-section";

interface ElaborationViewProps {
  idea: IdeaResponse;
  onRefresh: () => Promise<void> | void;
}

export function ElaborationView({ idea, onRefresh }: ElaborationViewProps) {
  const t = useTranslations("ideaTracker");
  const tCommon = useTranslations("common");

  const [elaboration, setElaboration] = useState<ElaborationResponse | null>(
    null
  );
  const [isLoading, setIsLoading] = useState(true);

  const loadElaboration = useCallback(async () => {
    const result = await getElaborationAction(idea.uuid);
    if (result.success && result.data) {
      setElaboration(result.data);
    }
    setIsLoading(false);
  }, [idea.uuid]);

  useEffect(() => {
    loadElaboration();
  }, [loadElaboration]);

  // Subscribe to SSE events to refresh elaboration when idea changes
  useRealtimeEntityTypeEvent("idea", loadElaboration);

  const handleRefresh = async () => {
    await loadElaboration();
    await onRefresh();
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-5 w-5 animate-spin text-[#C67A52]" />
      </div>
    );
  }

  return (
    <motion.div variants={fadeIn} initial="initial" animate="animate">
      {/* Assignee Section */}
      <AssigneeSection assignee={idea.assignee} />

      <Separator className="my-5 bg-[#F5F2EC]" />

      {/* Elaboration Q&A Panel — primary content, right after assignee */}
      {elaboration && elaboration.rounds.length > 0 ? (
        <div>
          <ElaborationPanel
            ideaUuid={idea.uuid}
            elaboration={elaboration}
            onRefresh={handleRefresh}
          />
        </div>
      ) : idea.status === "open" ? (
        /* Open idea — prompt to assign */
        <div className="flex flex-col items-center justify-center gap-3 py-8 text-center">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-[#FFF3E0]">
            <Bot className="h-5 w-5 text-[#E65100]" />
          </div>
          <div>
            <p className="text-sm font-medium text-[#2C2C2C]">
              {t("panel.elaborationNotStarted")}
            </p>
            <p className="mt-1 text-xs text-[#9A9A9A]">
              {t("panel.elaborationNotStartedDesc")}
            </p>
          </div>
        </div>
      ) : (
        /* Elaborating but no rounds yet — agent working */
        <div className="flex flex-col items-center justify-center gap-3 py-8 text-center">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-[#E3F2FD]">
            <Bot className="h-5 w-5 text-[#1976D2]" />
          </div>
          <div>
            <p className="text-sm font-medium text-[#2C2C2C]">
              {t("panel.elaborationWaiting")}
            </p>
            <p className="mt-1 text-xs text-[#9A9A9A]">
              {t("panel.elaborationWaitingDesc")}
            </p>
          </div>
        </div>
      )}

      {/* Content Section */}
      {idea.content && (
        <>
          <Separator className="my-5 bg-[#F5F2EC]" />
          <div>
            <Label className="text-[11px] font-medium uppercase tracking-wide text-[#9A9A9A]">
              {tCommon("content")}
            </Label>
            <div className="mt-2">
              <div className="prose prose-sm max-w-none text-[13px] leading-relaxed text-[#2C2C2C]">
                <Streamdown plugins={{ code }}>{idea.content}</Streamdown>
              </div>
            </div>
          </div>
        </>
      )}
    </motion.div>
  );
}
