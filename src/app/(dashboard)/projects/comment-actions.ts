"use server";

import { getServerAuthContext } from "@/lib/auth-server";
import {
  listComments,
  createComment,
  resolveProjectUuid,
  resolveAgentOwners,
  type CommentWithOwner,
} from "@/services/comment.service";
import { createActivity } from "@/services/activity.service";
import logger from "@/lib/logger";

const VALID_TARGET_TYPES = ["idea", "proposal", "task", "document"] as const;
type TargetType = (typeof VALID_TARGET_TYPES)[number];

/**
 * Get comments for any entity type, with agent owner resolution.
 */
export async function getCommentsAction(
  targetType: TargetType,
  targetUuid: string
): Promise<
  | { success: true; comments: CommentWithOwner[]; total: number }
  | { success: false; error: string }
> {
  const auth = await getServerAuthContext();
  if (!auth) {
    return { success: false, error: "Unauthorized" };
  }

  if (!VALID_TARGET_TYPES.includes(targetType)) {
    return { success: false, error: `Invalid target type: ${targetType}` };
  }

  try {
    const result = await listComments({
      companyUuid: auth.companyUuid,
      targetType,
      targetUuid,
      skip: 0,
      take: 100,
    });

    const commentsWithOwner = await resolveAgentOwners(result.comments);

    return { success: true, comments: commentsWithOwner, total: result.total };
  } catch (error) {
    logger.error({ err: error, targetType }, "Failed to get comments");
    return { success: false, error: `Failed to load comments` };
  }
}

/**
 * Create a comment on any entity type, with activity recording.
 */
export async function createCommentAction(
  targetType: TargetType,
  targetUuid: string,
  content: string
): Promise<
  | { success: true; comment: CommentWithOwner }
  | { success: false; error: string }
> {
  const auth = await getServerAuthContext();
  if (!auth) {
    return { success: false, error: "Unauthorized" };
  }

  if (!VALID_TARGET_TYPES.includes(targetType)) {
    return { success: false, error: `Invalid target type: ${targetType}` };
  }

  if (!content.trim()) {
    return { success: false, error: "Comment content is required" };
  }

  try {
    const comment = await createComment({
      companyUuid: auth.companyUuid,
      targetType,
      targetUuid,
      content: content.trim(),
      authorType: auth.type,
      authorUuid: auth.actorUuid,
    });

    // Record activity for notification pipeline
    const projectUuid = await resolveProjectUuid(targetType, targetUuid, auth.companyUuid);
    if (projectUuid) {
      await createActivity({
        companyUuid: auth.companyUuid,
        projectUuid,
        targetType,
        targetUuid,
        actorType: auth.type,
        actorUuid: auth.actorUuid,
        action: "comment_added",
      });
    }

    const [commentWithOwner] = await resolveAgentOwners([comment]);

    return { success: true, comment: commentWithOwner };
  } catch (error) {
    logger.error({ err: error, targetType }, "Failed to create comment");
    return { success: false, error: "Failed to create comment" };
  }
}
