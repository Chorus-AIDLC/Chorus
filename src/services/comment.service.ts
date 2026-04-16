// src/services/comment.service.ts
// Comment Service Layer (ARCHITECTURE.md §3.1 Service Layer)
// UUID-Based Architecture: All operations use UUIDs

import { prisma } from "@/lib/prisma";
import {
  getActorName,
  validateTargetExists,
  type TargetType,
} from "@/lib/uuid-resolver";
import * as mentionService from "@/services/mention.service";
import * as activityService from "@/services/activity.service";
import { eventBus, type RealtimeEvent } from "@/lib/event-bus";
import logger from "@/lib/logger";

export interface CommentListParams {
  companyUuid: string;
  targetType: TargetType;
  targetUuid: string;
  skip: number;
  take: number;
}

export interface CommentCreateParams {
  companyUuid: string;
  targetType: TargetType;
  targetUuid: string;
  content: string;
  authorType: "user" | "agent";
  authorUuid: string;
}

// Comment response format (using UUIDs)
export interface CommentResponse {
  uuid: string;
  targetType: string;
  targetUuid: string;
  content: string;
  author: {
    type: string;
    uuid: string;
    name: string;
  };
  createdAt: string;
  updatedAt: string;
}

// List comments
export async function listComments({
  companyUuid,
  targetType,
  targetUuid,
  skip,
  take,
}: CommentListParams): Promise<{ comments: CommentResponse[]; total: number }> {
  // Validate target exists
  const exists = await validateTargetExists(targetType, targetUuid, companyUuid);
  if (!exists) {
    return { comments: [], total: 0 };
  }

  const where = { companyUuid, targetType, targetUuid };

  const [rawComments, total] = await Promise.all([
    prisma.comment.findMany({
      where,
      skip,
      take,
      orderBy: { createdAt: "asc" },
      select: {
        uuid: true,
        targetType: true,
        targetUuid: true,
        content: true,
        authorType: true,
        authorUuid: true,
        createdAt: true,
        updatedAt: true,
      },
    }),
    prisma.comment.count({ where }),
  ]);

  // Convert to response format
  const comments: CommentResponse[] = await Promise.all(
    rawComments.map(async (c) => {
      const authorName = await getActorName(c.authorType, c.authorUuid);
      return {
        uuid: c.uuid,
        targetType: c.targetType,
        targetUuid: c.targetUuid,
        content: c.content,
        author: {
          type: c.authorType,
          uuid: c.authorUuid,
          name: authorName ?? "Unknown",
        },
        createdAt: c.createdAt.toISOString(),
        updatedAt: c.updatedAt.toISOString(),
      };
    })
  );

  return { comments, total };
}

// Create comment
export async function createComment({
  companyUuid,
  targetType,
  targetUuid,
  content,
  authorType,
  authorUuid,
}: CommentCreateParams): Promise<CommentResponse> {
  // Validate target exists
  const exists = await validateTargetExists(targetType, targetUuid, companyUuid);
  if (!exists) {
    throw new Error(`Target ${targetType} with UUID ${targetUuid} not found`);
  }

  const comment = await prisma.comment.create({
    data: {
      companyUuid,
      targetType,
      targetUuid,
      content,
      authorType,
      authorUuid,
    },
    select: {
      uuid: true,
      targetType: true,
      targetUuid: true,
      content: true,
      authorType: true,
      authorUuid: true,
      createdAt: true,
      updatedAt: true,
    },
  });

  // Get author name
  const authorName = await getActorName(comment.authorType, comment.authorUuid);

  // Emit SSE event for real-time comment updates (fire-and-forget)
  resolveProjectUuid(targetType, targetUuid).then((projectUuid) => {
    if (projectUuid) {
      eventBus.emitChange({
        companyUuid,
        projectUuid,
        entityType: targetType as RealtimeEvent["entityType"],
        entityUuid: targetUuid,
        action: "updated",
        actorUuid: authorUuid,
      });
    }
  }).catch(() => {});

  // Process @mentions in comment content (fire-and-forget)
  processCommentMentions(
    companyUuid,
    targetType,
    targetUuid,
    comment.uuid,
    content,
    authorType,
    authorUuid,
  ).catch((err) => logger.error({ err }, "Failed to process comment mentions"));

  return {
    uuid: comment.uuid,
    targetType: comment.targetType,
    targetUuid: comment.targetUuid,
    content: comment.content,
    author: {
      type: comment.authorType,
      uuid: comment.authorUuid,
      name: authorName ?? "Unknown",
    },
    createdAt: comment.createdAt.toISOString(),
    updatedAt: comment.updatedAt.toISOString(),
  };
}

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
 * Batch resolve agent owners for a list of comments.
 * 2 queries max: Agent table + User table.
 */
