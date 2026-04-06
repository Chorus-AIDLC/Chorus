"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useTranslations } from "next-intl";
import type { useTranslations as UseTranslationsType } from "next-intl";
import { Bot, Send, Loader2, User, AlertCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { MentionEditor, type MentionEditorRef } from "@/components/mention-editor";
import {
  getCommentsAction,
  createCommentAction,
} from "@/app/(dashboard)/projects/comment-actions";
import type { CommentWithOwner } from "@/services/comment.service";
import { ContentWithMentions } from "@/components/mention-renderer";
import { useRealtimeEntityEvent } from "@/contexts/realtime-context";
import { PresenceIndicator } from "@/components/ui/presence-indicator";
import { getAgentColor } from "@/lib/agent-color";
import { toast } from "sonner";

type TargetType = "idea" | "proposal" | "task" | "document";
type TranslateFn = ReturnType<typeof UseTranslationsType>;

const COLLAPSE_THRESHOLD = 200;

function formatRelativeTime(dateString: string, t: TranslateFn): string {
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

interface UnifiedCommentsProps {
  targetType: TargetType;
  targetUuid: string;
  currentUserUuid?: string;
  onCountChange?: (count: number) => void;
  compact?: boolean;
}

export function UnifiedComments({
  targetType,
  targetUuid,
  currentUserUuid,
  onCountChange,
  compact = false,
}: UnifiedCommentsProps) {
  const t = useTranslations();
  const [comment, setComment] = useState("");
  const [comments, setComments] = useState<CommentWithOwner[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const editorRef = useRef<MentionEditorRef>(null);

  const avatarSize = compact ? "h-6 w-6" : "h-[30px] w-[30px]";
  const gap = compact ? "gap-2" : "gap-2.5";
  const iconSize = compact ? "h-3 w-3" : "h-[15px] w-[15px]";

  // Notify parent of comment count changes
  useEffect(() => {
    onCountChange?.(comments.length);
  }, [comments.length, onCountChange]);

  const loadComments = useCallback(async () => {
    setIsLoading(true);
    setLoadError(null);
    const result = await getCommentsAction(targetType, targetUuid);
    if (result.success) {
      setComments(result.comments);
    } else {
      setLoadError(result.error);
    }
    setIsLoading(false);
  }, [targetType, targetUuid]);

  // Initial load
  useEffect(() => {
    loadComments();
  }, [loadComments]);

  // SSE real-time refresh
  useRealtimeEntityEvent(targetType, targetUuid, (event) => {
    if (currentUserUuid && event.actorUuid === currentUserUuid) return;
    getCommentsAction(targetType, targetUuid).then((result) => {
      if (result.success) {
        setComments(result.comments);
      }
    });
  });

  const handleSubmit = async () => {
    if (!comment.trim() || isSubmitting) return;

    setIsSubmitting(true);
    const result = await createCommentAction(targetType, targetUuid, comment);
    setIsSubmitting(false);

    if (result.success) {
      setComments((prev) => [...prev, result.comment]);
      setComment("");
      editorRef.current?.clear();
    } else {
      toast.error(result.error);
    }
  };

  // Reverse chronological order (newest first)
  const sortedComments = [...comments].reverse();

  return (
    <PresenceIndicator entityType={targetType} entityUuid={targetUuid} subEntityType="comment">
    <div className="flex flex-col gap-0">
      {/* Input at top */}
      <div className={`flex items-center ${gap} pb-3 border-b border-[#F0EDE8]`}>
        <Avatar className={`${compact ? "h-6 w-6" : "h-7 w-7"} shrink-0`}>
          <AvatarFallback className="bg-[#E5E0D8] text-[#6B6B6B]">
            <User className={`${compact ? "h-3 w-3" : "h-3.5 w-3.5"}`} />
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
        ) : loadError ? (
          <div className="flex flex-col items-center gap-2 py-8 text-sm text-[#9A9A9A]">
            <AlertCircle className="h-4 w-4" />
            <p>{t("comments.loadError")}</p>
            <Button variant="outline" size="sm" onClick={loadComments}>
              {t("comments.retry")}
            </Button>
          </div>
        ) : sortedComments.length === 0 ? (
          <p className="py-8 text-center text-sm text-[#9A9A9A] italic">
            {t("comments.noComments")}
          </p>
        ) : (
          sortedComments.map((c) => (
            <CommentItem
              key={c.uuid}
              comment={c}
              compact={compact}
              avatarSize={avatarSize}
              gap={gap}
              iconSize={iconSize}
              t={t}
            />
          ))
        )}
      </div>
    </div>
    </PresenceIndicator>
  );
}

function CommentItem({
  comment: c,
  compact,
  avatarSize,
  gap,
  iconSize,
  t,
}: {
  comment: CommentWithOwner;
  compact: boolean;
  avatarSize: string;
  gap: string;
  iconSize: string;
  t: TranslateFn;
}) {
  const [expanded, setExpanded] = useState(false);
  const isAgent = c.author.type === "agent";
  const agentColor = isAgent ? getAgentColor(c.author.name) : null;
  const shouldCollapse = c.content.length > COLLAPSE_THRESHOLD;

  // Derive lighter background from agent color
  const agentBgColor = agentColor ? `${agentColor}18` : undefined;

  return (
    <div className={`flex ${gap} py-3 border-b border-[#F0EDE8] last:border-b-0`}>
      <Avatar className={`${avatarSize} shrink-0`}>
        <AvatarFallback
          style={
            isAgent
              ? { backgroundColor: agentBgColor, color: agentColor ?? undefined }
              : undefined
          }
          className={
            isAgent
              ? ""
              : "bg-[#E5E0D8] text-[#6B6B6B] text-[11px] font-medium"
          }
        >
          {isAgent ? (
            <Bot className={iconSize} />
          ) : (
            c.author.name.charAt(0).toUpperCase()
          )}
        </AvatarFallback>
      </Avatar>
      <div className="flex-1 min-w-0">
        {/* Meta line */}
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className={`${compact ? "text-xs" : "text-[13px]"} font-semibold text-[#1A1A1A]`}>
            {c.author.name}
          </span>
          <span
            style={
              isAgent
                ? { backgroundColor: agentBgColor, color: agentColor ?? undefined }
                : undefined
            }
            className={`inline-flex items-center rounded px-1.5 py-px text-[9px] font-medium ${
              isAgent ? "" : "bg-[#F0EDE8] text-[#6B6B6B]"
            }`}
          >
            {isAgent ? t("comments.roleAgent") : t("comments.roleHuman")}
          </span>
          <span className="text-[11px] text-[#BFBFBF]">
            {formatRelativeTime(c.createdAt, t)}
          </span>
        </div>

        {/* Delegation line */}
        {isAgent && c.author.owner && (
          <div className="flex items-center gap-1 mt-0.5">
            <span className="text-[11px] text-[#A3A3A3] italic">
              {t("comments.onBehalfOf", { name: c.author.owner.name })}
            </span>
          </div>
        )}

        {/* Content */}
        <div className={`mt-1 ${compact ? "text-xs" : "text-[13px]"} leading-relaxed text-[#3D3D3D] max-w-none [&_h1]:text-sm [&_h1]:font-semibold [&_h1]:mt-2 [&_h1]:mb-1 [&_h2]:text-[13px] [&_h2]:font-semibold [&_h2]:mt-2 [&_h2]:mb-1 [&_h3]:text-[13px] [&_h3]:font-semibold [&_h3]:mt-1.5 [&_h3]:mb-0.5 [&_p]:my-1 [&_ul]:my-1 [&_ol]:my-1 [&_li]:my-0.5`}>
          {shouldCollapse && !expanded ? (
            <>
              <ContentWithMentions>
                {c.content.slice(0, COLLAPSE_THRESHOLD) + "..."}
              </ContentWithMentions>
              <Button
                variant="link"
                size="sm"
                onClick={() => setExpanded(true)}
                className="h-auto p-0 text-[#E07A5F] text-xs font-medium mt-1"
              >
                {t("comments.showMore")}
              </Button>
            </>
          ) : (
            <>
              <ContentWithMentions>{c.content}</ContentWithMentions>
              {shouldCollapse && (
                <Button
                  variant="link"
                  size="sm"
                  onClick={() => setExpanded(false)}
                  className="h-auto p-0 text-[#E07A5F] text-xs font-medium mt-1"
                >
                  {t("comments.showLess")}
                </Button>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
