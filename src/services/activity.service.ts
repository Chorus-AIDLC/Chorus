// src/services/activity.service.ts
// Activity Service Layer (ARCHITECTURE.md §3.1 Service Layer)
// UUID-Based Architecture: All operations use UUIDs

import { prisma } from "@/lib/prisma";
import { eventBus } from "@/lib/event-bus";
import { getActorName } from "@/lib/uuid-resolver";
import { type AnyAuth, canAccessProject } from "@/lib/authz/project-access";

export type TargetType = "idea" | "task" | "proposal" | "document";

export interface ActivityListParams {
  companyUuid: string;
  projectUuid: string;
  skip: number;
  take: number;
  targetType?: TargetType;
  targetUuid?: string;
  /** Auth context used to restrict results to projects the actor can access. */
  auth: AnyAuth;
}

export interface ActivityCreateParams {
  companyUuid: string;
  projectUuid: string;
  targetType: TargetType;
  targetUuid: string;
  actorType: string;
  actorUuid: string;
  action: string;
  value?: unknown;
  sessionUuid?: string;
  sessionName?: string;
}

// Activity response format with actor names
export interface ActivityResponse {
  uuid: string;
  targetType: string;
  targetUuid: string;
  action: string;
  actorType: string;
  actorName: string;
  value: unknown;
  sessionUuid?: string | null;
  sessionName?: string | null;
  createdAt: string;
}

// List activities query
export async function listActivities({
  companyUuid,
  projectUuid,
  skip,
  take,
  targetType,
  targetUuid,
  auth,
}: ActivityListParams) {
  // Visibility gate: a non-member of this project sees no activity.
  if (!(await canAccessProject(auth, projectUuid))) {
    return { activities: [], total: 0 };
  }

  const where = {
    projectUuid,
    companyUuid,
    ...(targetType && { targetType }),
    ...(targetUuid && { targetUuid }),
  };

  const [activities, total] = await Promise.all([
    prisma.activity.findMany({
      where,
      skip,
      take,
      orderBy: { createdAt: "desc" },
      select: {
        uuid: true,
        targetType: true,
        targetUuid: true,
        actorType: true,
        actorUuid: true,
        action: true,
        value: true,
        sessionUuid: true,
        sessionName: true,
        createdAt: true,
      },
    }),
    prisma.activity.count({ where }),
  ]);

  return { activities, total };
}

// List activities query (with actor name resolution)
export async function listActivitiesWithActorNames(
  params: ActivityListParams
): Promise<{ activities: ActivityResponse[]; total: number }> {
  const { activities: rawActivities, total } = await listActivities(params);

  // Batch resolve actor names
  const activities: ActivityResponse[] = await Promise.all(
    rawActivities.map(async (activity) => {
      const actorName = await getActorName(activity.actorType, activity.actorUuid);
      return {
        uuid: activity.uuid,
        targetType: activity.targetType,
        targetUuid: activity.targetUuid,
        action: activity.action,
        actorType: activity.actorType,
        actorName: actorName || "Unknown",
        value: activity.value,
        sessionUuid: activity.sessionUuid,
        sessionName: activity.sessionName,
        createdAt: activity.createdAt.toISOString(),
      };
    })
  );

  return { activities, total };
}

// Create Activity
export async function createActivity({
  companyUuid,
  projectUuid,
  targetType,
  targetUuid,
  actorType,
  actorUuid,
  action,
  value,
  sessionUuid,
  sessionName,
}: ActivityCreateParams) {
  const activity = await prisma.activity.create({
    data: {
      companyUuid,
      projectUuid,
      targetType,
      targetUuid,
      actorType,
      actorUuid,
      action,
      value: value || undefined,
      sessionUuid: sessionUuid || undefined,
      sessionName: sessionName || undefined,
    },
  });

  eventBus.emit("activity", {
    companyUuid,
    projectUuid,
    targetType,
    targetUuid,
    actorType,
    actorUuid,
    action,
    value,
    sessionUuid,
    sessionName,
    uuid: activity.uuid,
  });

  return activity;
}
