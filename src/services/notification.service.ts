// src/services/notification.service.ts
// Notification Service Layer — creation, querying, marking as read, preference management
// All operations scoped by companyUuid for multi-tenancy

import { prisma } from "@/lib/prisma";
import { eventBus } from "@/lib/event-bus";

// ===== Type Definitions =====

export interface NotificationCreateParams {
  companyUuid: string;
  projectUuid: string;
  recipientType: string;
  recipientUuid: string;
  entityType: string;
  entityUuid: string;
  entityTitle: string;
  projectName: string;
  action: string;
  message: string;
  actorType: string;
  actorUuid: string;
  actorName: string;
}

export interface NotificationListParams {
  companyUuid: string;
  recipientType: string;
  recipientUuid: string;
  projectUuid?: string;
  readFilter?: "all" | "unread" | "read";
  archived?: boolean;
  skip?: number;
  take?: number;
}

export interface NotificationResponse {
  uuid: string;
  projectUuid: string;
  projectName: string;
  recipientType: string;
  recipientUuid: string;
  entityType: string;
  entityUuid: string;
  entityTitle: string;
  action: string;
  message: string;
  actorType: string;
  actorUuid: string;
  actorName: string;
  readAt: string | null;
  archivedAt: string | null;
  createdAt: string;
}

export interface NotificationPreferenceFields {
  taskAssigned?: boolean;
  taskStatusChanged?: boolean;
  taskVerified?: boolean;
  taskReopened?: boolean;
  proposalSubmitted?: boolean;
  proposalApproved?: boolean;
  proposalRejected?: boolean;
  ideaClaimed?: boolean;
  commentAdded?: boolean;
  elaborationRequested?: boolean;
  elaborationAnswered?: boolean;
  mentioned?: boolean;
}

export interface NotificationPreferenceResponse {
  uuid: string;
  ownerType: string;
  ownerUuid: string;
  taskAssigned: boolean;
  taskStatusChanged: boolean;
  taskVerified: boolean;
  taskReopened: boolean;
  proposalSubmitted: boolean;
  proposalApproved: boolean;
  proposalRejected: boolean;
  ideaClaimed: boolean;
  commentAdded: boolean;
  elaborationRequested: boolean;
  elaborationAnswered: boolean;
  mentioned: boolean;
}

// ===== Internal Helper Functions =====

function formatNotification(n: {
  uuid: string;
  projectUuid: string;
  projectName: string;
  recipientType: string;
  recipientUuid: string;
  entityType: string;
  entityUuid: string;
  entityTitle: string;
  action: string;
  message: string;
  actorType: string;
  actorUuid: string;
  actorName: string;
  readAt: Date | null;
  archivedAt: Date | null;
  createdAt: Date;
}): NotificationResponse {
  return {
    uuid: n.uuid,
    projectUuid: n.projectUuid,
    projectName: n.projectName,
    recipientType: n.recipientType,
    recipientUuid: n.recipientUuid,
    entityType: n.entityType,
    entityUuid: n.entityUuid,
    entityTitle: n.entityTitle,
    action: n.action,
    message: n.message,
    actorType: n.actorType,
    actorUuid: n.actorUuid,
    actorName: n.actorName,
    readAt: n.readAt?.toISOString() ?? null,
    archivedAt: n.archivedAt?.toISOString() ?? null,
    createdAt: n.createdAt.toISOString(),
  };
}

// ===== Service Methods =====

/**
 * Create a single notification and emit SSE event
 */
export async function create(
  params: NotificationCreateParams
): Promise<NotificationResponse> {
  const notification = await prisma.notification.create({
    data: {
      companyUuid: params.companyUuid,
      projectUuid: params.projectUuid,
      recipientType: params.recipientType,
      recipientUuid: params.recipientUuid,
      entityType: params.entityType,
      entityUuid: params.entityUuid,
      entityTitle: params.entityTitle,
      projectName: params.projectName,
      action: params.action,
      message: params.message,
      actorType: params.actorType,
      actorUuid: params.actorUuid,
      actorName: params.actorName,
    },
  });

  // Get updated unread count for the recipient
  const unreadCount = await prisma.notification.count({
    where: {
      companyUuid: params.companyUuid,
      recipientType: params.recipientType,
      recipientUuid: params.recipientUuid,
      readAt: null,
      archivedAt: null,
    },
  });

  // Emit SSE event for real-time notification delivery
  eventBus.emit(`notification:${params.recipientType}:${params.recipientUuid}`, {
    type: "new_notification",
    notificationUuid: notification.uuid,
    unreadCount,
  });

  return formatNotification(notification);
}

