import type { CommentWithOwner } from "@/services/comment.service";

export const COMMENT_READ_TIMEOUT_MS = 15000;

type CommentPage = {
  comments: CommentWithOwner[];
  total: number;
  nextCursor: string | null;
  hasMore: boolean;
};

type CommentReadResult =
  | ({ success: true } & CommentPage)
  | { success: false; error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isComment(value: unknown): value is CommentWithOwner {
  if (!isRecord(value) || !isRecord(value.author)) return false;
  const { author } = value;
  return (
    typeof value.uuid === "string" &&
    value.uuid.length > 0 &&
    typeof value.targetType === "string" &&
    ["idea", "proposal", "task", "document"].includes(value.targetType) &&
    typeof value.targetUuid === "string" &&
    typeof value.content === "string" &&
    typeof value.createdAt === "string" &&
    Number.isFinite(Date.parse(value.createdAt)) &&
    typeof value.updatedAt === "string" &&
    Number.isFinite(Date.parse(value.updatedAt)) &&
    (author.type === "user" || author.type === "agent") &&
    typeof author.uuid === "string" &&
    typeof author.name === "string" &&
    (author.owner === undefined ||
      (isRecord(author.owner) &&
        typeof author.owner.uuid === "string" &&
        typeof author.owner.name === "string"))
  );
}

function isCommentPage(value: unknown): value is CommentPage {
  return (
    isRecord(value) &&
    Array.isArray(value.comments) &&
    value.comments.every(isComment) &&
    typeof value.total === "number" &&
    Number.isSafeInteger(value.total) &&
    value.total >= 0 &&
    (value.nextCursor === null ||
      (typeof value.nextCursor === "string" && value.nextCursor.length > 0)) &&
    typeof value.hasMore === "boolean" &&
    (!value.hasMore ||
      (value.nextCursor !== null && value.comments.length > 0))
  );
}

export async function getCommentPage(
  targetType: "idea" | "proposal" | "task" | "document",
  targetUuid: string,
  options: { cursor?: string | null; limit?: number; signal?: AbortSignal } = {},
): Promise<CommentReadResult> {
  const failure: CommentReadResult = {
    success: false,
    error: "Failed to load comments",
  };
  if (options.signal?.aborted) return failure;

  const controller = new AbortController();
  let cancel!: () => void;
  const cancelled = new Promise<CommentReadResult>((resolve) => {
    cancel = () => {
      resolve(failure);
      controller.abort();
    };
  });
  const timeout = setTimeout(cancel, COMMENT_READ_TIMEOUT_MS);
  options.signal?.addEventListener("abort", cancel, { once: true });

  try {
    const params = new URLSearchParams({
      targetType,
      targetUuid,
      limit: String(options.limit ?? 10),
    });
    if (options.cursor != null) params.set("cursor", options.cursor);

    const read = async (): Promise<CommentReadResult> => {
      const response = await fetch(`/api/comments?${params}`, {
        method: "GET",
        credentials: "same-origin",
        cache: "no-store",
        signal: controller.signal,
      });
      if (controller.signal.aborted || !response.ok) return failure;
      const body: unknown = await response.json();
      if (
        controller.signal.aborted ||
        !isRecord(body) ||
        body.success !== true ||
        !isCommentPage(body.data)
      ) {
        return failure;
      }
      return {
        success: true,
        comments: body.data.comments,
        total: body.data.total,
        nextCursor: body.data.nextCursor,
        hasMore: body.data.hasMore,
      };
    };

    return await Promise.race([cancelled, read()]);
  } catch {
    return failure;
  } finally {
    clearTimeout(timeout);
    options.signal?.removeEventListener("abort", cancel);
  }
}
