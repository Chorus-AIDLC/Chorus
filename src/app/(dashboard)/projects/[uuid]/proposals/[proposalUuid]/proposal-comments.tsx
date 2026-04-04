"use client";

import { useState, useEffect, useRef } from "react";
import { useTranslations } from "next-intl";
import { Bot, Send, Loader2, User } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { MentionEditor, type MentionEditorRef } from "@/components/mention-editor";
import {
  getProposalCommentsAction,
  createProposalCommentAction,
} from "./comment-actions";
import type { CommentResponse } from "@/services/comment.service";
import { ContentWithMentions } from "@/components/mention-renderer";
import { useRealtimeEntityEvent } from "@/contexts/realtime-context";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function formatRelativeTime(dateString: string, t: any): string {
  const date = new Date(dateString);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);
  const diffHours = Math.floor(diffMs / 3600000);
  const diffDays = Math.floor(diffMs / 86400000);

  if (diffMins < 1) return t("time.justNow");
  if (diffMins < 60) return t("time.minutesAgo", { minutes: diffMins });
  if (diffHours < 24) return t("time.hoursAgo", { hours: diffHours });
  if (diffDays < 7) return t("time.daysAgo", { days: diffDays });
  return date.toLocaleDateString();
}

interface ProposalCommentsProps {
  proposalUuid: string;
  currentUserUuid?: string;
}

export function ProposalComments({ proposalUuid, currentUserUuid }: ProposalCommentsProps) {
  const t = useTranslations();
  const [comment, setComment] = useState("");
  const [comments, setComments] = useState<CommentResponse[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const editorRef = useRef<MentionEditorRef>(null);

  // Auto-refresh comments when another user adds a comment
  useRealtimeEntityEvent("proposal", proposalUuid, (event) => {
    if (currentUserUuid && event.actorUuid === currentUserUuid) return;
    getProposalCommentsAction(proposalUuid).then((result) => {
      setComments(result.comments);
    });
  });

  useEffect(() => {
    async function loadComments() {
      setIsLoading(true);
      const result = await getProposalCommentsAction(proposalUuid);
      setComments(result.comments);
      setIsLoading(false);
    }
    loadComments();
  }, [proposalUuid]);

  const handleSubmit = async () => {
    if (!comment.trim() || isSubmitting) return;

    setIsSubmitting(true);
    const result = await createProposalCommentAction(proposalUuid, comment);
    setIsSubmitting(false);

    if (result.success && result.comment) {
      setComments((prev) => [...prev, result.comment!]);
      setComment("");
      editorRef.current?.clear();
    }
  };

  return (
    <div className="flex flex-col gap-0">
      {/* Input at top */}
      <div className="flex items-center gap-2.5 pb-4 border-b border-[#F0EDE8]">
        <Avatar className="h-7 w-7 shrink-0">
          <AvatarFallback className="bg-[#E5E0D8] text-[#6B6B6B]">
            <User className="h-3.5 w-3.5" />
          </AvatarFallback>
        </Avatar>
        <div className="flex-1 min-w-0">
          <MentionEditor
            ref={editorRef}
            value={comment}
            onChange={setComment}
            onSubmit={handleSubmit}
            placeholder={t("comments.addComment")}
            className="border border-[#E5E0D8] bg-white text-sm rounded-lg"
            disabled={isSubmitting}
          />
        </div>
        <Button
          size="sm"
          className="shrink-0 gap-1 bg-[#E07A5F] text-white hover:bg-[#D06A4F]"
          disabled={!comment.trim() || isSubmitting}
          onClick={handleSubmit}
        >
          {isSubmitting ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <Send className="h-3.5 w-3.5" />
          )}
        </Button>
      </div>

      {/* Comments List */}
      <div>
        {isLoading ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-4 w-4 animate-spin text-[#9A9A9A]" />
          </div>
        ) : comments.length === 0 ? (
          <p className="py-8 text-center text-sm text-[#9A9A9A] italic">{t("comments.noComments")}</p>
        ) : (
          comments.map((c) => {
            const isAgent = c.author.type === "agent";
            return (
              <div key={c.uuid} className="flex gap-2.5 py-4 border-b border-[#F0EDE8] last:border-b-0">
                <Avatar className="h-[30px] w-[30px] shrink-0">
                  <AvatarFallback
                    className={
                      isAgent
                        ? "bg-[#FFF3E0] text-[#E07A5F]"
                        : "bg-[#E5E0D8] text-[#6B6B6B] text-[11px] font-medium"
                    }
                  >
                    {isAgent ? (
                      <Bot className="h-[15px] w-[15px]" />
                    ) : (
                      c.author.name.charAt(0).toUpperCase()
                    )}
                  </AvatarFallback>
                </Avatar>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5 flex-wrap">
                    <span className="text-[13px] font-semibold text-[#1A1A1A]">
                      {c.author.name}
                    </span>
                    <span className={`inline-flex items-center rounded px-1.5 py-px text-[9px] font-medium ${
                      isAgent
                        ? "bg-[#FFF3E0] text-[#E07A5F]"
                        : "bg-[#F0EDE8] text-[#6B6B6B]"
                    }`}>
                      {isAgent ? t("comments.roleAgent") : t("comments.roleHuman")}
                    </span>
                    <span className="text-[11px] text-[#BFBFBF]">
                      {formatRelativeTime(c.createdAt, t)}
                    </span>
                  </div>
                  <div className="mt-1.5 text-[13px] leading-relaxed text-[#3D3D3D] max-w-none [&_h1]:text-sm [&_h1]:font-semibold [&_h1]:mt-2 [&_h1]:mb-1 [&_h2]:text-[13px] [&_h2]:font-semibold [&_h2]:mt-2 [&_h2]:mb-1 [&_h3]:text-[13px] [&_h3]:font-semibold [&_h3]:mt-1.5 [&_h3]:mb-0.5 [&_p]:my-1 [&_ul]:my-1 [&_ol]:my-1 [&_li]:my-0.5">
                    <ContentWithMentions>{c.content}</ContentWithMentions>
                  </div>
                </div>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}