/**
 * Bulk create notifications (one per recipient) and emit per-recipient events
 */
export async function createBatch(
  notifications: NotificationCreateParams[]
): Promise<NotificationResponse[]> {
  // Create all notifications
  const created = await Promise.all(
    notifications.map((params) =>
      prisma.notification.create({
        data: {
          companyUuid: params.companyUuid,
          projectUuid: params.projectUuid,
          recipientType: params.recipientType,
          recipientUuid: params.recipientUuid,
          entityType: params.entityType,
          entityUuid: params.entityUuid,
          entityTitle: params.entityTitle,
          projectName: params.projectName,
          action: params.action,
          message: params.message,
          actorType: params.actorType,
          actorUuid: params.actorUuid,
          actorName: params.actorName,
        },
      })
    )
  );

  // Deduplicate recipients and emit one event per recipient
  const recipientKeys = new Set<string>();
  for (const params of notifications) {
    recipientKeys.add(`${params.recipientType}:${params.recipientUuid}:${params.companyUuid}`);
  }

  for (const key of recipientKeys) {
    const [recipientType, recipientUuid, companyUuid] = key.split(":");

    const unreadCount = await prisma.notification.count({
      where: {
        companyUuid,
        recipientType,
        recipientUuid,
        readAt: null,
        archivedAt: null,
      },
    });

    eventBus.emit(`notification:${recipientType}:${recipientUuid}`, {
      type: "new_notification",
      notificationUuid: created.find(
        (n) => n.recipientType === recipientType && n.recipientUuid === recipientUuid
      )?.uuid,
      unreadCount,
    });
  }

  return created.map(formatNotification);
}

/**
 * List notifications for a recipient with pagination and filters
 */
export async function list(
  params: NotificationListParams
): Promise<{ notifications: NotificationResponse[]; total: number; unreadCount: number }> {
  const { companyUuid, recipientType, recipientUuid, projectUuid, readFilter, archived } = params;
  const skip = params.skip ?? 0;
  const take = params.take ?? 20;

  const where = {
    companyUuid,
    recipientType,
    recipientUuid,
    ...(projectUuid && { projectUuid }),
    ...(readFilter === "unread" && { readAt: null }),
    ...(readFilter === "read" && { readAt: { not: null } }),
    ...(archived === false && { archivedAt: null }),
    ...(archived === true && { archivedAt: { not: null } }),
  };

  const [rawNotifications, total, unreadCount] = await Promise.all([
    prisma.notification.findMany({
      where,
      skip,
      take,
      orderBy: { createdAt: "desc" },
    }),
    prisma.notification.count({ where }),
    prisma.notification.count({
      where: {
        companyUuid,
        recipientType,
        recipientUuid,
        readAt: null,
        archivedAt: null,
      },
    }),
  ]);

  return {
    notifications: rawNotifications.map(formatNotification),
    total,
    unreadCount,
  };
}

/**
 * Get unread notification count for a recipient
 */
export async function getUnreadCount(
  companyUuid: string,
  recipientType: string,
  recipientUuid: string
): Promise<number> {
  return prisma.notification.count({
    where: {
      companyUuid,
      recipientType,
      recipientUuid,
      readAt: null,
      archivedAt: null,
    },
  });
}

/**
 * Mark a single notification as read
 */
export async function markRead(
  uuid: string,
  companyUuid: string,
  recipientType: string,
  recipientUuid: string
): Promise<NotificationResponse> {
  const notification = await prisma.notification.updateMany({
    where: {
      uuid,
      companyUuid,
      recipientType,
      recipientUuid,
      readAt: null,
    },
    data: { readAt: new Date() },
  });

  // Fetch the updated notification to return
  const updated = await prisma.notification.findFirst({
    where: { uuid, companyUuid },
  });

  if (!updated) throw new Error("Notification not found");

  // Emit count update
  const unreadCount = await getUnreadCount(companyUuid, recipientType, recipientUuid);
  eventBus.emit(`notification:${recipientType}:${recipientUuid}`, {
    type: "count_update",
    unreadCount,
  });

  return formatNotification(updated);
}

/**
 * Mark all notifications as read for a recipient, optionally scoped to a project
 */
export async function markAllRead(
  companyUuid: string,
  recipientType: string,
  recipientUuid: string,
  projectUuid?: string
): Promise<{ count: number }> {
  const result = await prisma.notification.updateMany({
    where: {
      companyUuid,
      recipientType,
      recipientUuid,
      readAt: null,
      ...(projectUuid && { projectUuid }),
    },
    data: { readAt: new Date() },
  });

  // Emit count update
  const unreadCount = await getUnreadCount(companyUuid, recipientType, recipientUuid);
  eventBus.emit(`notification:${recipientType}:${recipientUuid}`, {
    type: "count_update",
    unreadCount,
  });

  return { count: result.count };
}

