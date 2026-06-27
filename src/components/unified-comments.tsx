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
import {
  ContentWithMentions,
  type RenderMentionArg,
} from "@/components/mention-renderer";
import { MentionBadge } from "@/components/agent-presence";
import { useRealtimeEntityEvent } from "@/contexts/realtime-context";
import { PresenceIndicator } from "@/components/ui/presence-indicator";
import { getAgentColor } from "@/lib/agent-color";
import { formatDateTime } from "@/lib/format-date";
import { toast } from "sonner";

type TargetType = "idea" | "proposal" | "task" | "document";
type TranslateFn = ReturnType<typeof UseTranslationsType>;

const COLLAPSE_THRESHOLD = 200;

// React-native mention rendering for the COMMENT surface only (passed as the opt-in
// `renderMention` prop to ContentWithMentions). AGENT mentions become an interactive
// MentionBadge (online dot + identity popover + owner/online-gated "Open
// conversation"); USER mentions keep the existing styled-text appearance unchanged
// (q1 = agent mentions only). Module-level + stable identity so it never churns the
// memoized Streamdown components map upstream. Every OTHER ContentWithMentions
// surface omits this prop and keeps its byte-stable DOM-injection rendering.
function renderCommentMention(mention: RenderMentionArg) {
  if (mention.type === "agent") {
    return (
      <MentionBadge
        key={mention.index}
        mention={mention}
        displayName={mention.displayName}
      />
    );
  }
  // User mention — same styled text the legacy DOM-injection path produced.
  return (
    <span
      key={mention.index}
      className="text-blue-600 font-medium"
      title={`${mention.type}: ${mention.uuid}`}
    >
      @{mention.displayName}
    </span>
  );
}

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
  return formatDateTime(date);
}

// First-page / per-scroll page size for cursor-mode comment loading. Keep in sync
// with the server action's DEFAULT_COMMENT_PAGE_SIZE.
const COMMENT_PAGE_SIZE = 10;

// Upper bound on how many pages a single live-sync sweep walks before giving up and
// resetting the window to the newest pages (see syncLatestComments). Bounds a burst
// so a flood of new comments never forces an unbounded reload.
const MAX_SYNC_PAGES = 5;

// One cursor page of comments plus its continuation metadata — the shape both the
// initial/older-page loaders and the live-sync sweep consume.
export interface CommentPageResult {
  comments: CommentWithOwner[];
  total: number;
  nextCursor: string | null;
  hasMore: boolean;
}

export interface SyncLatestResult {
  comments: CommentWithOwner[];
  total: number;
  // contiguous = the fetched newest pages overlapped the already-loaded window, so the
  // merge preserved the loaded older pages. When false the window was reset to the
  // freshly fetched newest pages (a bounded, one-time loss of older history rather than
  // a permanent hole), and the reset* fields carry the new bottom cursor.
  contiguous: boolean;
  resetOldestCursor: string | null;
  resetHasMore: boolean;
}

// Union two comment lists by uuid into a single newest-first list. Incoming wins on a
// uuid collision (it is the fresher copy — e.g. an SSE refetch or the server echo of an
// optimistic insert), so the same comment never appears twice. Ordering is descending
// createdAt with a deterministic uuid tiebreak. Pure + exported for unit testing.
export function mergeCommentsByUuid(
  existing: CommentWithOwner[],
  incoming: CommentWithOwner[]
): CommentWithOwner[] {
  const byUuid = new Map<string, CommentWithOwner>();
  for (const c of existing) byUuid.set(c.uuid, c);
  for (const c of incoming) byUuid.set(c.uuid, c);
  return [...byUuid.values()].sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
    return a.uuid < b.uuid ? 1 : -1;
  });
}

