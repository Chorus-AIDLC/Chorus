// src/services/checkin.service.ts
// Checkin service — builds the agent checkin response with the active-project
// distribution + working-style guidance + notifications.
// The idea-tracker logic lives in idea-tracker.service so that chorus_get_my_assignments
// stays in lockstep with checkin (see Chorus 0.7.2).

import { prisma } from "@/lib/prisma";
import type { AuthContext } from "@/types/auth";
import {
  buildActiveProjectDistribution,
  type ActiveProjectDistributionEntry,
} from "@/services/idea-tracker.service";
import * as notificationService from "@/services/notification.service";
import {
  computeEffectivePermissions,
  groupPermissionsByResource,
} from "@/lib/authz/permissions";
import type { Action, Resource } from "@/lib/authz/types";

// ===== Response shape =====

export interface CheckinAgentInfo {
  uuid: string;
  name: string;
  /**
   * Effective permissions grouped by resource. Resources with no granted
   * actions are omitted. Example: `{ idea: ["read","write","admin"], task: ["read","write"] }`.
   */
  permissions: Partial<Record<Resource, Action[]>>;
  persona: string | null;
  systemPrompt: string | null;
  owner: { uuid: string; name: string | null; email: string | null } | null;
}

/** Re-exported for consumers that type the checkin payload's distribution. */
export type CheckinActiveProject = ActiveProjectDistributionEntry;

export interface CheckinNotification {
  uuid: string;
  action: string;
  entity: string;
  title: string;
  actor: string;
  at: string;
}

export interface CheckinResponse {
  checkinTime: string;
  agent: CheckinAgentInfo;
  /**
   * Per-project distribution of the agent's active ideas: which projects the
   * agent is advancing work in, and how many active ideas each holds — NOT a
   * per-idea list. Keyed by project UUID; empty when the agent has no active
   * work. For the full per-idea list, call chorus_get_my_assignments.
   */
  activeProjects: Record<string, CheckinActiveProject>;
  notifications: {
    unread: number;
    recent: CheckinNotification[];
  };
}

// Working-style guidance (AI-DLC + chorus_search) is intentionally NOT part of
// this MCP response — it lives as a one-line reminder in each harness's
// session-start hook script, keeping the MCP payload pure data.

// ===== Service method =====

/**
 * Build the full checkin response for the current agent auth context.
 *
 * Side effects:
 *   - Updates agent.lastActiveAt
 *   - Emits first-checkin notification to owner (once per agent lifetime)
 *   - Marks the 5 returned recent notifications as read
 */
export async function buildCheckinResponse(auth: AuthContext): Promise<CheckinResponse> {
  // Update lastActiveAt + fetch agent info
  const agent = await prisma.agent.update({
    where: { uuid: auth.actorUuid },
    data: { lastActiveAt: new Date() },
    select: {
      uuid: true,
      name: true,
      roles: true,
      permissions: true,
      persona: true,
      systemPrompt: true,
      ownerUuid: true,
      owner: { select: { uuid: true, name: true, email: true } },
    },
  });

  const effective = computeEffectivePermissions(
    agent.roles,
    agent.permissions,
  );
  const groupedPermissions = groupPermissionsByResource(effective);

  // Build the active-project distribution and fetch the notification summary in
  // parallel. The distribution is derived (uncapped) from the same
  // buildIdeaTracker that chorus_get_my_assignments uses, so counts stay in
  // lockstep — see buildActiveProjectDistribution.
  const [activeProjects, notifications] = await Promise.all([
    buildActiveProjectDistribution(auth),
    buildNotificationSummary(auth),
  ]);

  if (agent.ownerUuid) {
    notificationService.emitAgentCheckin({
      agentUuid: agent.uuid,
      agentName: agent.name,
      ownerUuid: agent.ownerUuid,
    });
  }

  return {
    checkinTime: new Date().toISOString(),
    agent: {
      uuid: agent.uuid,
      name: agent.name,
      permissions: groupedPermissions,
      persona: agent.persona,
      systemPrompt: agent.systemPrompt,
      owner: agent.owner
        ? { uuid: agent.owner.uuid, name: agent.owner.name, email: agent.owner.email }
        : null,
    },
    activeProjects,
    notifications,
  };
}

// ===== Notification summary (fetch 5 unread, mark read) =====

async function buildNotificationSummary(auth: AuthContext): Promise<CheckinResponse["notifications"]> {
  const list = await notificationService.list({
    companyUuid: auth.companyUuid,
    recipientType: auth.type,
    recipientUuid: auth.actorUuid,
    readFilter: "unread",
    take: 5,
  });

  const recent: CheckinNotification[] = list.notifications.map((n) => ({
    uuid: n.uuid,
    action: n.action,
    entity: n.entityType,
    title: n.entityTitle,
    actor: n.actorName,
    at: n.createdAt,
  }));

  // Mark the fetched items as read. Errors (e.g. stale UUID) should not fail checkin.
  let markedCount = 0;
  if (recent.length > 0) {
    const results = await Promise.all(
      recent.map((n) =>
        notificationService
          .markRead(n.uuid, auth.companyUuid, auth.type, auth.actorUuid)
          .then(() => true)
          .catch(() => false),
      ),
    );
    markedCount = results.filter(Boolean).length;
  }

  return {
    unread: Math.max(0, list.unreadCount - markedCount),
    recent,
  };
}