/**
 * Archive a notification (soft-delete)
 */
export async function archive(
  uuid: string,
  companyUuid: string,
  recipientType: string,
  recipientUuid: string
): Promise<NotificationResponse> {
  await prisma.notification.updateMany({
    where: {
      uuid,
      companyUuid,
      recipientType,
      recipientUuid,
      archivedAt: null,
    },
    data: { archivedAt: new Date() },
  });

  const updated = await prisma.notification.findFirst({
    where: { uuid, companyUuid },
  });

  if (!updated) throw new Error("Notification not found");

  // Emit count update (archived notifications don't count as unread)
  const unreadCount = await getUnreadCount(companyUuid, recipientType, recipientUuid);
  eventBus.emit(`notification:${recipientType}:${recipientUuid}`, {
    type: "count_update",
    unreadCount,
  });

  return formatNotification(updated);
}

/**
 * Emit an agent_checkin notification to the agent's owner on first checkin only.
 * Returns true if notification was created, false if already existed.
 */
export async function emitAgentCheckinIfFirst(params: {
  companyUuid: string;
  agentUuid: string;
  agentName: string;
  ownerUuid: string;
}): Promise<boolean> {
  const existing = await prisma.notification.findFirst({
    where: {
      companyUuid: params.companyUuid,
      action: "agent_checkin",
      actorType: "agent",
      actorUuid: params.agentUuid,
    },
    select: { uuid: true },
  });

  if (existing) return false;

  await create({
    companyUuid: params.companyUuid,
    projectUuid: "system",
    recipientType: "user",
    recipientUuid: params.ownerUuid,
    entityType: "agent",
    entityUuid: params.agentUuid,
    entityTitle: params.agentName,
    projectName: "",
    action: "agent_checkin",
    message: `Agent "${params.agentName}" connected successfully`,
    actorType: "agent",
    actorUuid: params.agentUuid,
    actorName: params.agentName,
  });

  return true;
}

/**
 * Get notification preferences for an owner (user or agent), creating defaults if not found
 */
export async function getPreferences(
  companyUuid: string,
  ownerType: string,
  ownerUuid: string
): Promise<NotificationPreferenceResponse> {
  let pref = await prisma.notificationPreference.findUnique({
    where: { ownerType_ownerUuid: { ownerType, ownerUuid } },
  });

  // Create default preferences if not found
  if (!pref) {
    pref = await prisma.notificationPreference.create({
      data: {
        companyUuid,
        ownerType,
        ownerUuid,
      },
    });
  }

  return {
    uuid: pref.uuid,
    ownerType: pref.ownerType,
    ownerUuid: pref.ownerUuid,
    taskAssigned: pref.taskAssigned,
    taskStatusChanged: pref.taskStatusChanged,
    taskVerified: pref.taskVerified,
    taskReopened: pref.taskReopened,
    proposalSubmitted: pref.proposalSubmitted,
    proposalApproved: pref.proposalApproved,
    proposalRejected: pref.proposalRejected,
    ideaClaimed: pref.ideaClaimed,
    commentAdded: pref.commentAdded,
    elaborationRequested: pref.elaborationRequested,
    elaborationAnswered: pref.elaborationAnswered,
    mentioned: pref.mentioned,
  };
}

/**
 * Update (upsert) notification preferences for an owner
 */
export async function updatePreferences(
  companyUuid: string,
  ownerType: string,
  ownerUuid: string,
  prefs: NotificationPreferenceFields
): Promise<NotificationPreferenceResponse> {
  const pref = await prisma.notificationPreference.upsert({
    where: { ownerType_ownerUuid: { ownerType, ownerUuid } },
    create: {
      companyUuid,
      ownerType,
      ownerUuid,
      ...prefs,
    },
    update: prefs,
  });

  return {
    uuid: pref.uuid,
    ownerType: pref.ownerType,
    ownerUuid: pref.ownerUuid,
    taskAssigned: pref.taskAssigned,
    taskStatusChanged: pref.taskStatusChanged,
    taskVerified: pref.taskVerified,
    taskReopened: pref.taskReopened,
    proposalSubmitted: pref.proposalSubmitted,
    proposalApproved: pref.proposalApproved,
    proposalRejected: pref.proposalRejected,
    ideaClaimed: pref.ideaClaimed,
    commentAdded: pref.commentAdded,
    elaborationRequested: pref.elaborationRequested,
    elaborationAnswered: pref.elaborationAnswered,
    mentioned: pref.mentioned,
  };
}
