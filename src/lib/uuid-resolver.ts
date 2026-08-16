// src/lib/uuid-resolver.ts
// UUID Resolver - Simplified (UUID-Based Architecture)
// Most conversion functions are no longer needed; only formatting display utilities remain

import { prisma } from "@/lib/prisma";
import type { AuthContext } from "@/types/auth";

export type TargetType = "idea" | "proposal" | "task" | "document";
// Polymorphic assignee/actor type. `agent_instance` (added by
// add-agent-instance-addressing) means the assignee is a specific
// (agent, host, cwd) AgentInstance — the row's `assigneeUuid` is an
// AgentInstance.uuid, NOT an Agent.uuid. Use resolveAssigneeAgentUuid() to map it
// back to the owning agent before any agent-identity comparison or lookup.
export type ActorType = "user" | "agent" | "agent_instance";
export type AssignmentActorType = "user" | "agent";

export interface AssignmentActorInfo {
  type: AssignmentActorType;
  uuid: string;
  name: string;
}

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
  } else if (actorType === "agent_instance") {
    // The uuid is an AgentInstance.uuid; the display name is the owning agent's
    // name (the instance's host/cwd is surfaced separately by the UI).
    const instance = await prisma.agentInstance.findUnique({
      where: { uuid: actorUuid },
      select: { agent: { select: { name: true } } },
    });
    return instance?.agent?.name ?? null;
  }
  return null;
}

// ── Polymorphic assignee resolution (add-agent-instance-addressing) ──────────
//
// These two helpers are the SINGLE source of truth for handling the third
// polymorphic assignee value `agent_instance`. The hazard they exist to prevent:
// an `agent_instance` row's `assigneeUuid` is an AgentInstance.uuid, so a flat
// equality of `assigneeUuid` against an agent's uuid can NEVER match it — every
// "assigned to this agent" filter / ownership check / recipient resolution MUST
// route through these instead of comparing `assigneeUuid` directly.

/**
 * Map an assignment to its canonical AGENT uuid, for ownership checks and wake
 * recipients:
 *   - "agent"          → the assigneeUuid as-is (it already IS an agent uuid)
 *   - "agent_instance" → the owning agent (AgentInstance(assigneeUuid).agentUuid),
 *                        looked up company-scoped
 *   - "user" / null / unknown → null (not an agent)
 */
export async function resolveAssigneeAgentUuid(
  companyUuid: string,
  assigneeType: string | null,
  assigneeUuid: string | null
): Promise<string | null> {
  if (!assigneeType || !assigneeUuid) return null;
  if (assigneeType === "agent") return assigneeUuid;
  if (assigneeType === "agent_instance") {
    const instance = await prisma.agentInstance.findFirst({
      where: { uuid: assigneeUuid, companyUuid },
      select: { agentUuid: true },
    });
    return instance?.agentUuid ?? null;
  }
  return null;
}

/**
 * Ownership gate: does an Idea/Task assignment belong to the calling agent?
 *
 * Generalizes the legacy `assigneeType==="agent" && assigneeUuid===actorUuid`
 * (plus the owner-as-assignee `user` arm) so an `agent_instance` assignment owned
 * by the SAME agent also passes — the instance's `assigneeUuid` is an
 * AgentInstance.uuid, so it is resolved to its owning agent before the compare.
 *
 *   - agent          → assigneeUuid === actorUuid
 *   - agent_instance → resolveAssigneeAgentUuid(...) === actorUuid (DB lookup)
 *   - user           → ownerUuid set AND assigneeUuid === ownerUuid
 *
 * ASYNC: the `agent_instance` arm needs a DB read to map instance → agent.
 */
export async function isAssignmentOwnedByActor(
  auth: AuthContext,
  assigneeType: string | null,
  assigneeUuid: string | null
): Promise<boolean> {
  if (!assigneeType || !assigneeUuid) return false;
  if (assigneeType === "agent") {
    return assigneeUuid === auth.actorUuid;
  }
  if (assigneeType === "agent_instance") {
    const agentUuid = await resolveAssigneeAgentUuid(
      auth.companyUuid,
      assigneeType,
      assigneeUuid
    );
    return agentUuid !== null && agentUuid === auth.actorUuid;
  }
  if (assigneeType === "user") {
    return !!auth.ownerUuid && assigneeUuid === auth.ownerUuid;
  }
  return false;
}

