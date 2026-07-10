"use client";

import { useTranslations } from "next-intl";
import { Bot, Loader2 } from "lucide-react";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { ElaborationPanel } from "@/components/elaboration-panel";
import { MarkdownContent } from "@/components/markdown-content";
import { motion } from "framer-motion";
import { fadeIn } from "@/lib/animation";
import type { IdeaResponse } from "@/services/idea.service";
import type { ElaborationResponse } from "@/types/elaboration";
import { AssigneeSection } from "./assignee-section";

interface ElaborationViewProps {
  idea: IdeaResponse;
  // Elaboration data is loaded once at the panel level and shared with the
  // footer's "Verify Elaborate" gate — no separate fetch here.
  elaboration: ElaborationResponse | null;
  isLoading: boolean;
  onRefresh: () => Promise<void> | void;
  // Reassign entry: the panel wires these so the assignee block below becomes
  // the reassign trigger (replaces the removed footer reassign button).
  onReassign?: () => void;
  canReassign?: boolean;
}

export function ElaborationView({ idea, elaboration, isLoading, onRefresh, onReassign, canReassign }: ElaborationViewProps) {
  const t = useTranslations("ideaTracker");
  const tCommon = useTranslations("common");

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-5 w-5 animate-spin text-primary" />
      </div>
    );
  }

  return (
    <motion.div variants={fadeIn} initial="initial" animate="animate">
      {/* Assignee Section — doubles as the reassign trigger (elaboration q2). */}
      <AssigneeSection
        assignee={idea.assignee}
        onReassign={onReassign}
        editable={canReassign}
      />

      <Separator className="my-5 bg-secondary" />

      {/* Elaboration Q&A Panel — primary content, right after assignee */}
      {elaboration && elaboration.rounds.length > 0 ? (
        <div>
          <ElaborationPanel
            ideaUuid={idea.uuid}
            elaboration={elaboration}
            onRefresh={onRefresh}
          />
        </div>
      ) : idea.status === "open" ? (
        /* Open idea — prompt to assign */
        <div className="flex flex-col items-center justify-center gap-3 py-8 text-center">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-[#FFF3E0] dark:bg-[#3a2a12]">
            <Bot className="h-5 w-5 text-[#E65100] dark:text-[#F0A050]" />
          </div>
          <div>
            <p className="text-sm font-medium text-foreground">
              {t("panel.elaborationNotStarted")}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {t("panel.elaborationNotStartedDesc")}
            </p>
          </div>
        </div>
      ) : (
        /* Elaborating but no rounds yet — agent working */
        <div className="flex flex-col items-center justify-center gap-3 py-8 text-center">
          <div className="flex h-10 w-10 items-center justify-center rounded-full bg-[#E3F2FD] dark:bg-[#13253a]">
            <Bot className="h-5 w-5 text-[#1976D2] dark:text-[#5AA9F0]" />
          </div>
          <div>
            <p className="text-sm font-medium text-foreground">
              {t("panel.elaborationWaiting")}
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {t("panel.elaborationWaitingDesc")}
            </p>
          </div>
        </div>
      )}

      {/* Content Section */}
      {idea.content && (
        <>
          <Separator className="my-5 bg-secondary" />
          <div>
            <Label className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              {tCommon("content")}
            </Label>
            <div className="mt-2">
              <div className="prose prose-sm max-w-none text-[13px] leading-relaxed text-foreground">
                <MarkdownContent>{idea.content}</MarkdownContent>
              </div>
            </div>
          </div>
        </>
      )}
    </motion.div>
  );
}
