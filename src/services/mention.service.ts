// src/services/mention.service.ts
// Mention Service Layer — parse @mentions, create Mention records, trigger notifications
// Content format: @[DisplayName](user:uuid) or @[DisplayName](agent:uuid)

import { prisma } from "@/lib/prisma";
import { getActorName } from "@/lib/uuid-resolver";
import * as notificationService from "@/services/notification.service";

// ===== Constants =====

const MAX_MENTIONS_PER_CONTENT = 10;

// Regex to match @[DisplayName](type:uuid)
const MENTION_REGEX = /@\[([^\]]+)\]\((user|agent):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\)/gi;

// ===== Type Definitions =====

export interface MentionRef {
  type: "user" | "agent";
  uuid: string;
  displayName: string;
}

export interface Mentionable {
  type: "user" | "agent";
  uuid: string;
  name: string;
  email?: string | null;
  avatarUrl?: string | null;
  roles?: string[];
}

export interface CreateMentionsParams {
  companyUuid: string;
  sourceType: "comment" | "task" | "idea";
  sourceUuid: string;
  content: string;
  actorType: string;
  actorUuid: string;
  projectUuid: string;
  entityTitle: string;
}

export interface SearchMentionablesParams {
  companyUuid: string;
  query: string;
  actorType: string;
  actorUuid: string;
  ownerUuid?: string;
  limit?: number;
}

// ===== Service Methods =====

/**
 * Parse @[Name](type:uuid) patterns from content string.
 * Returns deduplicated list of mention references (max 10).
 */
export function parseMentions(content: string): MentionRef[] {
  const mentions: MentionRef[] = [];
  const seen = new Set<string>();

  let match;
  // Reset regex state
  MENTION_REGEX.lastIndex = 0;

  while ((match = MENTION_REGEX.exec(content)) !== null) {
    if (mentions.length >= MAX_MENTIONS_PER_CONTENT) break;

    const displayName = match[1];
    const type = match[2].toLowerCase() as "user" | "agent";
    const uuid = match[3].toLowerCase();
    const key = `${type}:${uuid}`;

    if (!seen.has(key)) {
      seen.add(key);
      mentions.push({ type, uuid, displayName });
    }
  }

  return mentions;
}

/**
 * Create Mention records and notifications for @mentions found in content.
 * - Parses mentions from content
 * - Deduplicates and enforces max 10 limit
 * - Filters out self-mentions
 * - Validates mentioned targets exist in the same company
 * - Batch creates Mention records
 * - Creates Notification for each valid mention (respecting preferences)
 */
export async function createMentions(params: CreateMentionsParams): Promise<void> {
  const {
    companyUuid,
    sourceType,
    sourceUuid,
    content,
    actorType,
    actorUuid,
    projectUuid,
    entityTitle,
  } = params;

  const mentions = parseMentions(content);
  if (mentions.length === 0) return;

  // Filter out self-mentions
  const filteredMentions = mentions.filter(
    (m) => !(m.type === actorType && m.uuid === actorUuid)
  );
  if (filteredMentions.length === 0) return;

  // Validate that mentioned targets exist in this company
  const validMentions: MentionRef[] = [];

  for (const mention of filteredMentions) {
    const exists = await validateMentionTarget(companyUuid, mention.type, mention.uuid);
    if (exists) {
      validMentions.push(mention);
    }
  }

  if (validMentions.length === 0) return;

  // Batch create Mention records
  await prisma.mention.createMany({
    data: validMentions.map((m) => ({
      companyUuid,
      sourceType,
      sourceUuid,
      mentionedType: m.type,
      mentionedUuid: m.uuid,
      actorType,
      actorUuid,
    })),
  });

  // Get actor name for notification message
  const actorName = (await getActorName(actorType, actorUuid)) ?? "Someone";

  // Get project name for notification
  const project = await prisma.project.findUnique({
    where: { uuid: projectUuid },
    select: { name: true },
  });
  const projectName = project?.name ?? "Unknown Project";

  // Build context snippet from content (truncate to ~100 chars around mention)
  const snippet = buildContextSnippet(content);

  // Resolve the navigable entity for notifications.
  // When a mention comes from a comment, we need to store the comment's parent entity
  // (task/idea/proposal/document) so the notification links to the correct page.
  let notifEntityType: string = sourceType;
  let notifEntityUuid = sourceUuid;

  if (sourceType === "comment") {
    const comment = await prisma.comment.findUnique({
      where: { uuid: sourceUuid },
      select: { targetType: true, targetUuid: true },
    });
    if (comment) {
      notifEntityType = comment.targetType;
      notifEntityUuid = comment.targetUuid;
    }
  }

  // Create notifications for each mentioned user/agent (respecting preferences)
  const notifications: notificationService.NotificationCreateParams[] = [];

  for (const mention of validMentions) {
    // Check notification preference
    const prefs = await notificationService.getPreferences(
      companyUuid,
      mention.type,
      mention.uuid
    );
    if (!prefs.mentioned) continue;

    const message = `${actorName} mentioned you: "${snippet}"`;

    notifications.push({
      companyUuid,
      projectUuid,
      recipientType: mention.type,
      recipientUuid: mention.uuid,
      entityType: notifEntityType,
      entityUuid: notifEntityUuid,
      entityTitle,
      projectName,
      action: "mentioned",
      message,
      actorType,
      actorUuid,
      actorName,
    });
  }

  if (notifications.length > 0) {
    await notificationService.createBatch(notifications);
  }
}

