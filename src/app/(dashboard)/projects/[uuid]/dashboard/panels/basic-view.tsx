"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Bot, UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Separator } from "@/components/ui/separator";
import { Streamdown } from "streamdown";
import { code } from "@streamdown/code";
import { motion } from "framer-motion";
import { fadeIn } from "@/lib/animation";
import type { IdeaResponse } from "@/services/idea.service";
import { AssignIdeaModal } from "@/app/(dashboard)/projects/[uuid]/ideas/assign-idea-modal";

interface BasicViewProps {
  idea: IdeaResponse;
  projectUuid: string;
  currentUserUuid: string;
  onRefresh: () => void;
}

export function BasicView({ idea, projectUuid, currentUserUuid, onRefresh }: BasicViewProps) {
  const t = useTranslations("ideaTracker");
  const tCommon = useTranslations("common");
  const [showAssignModal, setShowAssignModal] = useState(false);

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

      {/* Content Section */}
      <div>
        <label className="text-[11px] font-medium uppercase tracking-wide text-[#9A9A9A]">
          {tCommon("content")}
        </label>
        <div className="mt-2">
          {idea.content ? (
            <div className="prose prose-sm max-w-none text-[13px] leading-relaxed text-[#2C2C2C]">
              <Streamdown plugins={{ code }}>{idea.content}</Streamdown>
            </div>
          ) : (
            <p className="text-sm italic text-[#9A9A9A]">
              {tCommon("noContent")}
            </p>
          )}
        </div>
      </div>

      <Separator className="my-5 bg-[#F5F2EC]" />

      {/* Created By Section */}
      <div>
        <label className="text-[11px] font-medium uppercase tracking-wide text-[#9A9A9A]">
          {tCommon("created")}
        </label>
        <div className="mt-2 flex items-center gap-2">
          {idea.createdBy && (
            <span className="text-sm text-[#2C2C2C]">
              {idea.createdBy.name}
            </span>
          )}
          <span className="text-xs text-[#9A9A9A]">
            {new Date(idea.createdAt).toLocaleDateString()}
          </span>
        </div>
      </div>

      {/* Assign / Reassign Action */}
      <Separator className="my-5 bg-[#F5F2EC]" />
      <div>
        <Button
          className="bg-[#C67A52] hover:bg-[#B56A42] text-white w-full"
          onClick={() => setShowAssignModal(true)}
        >
          <UserPlus className="mr-2 h-4 w-4" />
          {idea.assignee ? t("actions.reassign") : t("actions.assign")}
        </Button>
      </div>

      {showAssignModal && (
        <AssignIdeaModal
          idea={{
            uuid: idea.uuid,
            title: idea.title,
            content: idea.content,
            status: idea.status,
            assignee: idea.assignee
              ? { type: idea.assignee.type, uuid: idea.assignee.uuid, name: idea.assignee.name }
              : null,
          }}
          projectUuid={projectUuid}
          currentUserUuid={currentUserUuid}
          onClose={() => {
            setShowAssignModal(false);
            onRefresh();
          }}
        />
      )}
    </motion.div>
  );
}
