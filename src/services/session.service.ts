// src/services/session.service.ts
// Agent Session Service Layer — sub-session management (swarm mode observability)
// UUID-Based Architecture: All operations use UUIDs

import { prisma } from "@/lib/prisma";
import { eventBus } from "@/lib/event-bus";
import { claimTask } from "@/services/task.service";

// ===== Type Definitions =====

export interface SessionCreateParams {
  companyUuid: string;
  agentUuid: string;
  name: string;
  description?: string | null;
}

export interface SessionCheckinInfo {
  taskUuid: string;
  checkinAt: string;
  checkoutAt: string | null;
}

export interface SessionResponse {
  uuid: string;
  agentUuid: string;
  name: string;
  description: string | null;
  status: string;
  lastActiveAt: string;
  createdAt: string;
  updatedAt: string;
  checkins: SessionCheckinInfo[];
}

export interface TaskSessionInfo {
  sessionUuid: string;
  sessionName: string;
  agentUuid: string;
  agentName: string;
  checkinAt: string;
}

// ===== Staleness Primitives =====

// A session is "fresh" if its lastActiveAt is within this window.
// Default-list reads (UI) hide stale active sessions; audit-trail reads
// (MCP listAgentSessions, getSession) ignore this filter.
export const SESSION_STALE_THRESHOLD_MS = 60 * 60 * 1000;

// Where-clause fragment matching active+fresh sessions.
function freshSessionWhereClause() {
  return {
    status: "active",
    lastActiveAt: { gt: new Date(Date.now() - SESSION_STALE_THRESHOLD_MS) },
  };
}

// Single source of truth for refreshing lastActiveAt as a side-effect of
// any session-touching operation. Skips the write when the session row is
// already closed so closed sessions retain their final lastActiveAt.
async function touchLastActiveAt(sessionUuid: string): Promise<void> {
  const session = await prisma.agentSession.findUnique({
    where: { uuid: sessionUuid },
    select: { status: true },
  });
  if (!session || session.status === "closed") return;

  await prisma.agentSession.update({
    where: { uuid: sessionUuid },
    data: { lastActiveAt: new Date() },
  });
}

// ===== Internal Helper Functions =====

function formatSessionResponse(
  session: {
    uuid: string;
    agentUuid: string;
    name: string;
    description: string | null;
    status: string;
    lastActiveAt: Date;
    createdAt: Date;
    updatedAt: Date;
    taskCheckins?: Array<{
      taskUuid: string;
      checkinAt: Date;
      checkoutAt: Date | null;
    }>;
  }
): SessionResponse {
  return {
    uuid: session.uuid,
    agentUuid: session.agentUuid,
    name: session.name,
    description: session.description,
    status: session.status,
    lastActiveAt: session.lastActiveAt.toISOString(),
    createdAt: session.createdAt.toISOString(),
    updatedAt: session.updatedAt.toISOString(),
    checkins: (session.taskCheckins || []).map((c) => ({
      taskUuid: c.taskUuid,
      checkinAt: c.checkinAt.toISOString(),
      checkoutAt: c.checkoutAt?.toISOString() ?? null,
    })),
  };
}

// ===== Service Methods =====

// Create Session
export async function createSession(params: SessionCreateParams): Promise<SessionResponse> {
  const session = await prisma.agentSession.create({
    data: {
      companyUuid: params.companyUuid,
      agentUuid: params.agentUuid,
      name: params.name,
      description: params.description ?? null,
      status: "active",
    },
  });

  return formatSessionResponse(session);
}

// Get Session details (including active checkins). Audit-trail read — does
// NOT apply the staleness filter; refreshes lastActiveAt as a side effect on
// non-closed rows so the returned timestamp reflects the touch.
export async function getSession(
  companyUuid: string,
  sessionUuid: string
): Promise<SessionResponse | null> {
  const session = await prisma.agentSession.findFirst({
    where: { uuid: sessionUuid, companyUuid },
    include: {
      taskCheckins: {
        where: { checkoutAt: null },
        select: { taskUuid: true, checkinAt: true, checkoutAt: true },
      },
    },
  });

  if (!session) return null;

  // Reflect the heartbeat on the returned snapshot. Closed sessions skip the
  // touch (preserves their final timestamp); active sessions take the new one.
  if (session.status !== "closed") {
    const fresh = new Date();
    await prisma.agentSession.update({
      where: { uuid: sessionUuid },
      data: { lastActiveAt: fresh },
    });
    session.lastActiveAt = fresh;
  }

  return formatSessionResponse(session);
}