const DEFAULT_EMPTY_QUERY_LIMIT = 5;

/**
 * Search for mentionable users and agents within a company.
 * Permission scoping:
 * - User caller: all company users + own agents (agents with ownerUuid = actorUuid)
 * - Agent caller: all company users + same-owner agents (agents with same ownerUuid)
 */
export async function searchMentionables(params: SearchMentionablesParams): Promise<Mentionable[]> {
  const { companyUuid, query, actorType, actorUuid, ownerUuid, limit = 10 } = params;

  const effectiveLimit = Math.min(limit, 50);
  const results: Mentionable[] = [];

  // Determine the owner UUID for agent scoping (computed once, reused below)
  let agentOwnerUuid: string | undefined;
  if (actorType === "user") {
    agentOwnerUuid = actorUuid;
  } else if (actorType === "agent" && ownerUuid) {
    agentOwnerUuid = ownerUuid;
  }

  // If query is empty, return only user's own agents (ordered by createdAt DESC)
  // Design decision: We surface recently created agents first for quick access.
  // Human users are not shown in the empty-query case to keep the UX focused on AI agents.
  if (!query) {
    if (agentOwnerUuid) {
      const agents = await prisma.agent.findMany({
        where: {
          companyUuid,
          ownerUuid: agentOwnerUuid,
        },
        select: {
          uuid: true,
          name: true,
          roles: true,
        },
        orderBy: { createdAt: 'desc' },
        take: Math.min(DEFAULT_EMPTY_QUERY_LIMIT, effectiveLimit),
      });

      for (const agent of agents) {
        results.push({
          type: "agent",
          uuid: agent.uuid,
          name: agent.name,
          roles: agent.roles,
        });
      }
    }

    return results;
  }
  // Search users (all company users are mentionable)
  const users = await prisma.user.findMany({
    where: {
      companyUuid,
      OR: [
        { name: { contains: query, mode: "insensitive" } },
        { email: { contains: query, mode: "insensitive" } },
      ],
    },
    select: {
      uuid: true,
      name: true,
      email: true,
      avatarUrl: true,
    },
    take: effectiveLimit,
  });

  for (const user of users) {
    results.push({
      type: "user",
      uuid: user.uuid,
      name: user.name ?? user.email ?? "Unknown",
      email: user.email,
      avatarUrl: user.avatarUrl,
    });
  }

  // Search agents with permission scoping

  const agentWhere: {
    companyUuid: string;
    name: { contains: string; mode: "insensitive" };
    ownerUuid?: string;
  } = {
    companyUuid,
    name: { contains: query, mode: "insensitive" as const },
  };

  // Scope agents: user sees own agents, agent sees same-owner agents
  if (agentOwnerUuid) {
    agentWhere.ownerUuid = agentOwnerUuid;
  }

  const agents = await prisma.agent.findMany({
    where: agentWhere,
    select: {
      uuid: true,
      name: true,
      roles: true,
    },
    take: effectiveLimit - results.length > 0 ? effectiveLimit - results.length : effectiveLimit,
  });

  for (const agent of agents) {
    results.push({
      type: "agent",
      uuid: agent.uuid,
      name: agent.name,
      roles: agent.roles,
    });
  }

  return results.slice(0, effectiveLimit);
}

/**
 * Get all mentions for a given source entity.
 */
export async function getMentionsBySource(
  companyUuid: string,
  sourceType: string,
  sourceUuid: string
): Promise<Array<{ uuid: string; mentionedType: string; mentionedUuid: string; actorType: string; actorUuid: string; createdAt: string }>> {
  const mentions = await prisma.mention.findMany({
    where: {
      companyUuid,
      sourceType,
      sourceUuid,
    },
    select: {
      uuid: true,
      mentionedType: true,
      mentionedUuid: true,
      actorType: true,
      actorUuid: true,
      createdAt: true,
    },
    orderBy: { createdAt: "asc" },
  });

  return mentions.map((m) => ({
    uuid: m.uuid,
    mentionedType: m.mentionedType,
    mentionedUuid: m.mentionedUuid,
    actorType: m.actorType,
    actorUuid: m.actorUuid,
    createdAt: m.createdAt.toISOString(),
  }));
}

// ===== Internal Helpers =====

/**
 * Validate that a mention target (user or agent) exists in the given company.
 */
async function validateMentionTarget(
  companyUuid: string,
  type: "user" | "agent",
  uuid: string
): Promise<boolean> {
  if (type === "user") {
    const user = await prisma.user.findFirst({
      where: { uuid, companyUuid },
      select: { uuid: true },
    });
    return !!user;
  } else {
    const agent = await prisma.agent.findFirst({
      where: { uuid, companyUuid },
      select: { uuid: true },
    });
    return !!agent;
  }
}

/**
 * Build a context snippet from content, stripping mention syntax for readability.
 * Truncates to ~120 chars.
 */
function buildContextSnippet(content: string): string {
  // Replace @[Name](type:uuid) with just @Name for readability
  const cleaned = content.replace(MENTION_REGEX, "@$1");
  if (cleaned.length <= 120) return cleaned;
  return cleaned.substring(0, 117) + "...";
}
