"use client";

import { useState, useCallback, useEffect } from "react";
import { useTranslations } from "next-intl";
import { Bot, Loader2 } from "lucide-react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Separator } from "@/components/ui/separator";
import { ElaborationPanel } from "@/components/elaboration-panel";
import { getElaborationAction } from "@/app/(dashboard)/projects/[uuid]/ideas/[ideaUuid]/elaboration-actions";
import { useRealtimeEvent } from "@/contexts/realtime-context";
import { Streamdown } from "streamdown";
import { code } from "@streamdown/code";
import { motion } from "framer-motion";
import { fadeIn } from "@/lib/animation";
import type { IdeaResponse } from "@/services/idea.service";
import type { ElaborationResponse } from "@/types/elaboration";

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
    } else {
      console.error("[ElaborationView] Failed to load elaboration:", result.error);
    }
    setIsLoading(false);
  }, [idea.uuid]);

  useEffect(() => {
    loadElaboration();
  }, [loadElaboration]);

  // Subscribe to SSE events to refresh elaboration in real-time
  useRealtimeEvent(loadElaboration);

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
      <div>
        <label className="text-[11px] font-medium uppercase tracking-wide text-[#9A9A9A]">
          {tCommon("assignee")}
        </label>
        <div className="mt-2 flex items-center gap-2.5 rounded-lg bg-[#FAF8F4] p-3">
          {idea.assignee ? (
            <>
              <Avatar className="h-7 w-7">
                <AvatarFallback
                  className={
                    idea.assignee.type === "agent"
                      ? "bg-[#C67A52] text-white"
                      : "bg-[#E5E0D8] text-[#6B6B6B]"
                  }
                >
                  {idea.assignee.type === "agent" ? (
                    <Bot className="h-3.5 w-3.5" />
                  ) : (
                    idea.assignee.name.charAt(0).toUpperCase()
                  )}
                </AvatarFallback>
              </Avatar>
              <div>
                <div className="text-sm font-medium text-[#2C2C2C]">
                  {idea.assignee.name}
                </div>
                <div className="text-xs text-[#6B6B6B]">
                  {idea.assignee.type === "agent"
                    ? tCommon("agent")
                    : tCommon("user")}
                </div>
              </div>
            </>
          ) : (
            <span className="text-sm text-[#9A9A9A]">
              {tCommon("unassigned")}
            </span>
          )}
        </div>
      </div>

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
      ) : (
        /* Agent waiting state */
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
            <label className="text-[11px] font-medium uppercase tracking-wide text-[#9A9A9A]">
              {tCommon("content")}
            </label>
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