// List Agent's Sessions — unfiltered MCP/audit-trail entry point. Returns
// every session for the agent regardless of staleness; status filter is
// optional and exact-match.
export async function listAgentSessions(
  companyUuid: string,
  agentUuid: string,
  status?: string
): Promise<SessionResponse[]> {
  const sessions = await prisma.agentSession.findMany({
    where: {
      companyUuid,
      agentUuid,
      ...(status && { status }),
    },
    include: {
      taskCheckins: {
        where: { checkoutAt: null },
        select: { taskUuid: true, checkinAt: true, checkoutAt: true },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  return sessions.map(formatSessionResponse);
}

// List Agent's Sessions for the Settings UI — filtered to active+fresh only.
export async function listAgentSessionsForUI(
  companyUuid: string,
  agentUuid: string
): Promise<SessionResponse[]> {
  const sessions = await prisma.agentSession.findMany({
    where: {
      companyUuid,
      agentUuid,
      ...freshSessionWhereClause(),
    },
    include: {
      taskCheckins: {
        where: { checkoutAt: null },
        select: { taskUuid: true, checkinAt: true, checkoutAt: true },
      },
    },
    orderBy: { createdAt: "desc" },
  });

  return sessions.map(formatSessionResponse);
}

// Close Session (status->closed, batch checkout all checkins).
// Refreshes lastActiveAt before flipping to closed so the row's last
// activity timestamp reflects the close itself.
export async function closeSession(
  companyUuid: string,
  sessionUuid: string
): Promise<SessionResponse> {
  const session = await prisma.agentSession.findFirst({
    where: { uuid: sessionUuid, companyUuid },
  });

  if (!session) throw new Error("Session not found");

  // Query active checkins before batch checkout for event emission
  const activeCheckins = await prisma.sessionTaskCheckin.findMany({
    where: { sessionUuid, checkoutAt: null },
    select: { task: { select: { uuid: true, projectUuid: true } } },
  });

  // Batch checkout all active checkins
  await prisma.sessionTaskCheckin.updateMany({
    where: { sessionUuid, checkoutAt: null },
    data: { checkoutAt: new Date() },
  });

  // Refresh lastActiveAt while the row is still open, then flip to closed.
  // touchLastActiveAt itself will no-op once status='closed', so this
  // ordering is the correct way to capture the close timestamp.
  await touchLastActiveAt(sessionUuid);

  const updated = await prisma.agentSession.update({
    where: { uuid: sessionUuid },
    data: { status: "closed" },
    include: {
      taskCheckins: {
        select: { taskUuid: true, checkinAt: true, checkoutAt: true },
      },
    },
  });

  for (const checkin of activeCheckins) {
    eventBus.emitChange({ companyUuid: session.companyUuid, projectUuid: checkin.task.projectUuid, entityType: "task", entityUuid: checkin.task.uuid, action: "updated" });
  }

  return formatSessionResponse(updated);
}

// Session checkin to Task
export async function sessionCheckinToTask(
  companyUuid: string,
  sessionUuid: string,
  taskUuid: string
): Promise<SessionCheckinInfo> {
  // Verify session exists and belongs to this company
  const session = await prisma.agentSession.findFirst({
    where: { uuid: sessionUuid, companyUuid, status: "active" },
  });
  if (!session) throw new Error("Session not found or not active");

  // Verify task exists and belongs to this company
  const task = await prisma.task.findFirst({
    where: { uuid: taskUuid, companyUuid },
  });
  if (!task) throw new Error("Task not found");

  // Auto-claim: if task has no assignee, claim it for the session's agent
  if (!task.assigneeUuid) {
    try {
      await claimTask({
        taskUuid,
        companyUuid,
        assigneeType: "agent",
        assigneeUuid: session.agentUuid,
      });
    } catch {
      // Claim may fail if task was concurrently claimed — safe to ignore
    }
  }

  // Upsert: reactivate if already exists
  const checkin = await prisma.sessionTaskCheckin.upsert({
    where: {
      sessionUuid_taskUuid: { sessionUuid, taskUuid },
    },
    create: { sessionUuid, taskUuid },
    update: { checkoutAt: null, checkinAt: new Date() },
  });

  await touchLastActiveAt(sessionUuid);

  eventBus.emitChange({ companyUuid, projectUuid: task.projectUuid, entityType: "task", entityUuid: taskUuid, action: "updated" });

  return {
    taskUuid: checkin.taskUuid,
    checkinAt: checkin.checkinAt.toISOString(),
    checkoutAt: checkin.checkoutAt?.toISOString() ?? null,
  };
}

// Session checkout from Task
export async function sessionCheckoutFromTask(
  companyUuid: string,
  sessionUuid: string,
  taskUuid: string
): Promise<void> {
  // Verify session belongs to this company
  const session = await prisma.agentSession.findFirst({
    where: { uuid: sessionUuid, companyUuid },
  });
  if (!session) throw new Error("Session not found");

  const task = await prisma.task.findFirst({
    where: { uuid: taskUuid, companyUuid },
    select: { projectUuid: true },
  });

  await prisma.sessionTaskCheckin.updateMany({
    where: { sessionUuid, taskUuid, checkoutAt: null },
    data: { checkoutAt: new Date() },
  });

  await touchLastActiveAt(sessionUuid);

  if (task) {
    eventBus.emitChange({ companyUuid, projectUuid: task.projectUuid, entityType: "task", entityUuid: taskUuid, action: "updated" });
  }
}

// Get all active+fresh Sessions for a Task
export async function getSessionsForTask(
  companyUuid: string,
  taskUuid: string
): Promise<TaskSessionInfo[]> {
  const checkins = await prisma.sessionTaskCheckin.findMany({
    where: {
      taskUuid,
      checkoutAt: null,
      session: { companyUuid, ...freshSessionWhereClause() },
    },
    include: {
      session: {
        select: {
          uuid: true,
          name: true,
          agentUuid: true,
          agent: { select: { name: true } },
        },
      },
    },
  });

  return checkins.map((c) => ({
    sessionUuid: c.session.uuid,
    sessionName: c.session.name,
    agentUuid: c.session.agentUuid,
    agentName: c.session.agent.name,
    checkinAt: c.checkinAt.toISOString(),
  }));
}

// Heartbeat — refresh lastActiveAt unconditionally on the resolved session.
// No status mutation; staleness is computed at read time, not stored.
export async function heartbeatSession(
  companyUuid: string,
  sessionUuid: string
): Promise<void> {
  const session = await prisma.agentSession.findFirst({
    where: { uuid: sessionUuid, companyUuid },
    select: { uuid: true },
  });
  if (!session) throw new Error("Session not found");

  await touchLastActiveAt(sessionUuid);
}

// Reopen a closed Session (closed -> active). Atomic single-statement: flips
// status and refreshes lastActiveAt in one update so a concurrent closeSession
// can't observe a half-applied "active row with stale timestamp" or, worse,
// flip us back to closed between our two writes.
export async function reopenSession(
  companyUuid: string,
  sessionUuid: string
): Promise<SessionResponse> {
  const session = await prisma.agentSession.findFirst({
    where: { uuid: sessionUuid, companyUuid },
  });

  if (!session) throw new Error("Session not found");
  if (session.status !== "closed") throw new Error("Only closed sessions can be reopened");

  const updated = await prisma.agentSession.update({
    where: { uuid: sessionUuid },
    data: { status: "active", lastActiveAt: new Date() },
    include: {
      taskCheckins: {
        where: { checkoutAt: null },
        select: { taskUuid: true, checkinAt: true, checkoutAt: true },
      },
    },
  });

  return formatSessionResponse(updated);
}

// Batch get active+fresh worker counts for multiple tasks (1 groupBy query
// instead of N individual queries).
export async function batchGetWorkerCountsForTasks(
  companyUuid: string,
  taskUuids: string[]
): Promise<Record<string, number>> {
  if (taskUuids.length === 0) return {};

  const checkins = await prisma.sessionTaskCheckin.groupBy({
    by: ["taskUuid"],
    where: {
      taskUuid: { in: taskUuids },
      checkoutAt: null,
      session: { companyUuid, ...freshSessionWhereClause() },
    },
    _count: { taskUuid: true },
  });

  const result: Record<string, number> = {};
  for (const checkin of checkins) {
    result[checkin.taskUuid] = checkin._count.taskUuid;
  }
  return result;
}

// Get Session name (for Activity display)
export async function getSessionName(sessionUuid: string): Promise<string | null> {
  const session = await prisma.agentSession.findUnique({
    where: { uuid: sessionUuid },
    select: { name: true },
  });
  return session?.name ?? null;
}

/**
 * Get all active workers for a project's PixelCanvas.
 * Returns up to 5 unique workers (for PixelCanvas slots).
 *
 * Sources (merged, session-based workers listed first):
 * 1. Session-based: each unique active+fresh session with active checkins = one sub-agent worker
 * 2. Sessionless: agents with in_progress tasks that have NO active session checkin
 *    on those tasks = the main agent working directly (e.g. OpenClaw single-agent mode).
 *    Even if the same agent has sessions on other tasks, the main agent still counts
 *    as a separate worker when it works on tasks without delegating to a session.
 */
export async function getActiveSessionsForProject(
  companyUuid: string,
  projectUuid: string
): Promise<TaskSessionInfo[]> {
  // 1. Session-based workers: each unique active+fresh session = one sub-agent worker
  const checkins = await prisma.sessionTaskCheckin.findMany({
    where: {
      checkoutAt: null,
      task: { projectUuid },
      session: { companyUuid, ...freshSessionWhereClause() },
    },
    include: {
      session: {
        select: {
          uuid: true,
          name: true,
          agentUuid: true,
          agent: { select: { name: true } },
        },
      },
    },
    orderBy: { checkinAt: "asc" },
  });

  // Deduplicate by session UUID, keep first checkin per session
  const seenSessions = new Set<string>();
  const results: TaskSessionInfo[] = [];
  // Collect task UUIDs that have active session checkins
  const tasksWithCheckins = new Set<string>();
  for (const c of checkins) {
    tasksWithCheckins.add(c.taskUuid);
    if (seenSessions.has(c.session.uuid)) continue;
    seenSessions.add(c.session.uuid);
    results.push({
      sessionUuid: c.session.uuid,
      sessionName: c.session.name,
      agentUuid: c.session.agentUuid,
      agentName: c.session.agent.name,
      checkinAt: c.checkinAt.toISOString(),
    });
    if (results.length >= 7) return results;
  }

  // 2. Sessionless workers: agents doing in_progress tasks without a session
  //    (the main agent working directly, not via a sub-agent session)
  const sessionlessTasks = await prisma.task.findMany({
    where: {
      projectUuid,
      companyUuid,
      status: "in_progress",
      assigneeType: "agent",
      assigneeUuid: { not: null },
      // Exclude tasks that already have active session checkins
      ...(tasksWithCheckins.size > 0
        ? { uuid: { notIn: [...tasksWithCheckins] } }
        : {}),
    },
    select: {
      uuid: true,
      assigneeUuid: true,
      updatedAt: true,
    },
    orderBy: { updatedAt: "asc" },
  });

  // Deduplicate by agent UUID — one entry per "main agent" working directly
  const seenDirectAgents = new Set<string>();
  const uniqueAgentTasks: typeof sessionlessTasks = [];
  for (const task of sessionlessTasks) {
    if (!task.assigneeUuid || seenDirectAgents.has(task.assigneeUuid)) continue;
    seenDirectAgents.add(task.assigneeUuid);
    uniqueAgentTasks.push(task);
    if (results.length + uniqueAgentTasks.length >= 7) break;
  }

  if (uniqueAgentTasks.length > 0) {
    // Batch-fetch agent names
    const agents = await prisma.agent.findMany({
      where: { uuid: { in: uniqueAgentTasks.map((t) => t.assigneeUuid!) } },
      select: { uuid: true, name: true },
    });
    const agentMap = new Map(agents.map((a) => [a.uuid, a.name]));

    for (const task of uniqueAgentTasks) {
      const agentName = agentMap.get(task.assigneeUuid!);
      if (!agentName) continue;
      results.push({
        sessionUuid: "",
        sessionName: agentName,
        agentUuid: task.assigneeUuid!,
        agentName,
        checkinAt: task.updatedAt.toISOString(),
      });
    }
  }

  return results;
}
