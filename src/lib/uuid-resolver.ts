// src/lib/uuid-resolver.ts
// UUID Resolver - Simplified (UUID-Based Architecture)
// Most conversion functions are no longer needed; only formatting display utilities remain

import { prisma } from "@/lib/prisma";

export type TargetType = "idea" | "proposal" | "task" | "document";
export type ActorType = "user" | "agent";

// Get Actor name by UUID (for display)
export async function getActorName(
  actorType: string,
  actorUuid: string
): Promise<string | null> {
  if (actorType === "user") {
    const user = await prisma.user.findUnique({
      where: { uuid: actorUuid },
      select: { name: true, email: true },
    });
    if (!user) return "Unknown";
    // Prefer name, fall back to email
    return user.name || user.email || "Unknown";
  } else if (actorType === "agent") {
    const agent = await prisma.agent.findUnique({
      where: { uuid: actorUuid },
      select: { name: true },
    });
    return agent?.name ?? null;
  }
  return null;
}

// Format assignee info (using UUID directly)
export async function formatAssignee(
  assigneeType: string | null,
  assigneeUuid: string | null
): Promise<{ type: string; uuid: string; name: string } | null> {
  if (!assigneeType || !assigneeUuid) return null;

  const name = await getActorName(assigneeType, assigneeUuid);
  if (!name) return null;

  return {
    type: assigneeType,
    uuid: assigneeUuid,
    name,
  };
}

// Format createdBy info (using UUID directly)
// If type is not specified, tries user first, then agent
export async function formatCreatedBy(
  createdByUuid: string,
  creatorType?: "user" | "agent"
): Promise<{ type: string; uuid: string; name: string } | null> {
  if (creatorType) {
    const name = await getActorName(creatorType, createdByUuid);
    if (!name) return null;
    return { type: creatorType, uuid: createdByUuid, name };
  }

  // Type not specified, try user first
  const user = await prisma.user.findUnique({
    where: { uuid: createdByUuid },
    select: { name: true, email: true },
  });
  if (user) {
    return { type: "user", uuid: createdByUuid, name: user.name || user.email || "Unknown" };
  }

  // Then try agent
  const agent = await prisma.agent.findUnique({
    where: { uuid: createdByUuid },
    select: { name: true },
  });
  if (agent) {
    return { type: "agent", uuid: createdByUuid, name: agent.name };
  }

  return null;
}

// Complete assignee formatting (including assignedAt and assignedBy)
export interface AssigneeInfo {
  type: string;
  uuid: string;
  name: string;
  assignedAt: string | null;
  assignedBy: { type: string; uuid: string; name: string } | null;
}

export async function formatAssigneeComplete(
  assigneeType: string | null,
  assigneeUuid: string | null,
  assignedAt: Date | null,
  assignedByUuid: string | null // assignedBy is always user
): Promise<AssigneeInfo | null> {
  if (!assigneeType || !assigneeUuid) return null;

  const assigneeName = await getActorName(assigneeType, assigneeUuid);
  if (!assigneeName) return null;

  let assignedByInfo: { type: string; uuid: string; name: string } | null = null;
  if (assignedByUuid) {
    const userName = await getActorName("user", assignedByUuid);
    if (userName) {
      assignedByInfo = {
        type: "user",
        uuid: assignedByUuid,
        name: userName,
      };
    }
  }

  return {
    type: assigneeType,
    uuid: assigneeUuid,
    name: assigneeName,
    assignedAt: assignedAt?.toISOString() ?? null,
    assignedBy: assignedByInfo,
  };
}

// Format Proposal review info
export interface ReviewInfo {
  reviewedBy: { type: string; uuid: string; name: string };
  reviewNote: string | null;
  reviewedAt: string | null;
}

export async function formatReview(
  reviewedByUuid: string | null,
  reviewNote: string | null,
  reviewedAt: Date | null
): Promise<ReviewInfo | null> {
  if (!reviewedByUuid) return null;

  const userName = await getActorName("user", reviewedByUuid);
  if (userName && userName !== "Unknown") {
    return {
      reviewedBy: { type: "user", uuid: reviewedByUuid, name: userName },
      reviewNote,
      reviewedAt: reviewedAt?.toISOString() ?? null,
    };
  }

  const agentName = await getActorName("agent", reviewedByUuid);
  if (agentName) {
    return {
      reviewedBy: { type: "agent", uuid: reviewedByUuid, name: agentName },
      reviewNote,
      reviewedAt: reviewedAt?.toISOString() ?? null,
    };
  }

  return null;
}

// Batch get actor names - 2 queries total instead of N individual queries
export async function batchGetActorNames(
  actors: Array<{ type: string; uuid: string }>
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (actors.length === 0) return result;

  // Deduplicate by uuid per type
  const userUuids = [...new Set(actors.filter(a => a.type === "user").map(a => a.uuid))];
  const agentUuids = [...new Set(actors.filter(a => a.type === "agent").map(a => a.uuid))];

  const [users, agents] = await Promise.all([
    userUuids.length > 0
      ? prisma.user.findMany({ where: { uuid: { in: userUuids } }, select: { uuid: true, name: true, email: true } })
      : [],
    agentUuids.length > 0
      ? prisma.agent.findMany({ where: { uuid: { in: agentUuids } }, select: { uuid: true, name: true } })
      : [],
  ]);

  for (const user of users) {
    result.set(user.uuid, user.name || user.email || "Unknown");
  }
  for (const agent of agents) {
    result.set(agent.uuid, agent.name);
  }

  return result;
}

// Batch format createdBy - tries users first, then agents for unmatched UUIDs
export async function batchFormatCreatedBy(
  createdByUuids: string[]
): Promise<Map<string, { type: string; uuid: string; name: string }>> {
  const result = new Map<string, { type: string; uuid: string; name: string }>();
  if (createdByUuids.length === 0) return result;

  const unique = [...new Set(createdByUuids)];

  // Try users first
  const users = await prisma.user.findMany({
    where: { uuid: { in: unique } },
    select: { uuid: true, name: true, email: true },
  });

  const foundUuids = new Set<string>();
  for (const user of users) {
    foundUuids.add(user.uuid);
    result.set(user.uuid, { type: "user", uuid: user.uuid, name: user.name || user.email || "Unknown" });
  }

  // Then try agents for unmatched
  const remaining = unique.filter(uuid => !foundUuids.has(uuid));
  if (remaining.length > 0) {
    const agents = await prisma.agent.findMany({
      where: { uuid: { in: remaining } },
      select: { uuid: true, name: true },
    });
    for (const agent of agents) {
      result.set(agent.uuid, { type: "agent", uuid: agent.uuid, name: agent.name });
    }
  }

  return result;
}

// Get Session name by UUID
export async function getSessionName(sessionUuid: string): Promise<string | null> {
  const session = await prisma.agentSession.findUnique({
    where: { uuid: sessionUuid },
    select: { name: true },
  });
  return session?.name ?? null;
}

// Validate target entity exists (using UUID directly)
export async function validateTargetExists(
  targetType: TargetType,
  targetUuid: string,
  companyUuid: string
): Promise<boolean> {
  const where = { uuid: targetUuid, companyUuid };

  switch (targetType) {
    case "idea":
      return !!(await prisma.idea.findFirst({ where, select: { uuid: true } }));
    case "proposal":
      return !!(await prisma.proposal.findFirst({ where, select: { uuid: true } }));
    case "task":
      return !!(await prisma.task.findFirst({ where, select: { uuid: true } }));
    case "document":
      return !!(await prisma.document.findFirst({ where, select: { uuid: true } }));
    default:
      return false;
  }
}