export async function resolveAgentOwners(
  comments: CommentResponse[]
): Promise<CommentWithOwner[]> {
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

// Resolve projectUuid from a comment target entity
export async function resolveProjectUuid(
  targetType: string,
  targetUuid: string,
  companyUuid?: string
): Promise<string | null> {
  const companyFilter = companyUuid ? { companyUuid } : {};
  switch (targetType) {
    case "task": {
      const task = await prisma.task.findFirst({ where: { uuid: targetUuid, ...companyFilter }, select: { projectUuid: true } });
      return task?.projectUuid ?? null;
    }
    case "idea": {
      const idea = await prisma.idea.findFirst({ where: { uuid: targetUuid, ...companyFilter }, select: { projectUuid: true } });
      return idea?.projectUuid ?? null;
    }
    case "proposal": {
      const proposal = await prisma.proposal.findFirst({ where: { uuid: targetUuid, ...companyFilter }, select: { projectUuid: true } });
      return proposal?.projectUuid ?? null;
    }
    case "document": {
      const doc = await prisma.document.findFirst({ where: { uuid: targetUuid, ...companyFilter }, select: { projectUuid: true } });
      return doc?.projectUuid ?? null;
    }
    default:
      return null;
  }
}

// Resolve entity title from a target type and UUID
async function resolveEntityTitle(
  targetType: string,
  targetUuid: string
): Promise<string> {
  switch (targetType) {
    case "task": {
      const task = await prisma.task.findUnique({ where: { uuid: targetUuid }, select: { title: true } });
      return task?.title ?? "Unknown Task";
    }
    case "idea": {
      const idea = await prisma.idea.findUnique({ where: { uuid: targetUuid }, select: { title: true } });
      return idea?.title ?? "Unknown Idea";
    }
    case "proposal": {
      const proposal = await prisma.proposal.findUnique({ where: { uuid: targetUuid }, select: { title: true } });
      return proposal?.title ?? "Unknown Proposal";
    }
    case "document": {
      const doc = await prisma.document.findUnique({ where: { uuid: targetUuid }, select: { title: true } });
      return doc?.title ?? "Unknown Document";
    }
    default:
      return "Unknown";
  }
}

// Process @mentions from a comment (called after createComment)
async function processCommentMentions(
  companyUuid: string,
  targetType: string,
  targetUuid: string,
  commentUuid: string,
  content: string,
  authorType: string,
  authorUuid: string,
): Promise<void> {
  const mentions = mentionService.parseMentions(content);
  if (mentions.length === 0) return;

  const projectUuid = await resolveProjectUuid(targetType, targetUuid);
  if (!projectUuid) return;

  const entityTitle = await resolveEntityTitle(targetType, targetUuid);

  await mentionService.createMentions({
    companyUuid,
    sourceType: "comment",
    sourceUuid: commentUuid,
    content,
    actorType: authorType,
    actorUuid: authorUuid,
    projectUuid,
    entityTitle,
  });

  // Log mention activity for each mentioned user/agent
  for (const mention of mentions) {
    if (mention.type === authorType && mention.uuid === authorUuid) continue; // skip self
    await activityService.createActivity({
      companyUuid,
      projectUuid,
      targetType: targetType as activityService.TargetType,
      targetUuid,
      actorType: authorType,
      actorUuid: authorUuid,
      action: "mentioned",
      value: {
        mentionedType: mention.type,
        mentionedUuid: mention.uuid,
        mentionedName: mention.displayName,
        sourceType: "comment",
        sourceUuid: commentUuid,
      },
    });
  }
}

// Batch get comment counts
export async function batchCommentCounts(
  companyUuid: string,
  targetType: TargetType,
  targetUuids: string[]
): Promise<Record<string, number>> {
  if (targetUuids.length === 0) return {};

  const counts = await prisma.comment.groupBy({
    by: ["targetUuid"],
    where: {
      companyUuid,
      targetType,
      targetUuid: { in: targetUuids },
    },
    _count: { targetUuid: true },
  });

  const result: Record<string, number> = {};
  for (const uuid of targetUuids) {
    result[uuid] = 0;
  }
  for (const item of counts) {
    result[item.targetUuid] = item._count.targetUuid;
  }
  return result;
}
