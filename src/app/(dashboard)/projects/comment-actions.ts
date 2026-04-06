"use server";

import { getServerAuthContext } from "@/lib/auth-server";
import {
  listComments,
  createComment,
  resolveProjectUuid,
  type CommentResponse,
} from "@/services/comment.service";
import { createActivity } from "@/services/activity.service";
import { prisma } from "@/lib/prisma";

const VALID_TARGET_TYPES = ["idea", "proposal", "task", "document"] as const;
type TargetType = (typeof VALID_TARGET_TYPES)[number];

export interface CommentAuthor {
  type: string;
  uuid: string;
  name: string;
  owner?: { uuid: string; name: string };
}

export interface CommentWithOwner extends Omit<CommentResponse, "author"> {
  author: CommentAuthor;
}

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

    // Batch resolve agent owners (2 queries max, no N+1)
    const commentsWithOwner = await resolveAgentOwners(result.comments);

    return { success: true, comments: commentsWithOwner, total: result.total };
  } catch (error) {
    console.error(`Failed to get ${targetType} comments:`, error);
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
    const projectUuid = await resolveProjectUuid(targetType, targetUuid);
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

    // Resolve owner for the new comment
    const [commentWithOwner] = await resolveAgentOwners([comment]);

    return { success: true, comment: commentWithOwner };
  } catch (error) {
    console.error(`Failed to create ${targetType} comment:`, error);
    return { success: false, error: "Failed to create comment" };
  }
}

/**
 * Batch resolve agent owners for a list of comments.
 * 2 queries max: Agent table + User table.
 */
async function resolveAgentOwners(
  comments: CommentResponse[]
): Promise<CommentWithOwner[]> {
  // Collect unique agent author UUIDs
  const agentUuids = [
    ...new Set(
      comments
        .filter((c) => c.author.type === "agent")
        .map((c) => c.author.uuid)
    ),
  ];

  if (agentUuids.length === 0) {
    return comments.map((c) => ({ ...c, author: { ...c.author } }));
  }

  // Query 1: Get agent -> ownerUuid mapping
  const agents = await prisma.agent.findMany({
    where: { uuid: { in: agentUuids } },
    select: { uuid: true, ownerUuid: true },
  });

  const agentToOwnerUuid = new Map<string, string>();
  const ownerUuids: string[] = [];
  for (const agent of agents) {
    if (agent.ownerUuid) {
      agentToOwnerUuid.set(agent.uuid, agent.ownerUuid);
      ownerUuids.push(agent.ownerUuid);
    }
  }

  // Query 2: Get owner names
  const ownerNameMap = new Map<string, string>();
  if (ownerUuids.length > 0) {
    const owners = await prisma.user.findMany({
      where: { uuid: { in: [...new Set(ownerUuids)] } },
      select: { uuid: true, name: true, email: true },
    });
    for (const owner of owners) {
      ownerNameMap.set(owner.uuid, owner.name || owner.email || "Unknown");
    }
  }

  // Attach owner info to comments
  return comments.map((c) => {
    const author: CommentAuthor = { ...c.author };
    if (c.author.type === "agent") {
      const ownerUuid = agentToOwnerUuid.get(c.author.uuid);
      if (ownerUuid) {
        const ownerName = ownerNameMap.get(ownerUuid);
        if (ownerName) {
          author.owner = { uuid: ownerUuid, name: ownerName };
        }
      }
    }
    return { ...c, author };
  });
}