// Live-sync sweep: fetch newest→older pages and merge them into `existing` until a
// fetched page overlaps an already-loaded comment (or the server reports no more),
// bounded by `maxPages`. This closes the burst gap: a single newest-page fetch would
// leave comments that are newer than the oldest-loaded row but beyond the first page
// permanently unreachable (older-cursor paging only walks below the oldest loaded row).
// On overlap the loaded older pages are preserved; if the cap is hit without overlap the
// window is reset to the fetched newest pages. Returns null if nothing could be fetched
// (caller keeps current state). Pure (DOM-free) + exported for unit testing.
export async function syncLatestComments(
  existing: CommentWithOwner[],
  fetchPage: (cursor: string | null) => Promise<CommentPageResult | null>,
  maxPages: number = MAX_SYNC_PAGES
): Promise<SyncLatestResult | null> {
  const loaded = new Set(existing.map((c) => c.uuid));
  const collected: CommentWithOwner[] = [];
  let cursor: string | null = null;
  let contiguous = false;
  let total = 0;
  let lastHasMore = false;
  let lastOldestCursor: string | null = null;
  let fetched = false;

  for (let i = 0; i < maxPages; i++) {
    const page = await fetchPage(cursor);
    if (!page) break; // fetch failed — stop and keep whatever we have
    fetched = true;
    total = page.total;
    collected.push(...page.comments);
    lastHasMore = page.hasMore;
    lastOldestCursor = page.nextCursor;
    if (page.comments.some((c) => loaded.has(c.uuid))) {
      contiguous = true; // reconnected with the loaded window
      break;
    }
    if (!page.hasMore) {
      contiguous = true; // reached the oldest comment — full set fetched, no hole
      break;
    }
    cursor = page.nextCursor;
  }

  if (!fetched) return null;

  if (contiguous) {
    return {
      comments: mergeCommentsByUuid(existing, collected),
      total,
      contiguous: true,
      resetOldestCursor: null,
      resetHasMore: false,
    };
  }

  return {
    comments: mergeCommentsByUuid([], collected),
    total,
    contiguous: false,
    resetOldestCursor: lastOldestCursor,
    resetHasMore: lastHasMore,
  };
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
  // Comments are held NEWEST-FIRST and rendered top-down (no reverse). Scrolling
  // down loads OLDER pages, appended to the end of this array.
  const [comments, setComments] = useState<CommentWithOwner[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isLoadingPage, setIsLoadingPage] = useState(false);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [oldestCursor, setOldestCursor] = useState<string | null>(null);
  const [hasMore, setHasMore] = useState(false);
  // Server-reported total comment count — the source of truth for the count badge,
  // accurate even though only a subset of comments is loaded.
  const [total, setTotal] = useState(0);
  const editorRef = useRef<MentionEditorRef>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);

  // Mutable mirrors of state the IntersectionObserver / SSE callbacks read, so they
  // see fresh values without being torn down + rebuilt on every state change.
  const commentsRef = useRef(comments);
  commentsRef.current = comments;
  const oldestCursorRef = useRef(oldestCursor);
  oldestCursorRef.current = oldestCursor;
  const hasMoreRef = useRef(hasMore);
  hasMoreRef.current = hasMore;
  const isLoadingPageRef = useRef(isLoadingPage);
  isLoadingPageRef.current = isLoadingPage;
  const isLoadingRef = useRef(isLoading);
  isLoadingRef.current = isLoading;

  const avatarSize = compact ? "h-6 w-6" : "h-[30px] w-[30px]";
  const gap = compact ? "gap-2" : "gap-2.5";
  const iconSize = compact ? "h-3 w-3" : "h-[15px] w-[15px]";

  // Notify the parent of the server-reported total whenever it changes.
  useEffect(() => {
    onCountChange?.(total);
  }, [total, onCountChange]);

  // Initial / reset load — the newest page only (fast first paint).
  const loadInitial = useCallback(async () => {
    setIsLoading(true);
    setLoadError(null);
    const result = await getCommentsAction(targetType, targetUuid, {
      limit: COMMENT_PAGE_SIZE,
    });
    if (result.success) {
      setComments(result.comments);
      setOldestCursor(result.nextCursor);
      setHasMore(result.hasMore);
      setTotal(result.total);
    } else {
      setLoadError(result.error);
    }
    setIsLoading(false);
  }, [targetType, targetUuid]);

  useEffect(() => {
    loadInitial();
  }, [loadInitial]);

  // Load the next OLDER page (scroll-down) and append below the current list.
  const loadOlder = useCallback(async () => {
    if (isLoadingPageRef.current || isLoadingRef.current) return;
    if (!hasMoreRef.current || !oldestCursorRef.current) return;
    setIsLoadingPage(true);
    const result = await getCommentsAction(targetType, targetUuid, {
      cursor: oldestCursorRef.current,
      limit: COMMENT_PAGE_SIZE,
    });
    if (result.success) {
      setComments((prev) => mergeCommentsByUuid(prev, result.comments));
      setOldestCursor(result.nextCursor);
      setHasMore(result.hasMore);
      setTotal(result.total);
    }
    setIsLoadingPage(false);
  }, [targetType, targetUuid]);

  // Auto-load older pages when the bottom sentinel scrolls into view. Re-runs once
  // the initial load finishes (isLoading flips false) so it attaches to the sentinel
  // element, which only mounts alongside the rendered list.
  useEffect(() => {
    const node = sentinelRef.current;
    if (!node) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0]?.isIntersecting) loadOlder();
      },
      { rootMargin: "120px" }
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [loadOlder, isLoading]);

  // SSE real-time delivery: instead of reloading the whole list, sweep newest→older
  // pages and merge them in de-duped by uuid (burst-safe — see syncLatestComments).
  useRealtimeEntityEvent(targetType, targetUuid, (event) => {
    if (currentUserUuid && event.actorUuid === currentUserUuid) return;
    syncLatestComments(commentsRef.current, async (cursor) => {
      const result = await getCommentsAction(targetType, targetUuid, {
        cursor,
        limit: COMMENT_PAGE_SIZE,
      });
      return result.success ? result : null;
    }).then((sync) => {
      if (!sync) return;
      setComments(sync.comments);
      setTotal(sync.total);
      if (!sync.contiguous) {
        // Window was reset to the newest pages — adopt the new bottom cursor.
        setOldestCursor(sync.resetOldestCursor);
        setHasMore(sync.resetHasMore);
      }
    });
  });

  const handleSubmit = async () => {
    if (!comment.trim() || isSubmitting) return;

    setIsSubmitting(true);
    const result = await createCommentAction(targetType, targetUuid, comment);
    setIsSubmitting(false);

    if (result.success) {
      // Optimistic insert via the same merge path so the later SSE echo de-dups.
      // Only bump the total when the comment is genuinely new to the loaded window
      // (guards against a double-count if an echo already merged it in).
      const isNew = !commentsRef.current.some((c) => c.uuid === result.comment.uuid);
      setComments((prev) => mergeCommentsByUuid(prev, [result.comment]));
      if (isNew) setTotal((prev) => prev + 1);
      setComment("");
      editorRef.current?.clear();
    } else {
      toast.error(result.error);
    }
  };

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
      {isLoading ? (
        <div className="flex items-center justify-center py-8">
          <Loader2 className="h-4 w-4 animate-spin text-[#9A9A9A]" />
        </div>
      ) : loadError ? (
        <div className="flex flex-col items-center gap-2 py-8 text-sm text-[#9A9A9A]">
          <AlertCircle className="h-4 w-4" />
          <p>{t("comments.loadError")}</p>
          <Button variant="outline" size="sm" onClick={loadInitial}>
            {t("comments.retry")}
          </Button>
        </div>
      ) : comments.length === 0 ? (
        <p className="py-8 text-center text-sm text-[#9A9A9A] italic">
          {t("comments.noComments")}
        </p>
      ) : (
        // No fixed-height inner scroll container: the comment list flows in the
        // host surface's own scroll area (the idea panel's ScrollArea, the proposal
        // discussion drawer's overflow-y-auto body). A nested `max-h + overflow-y`
        // here created a scroll-within-scroll trap on short mobile viewports — the
        // tail (last comment + "no more" footer) ended up below the fold and was
        // unreachable without separately scrolling the outer panel. The
        // IntersectionObserver sentinel still fires against the nearest scrollable
        // ancestor, so infinite scroll keeps working.
        <div>
          {comments.map((c) => (
            <CommentItem
              key={c.uuid}
              comment={c}
              compact={compact}
              avatarSize={avatarSize}
              gap={gap}
              iconSize={iconSize}
              t={t}
            />
          ))}
          {/* Bottom sentinel + loading / end-of-list affordance */}
          <div ref={sentinelRef} aria-hidden="true" />
          {isLoadingPage ? (
            <div className="flex items-center justify-center py-4">
              <Loader2 className="h-4 w-4 animate-spin text-[#9A9A9A]" />
              <span className="ml-2 text-xs text-[#9A9A9A]">
                {t("comments.loadingMore")}
              </span>
            </div>
          ) : (
            !hasMore && (
              <p className="py-4 text-center text-xs text-[#BFBFBF] italic">
                {t("comments.noMoreComments")}
              </p>
            )
          )}
        </div>
      )}
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
              <ContentWithMentions renderMention={renderCommentMention}>
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
              <ContentWithMentions renderMention={renderCommentMention}>
                {c.content}
              </ContentWithMentions>
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