/**
 * A single assignee-match condition for use inside a Prisma `OR` clause on Idea
 * or Task. Shape is intentionally the plain `{assigneeType, assigneeUuid}` /
 * `{assigneeType, assigneeUuid:{in}}` literal both models share.
 */
export interface AssigneeCondition {
  assigneeType: string;
  assigneeUuid: string | { in: string[] };
}

/**
 * Build the set of assignee conditions matching every assignment that belongs to
 * `auth`, for "my assignments" / tracker queries. Spread the result into a Prisma
 * `where.OR`.
 *
 * ASYNC: the `agent_instance` arm requires a DB read to resolve the actor's
 * instance uuids — a flat equality on the actor uuid would never match an
 * `agent_instance` row (its assigneeUuid is an instance uuid). When the agent has
 * no instances the arm is omitted (an empty `{in: []}` would match nothing and is
 * pruned).
 *
 * - agent actor → `{agent, actor}` + owner-as-assignee `{user, ownerUuid}`
 *   (preserves the existing getAssigneeConditions behavior) + `{agent_instance,
 *   {in: <actor's instance uuids>}}`.
 * - user actor → `{user, actor}`.
 */
export async function buildAssigneeMatch(
  auth: AuthContext
): Promise<AssigneeCondition[]> {
  const conditions: AssigneeCondition[] = [];
  if (auth.type === "agent") {
    conditions.push({ assigneeType: "agent", assigneeUuid: auth.actorUuid });
    if (auth.ownerUuid) {
      conditions.push({ assigneeType: "user", assigneeUuid: auth.ownerUuid });
    }
    // agent_instance rows whose owning agent IS this actor. Resolve the actor's
    // instance uuids; only add the arm when there is at least one (an empty IN
    // matches nothing, so omitting it is equivalent and avoids a dead clause).
    const instances = await prisma.agentInstance.findMany({
      where: { companyUuid: auth.companyUuid, agentUuid: auth.actorUuid },
      select: { uuid: true },
    });
    if (instances.length > 0) {
      conditions.push({
        assigneeType: "agent_instance",
        assigneeUuid: { in: instances.map((i) => i.uuid) },
      });
    }
  } else {
    conditions.push({ assigneeType: "user", assigneeUuid: auth.actorUuid });
  }
  return conditions;
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

/**
 * Resolve typed assignment provenance within the resource's company. Legacy
 * rows have no type, so retain the historical user interpretation first and
 * then try agent. Unknown/deleted identities resolve to null.
 */
export async function resolveAssignmentActor(
  companyUuid: string,
  assignedByType: string | null,
  assignedByUuid: string | null,
): Promise<AssignmentActorInfo | null> {
  if (!assignedByUuid) return null;

  if (assignedByType === "user" || assignedByType == null) {
    const user = await prisma.user.findFirst({
      where: { uuid: assignedByUuid, companyUuid },
      select: { name: true, email: true },
    });
    if (user) {
      return {
        type: "user",
        uuid: assignedByUuid,
        name: user.name || user.email || "Unknown",
      };
    }
    if (assignedByType === "user") return null;
  }

  if (assignedByType === "agent" || assignedByType == null) {
    const agent = await prisma.agent.findFirst({
      where: { uuid: assignedByUuid, companyUuid },
      select: { name: true },
    });
    if (agent) {
      return { type: "agent", uuid: assignedByUuid, name: agent.name };
    }
  }

  return null;
}

export async function batchResolveAssignmentActors(
  companyUuid: string,
  assignments: Array<{
    assignedByType: string | null;
    assignedByUuid: string | null;
  }>,
): Promise<Array<AssignmentActorInfo | null>> {
  const userUuids = [
    ...new Set(
      assignments
        .filter((item) => item.assignedByType === "user" || item.assignedByType == null)
        .flatMap((item) => (item.assignedByUuid ? [item.assignedByUuid] : [])),
    ),
  ];
  const agentUuids = [
    ...new Set(
      assignments
        .filter((item) => item.assignedByType === "agent" || item.assignedByType == null)
        .flatMap((item) => (item.assignedByUuid ? [item.assignedByUuid] : [])),
    ),
  ];

  const [users, agents] = await Promise.all([
    userUuids.length > 0
      ? prisma.user.findMany({
          where: { companyUuid, uuid: { in: userUuids } },
          select: { uuid: true, name: true, email: true },
        })
      : [],
    agentUuids.length > 0
      ? prisma.agent.findMany({
          where: { companyUuid, uuid: { in: agentUuids } },
          select: { uuid: true, name: true },
        })
      : [],
  ]);
  const userMap = new Map(users.map((user) => [user.uuid, user]));
  const agentMap = new Map(agents.map((agent) => [agent.uuid, agent]));

  return assignments.map(({ assignedByType, assignedByUuid }) => {
    if (!assignedByUuid) return null;
    if (assignedByType === "user" || assignedByType == null) {
      const user = userMap.get(assignedByUuid);
      if (user) {
        return {
          type: "user",
          uuid: assignedByUuid,
          name: user.name || user.email || "Unknown",
        };
      }
      if (assignedByType === "user") return null;
    }
    if (assignedByType === "agent" || assignedByType == null) {
      const agent = agentMap.get(assignedByUuid);
      if (agent) {
        return { type: "agent", uuid: assignedByUuid, name: agent.name };
      }
    }
    return null;
  });
}

/**
 * The durable (host, cwd) place + owning agent of an `agent_instance` assignee,
 * carried on the assignee payload so the UI can render the pinned instance via the
 * daemon-instance-format helpers AND compare ownership against the owning agent
 * (the assignee `uuid` is an instance uuid, so a client cannot derive the agent
 * from it). Present ONLY for `type === "agent_instance"`.
 */
export interface AssigneeInstanceInfo {
  /** The OWNING agent's uuid (AgentInstance.agentUuid). */
  agentUuid: string;
  /** Host the instance runs on. "" = unknown/host-less self-report. */
  host: string;
  /** Working directory. null = legacy daemon that never self-reported one. */
  cwd: string | null;
}

// Complete assignee formatting (including assignedAt and assignedBy)
export interface AssigneeInfo {
  type: string;
  uuid: string;
  name: string;
  assignedAt: string | null;
  assignedBy: { type: string; uuid: string; name: string } | null;
  // Present ONLY when type === "agent_instance" — the pinned (host, cwd) place and
  // owning agent uuid. The UI renders host/cwd and uses agentUuid for ownership.
  instance?: AssigneeInstanceInfo;
}

/**
 * Resolve an `agent_instance` assignee's durable (host, cwd) place + owning agent
 * for the UI payload. Returns null for a non-instance type or a missing instance
 * row. Company-scoping is intentionally NOT applied here: callers pass an
 * assigneeUuid already read off a company-scoped Idea/Task row, so the instance is
 * by construction in the same company; the lookup is by its unique uuid.
 */
export async function resolveAssigneeInstanceInfo(
  assigneeType: string | null,
  assigneeUuid: string | null
): Promise<AssigneeInstanceInfo | null> {
  if (assigneeType !== "agent_instance" || !assigneeUuid) return null;
  const instance = await prisma.agentInstance.findUnique({
    where: { uuid: assigneeUuid },
    select: { agentUuid: true, host: true, cwd: true },
  });
  if (!instance) return null;
  return { agentUuid: instance.agentUuid, host: instance.host, cwd: instance.cwd };
}

export async function formatAssigneeComplete(
  assigneeType: string | null,
  assigneeUuid: string | null,
  assignedAt: Date | null,
  assignedByUuid: string | null,
  assignedByType: string | null = null,
  companyUuid?: string,
): Promise<AssigneeInfo | null> {
  if (!assigneeType || !assigneeUuid) return null;

  const [assigneeName, instanceInfo] = await Promise.all([
    getActorName(assigneeType, assigneeUuid),
    resolveAssigneeInstanceInfo(assigneeType, assigneeUuid),
  ]);
  if (!assigneeName) return null;

  const assignedByInfo =
    assignedByUuid && companyUuid
      ? await resolveAssignmentActor(companyUuid, assignedByType, assignedByUuid)
      : assignedByUuid
        ? await resolveLegacyAssignmentActorWithoutCompany(assignedByType, assignedByUuid)
        : null;

  return {
    type: assigneeType,
    uuid: assigneeUuid,
    name: assigneeName,
    assignedAt: assignedAt?.toISOString() ?? null,
    assignedBy: assignedByInfo,
    ...(instanceInfo ? { instance: instanceInfo } : {}),
  };
}

async function resolveLegacyAssignmentActorWithoutCompany(
  assignedByType: string | null,
  assignedByUuid: string,
): Promise<AssignmentActorInfo | null> {
  if (assignedByType === "user" || assignedByType == null) {
    const user = await prisma.user.findUnique({
      where: { uuid: assignedByUuid },
      select: { name: true, email: true },
    });
    if (user) {
      return {
        type: "user",
        uuid: assignedByUuid,
        name: user.name || user.email || "Unknown",
      };
    }
    if (assignedByType === "user") return null;
  }
  if (assignedByType === "agent" || assignedByType == null) {
    const agent = await prisma.agent.findUnique({
      where: { uuid: assignedByUuid },
      select: { name: true },
    });
    if (agent) {
      return { type: "agent", uuid: assignedByUuid, name: agent.name };
    }
  }
  return null;
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

// Batch get actor names - up to 3 queries total instead of N individual queries.
// Handles all three polymorphic types, INCLUDING `agent_instance` — an
// instance-pinned assignee whose name is its OWNING agent's name (keyed in the
// result by the INSTANCE uuid, since that is the row's assigneeUuid). Omitting the
// instance arm previously dropped instance-pinned assignees entirely from any
// batched list/kanban render (their name lookup missed → the assignee fell to
// null → it silently disappeared from the board).
export async function batchGetActorNames(
  actors: Array<{ type: string; uuid: string }>
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  if (actors.length === 0) return result;

  // Deduplicate by uuid per type
  const userUuids = [...new Set(actors.filter(a => a.type === "user").map(a => a.uuid))];
  const agentUuids = [...new Set(actors.filter(a => a.type === "agent").map(a => a.uuid))];
  const instanceUuids = [...new Set(actors.filter(a => a.type === "agent_instance").map(a => a.uuid))];

  const [users, agents, instances] = await Promise.all([
    userUuids.length > 0
      ? prisma.user.findMany({ where: { uuid: { in: userUuids } }, select: { uuid: true, name: true, email: true } })
      : [],
    agentUuids.length > 0
      ? prisma.agent.findMany({ where: { uuid: { in: agentUuids } }, select: { uuid: true, name: true } })
      : [],
    instanceUuids.length > 0
      ? prisma.agentInstance.findMany({
          where: { uuid: { in: instanceUuids } },
          select: { uuid: true, agent: { select: { name: true } } },
        })
      : [],
  ]);

  for (const user of users) {
    result.set(user.uuid, user.name || user.email || "Unknown");
  }
  for (const agent of agents) {
    result.set(agent.uuid, agent.name);
  }
  // The agent_instance display name is its owning agent's name, keyed by the
  // instance uuid (the assigneeUuid the caller looks up by).
  for (const instance of instances) {
    if (instance.agent?.name) result.set(instance.uuid, instance.agent.name);
  }

  return result;
}

/**
 * Batch-resolve the durable (host, cwd) place + owning agent uuid for a set of
 * `agent_instance` assignee uuids — the list/kanban counterpart to
 * `resolveAssigneeInstanceInfo`. Keyed by the instance uuid. One query (or none).
 */
export async function batchGetAssigneeInstanceInfo(
  instanceUuids: string[]
): Promise<Map<string, AssigneeInstanceInfo>> {
  const result = new Map<string, AssigneeInstanceInfo>();
  const unique = [...new Set(instanceUuids)];
  if (unique.length === 0) return result;

  const rows = await prisma.agentInstance.findMany({
    where: { uuid: { in: unique } },
    select: { uuid: true, agentUuid: true, host: true, cwd: true },
  });
  for (const row of rows) {
    result.set(row.uuid, { agentUuid: row.agentUuid, host: row.host, cwd: row.cwd });
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
