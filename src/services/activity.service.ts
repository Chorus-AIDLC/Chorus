// src/services/activity.service.ts
// Activity Service Layer (ARCHITECTURE.md §3.1 Service Layer)
// UUID-Based Architecture: All operations use UUIDs

import { prisma } from "@/lib/prisma";
import { eventBus } from "@/lib/event-bus";
import { batchResolveActorIdentities } from "@/lib/uuid-resolver";
import { lockResearchProject } from "@/services/research-eligibility.service";
import { publicActivityValue } from "@/lib/idea-team-activity";

export type TargetType = "idea" | "task" | "proposal" | "document" | "project";

export interface ActivityListParams {
  companyUuid: string;
  projectUuid: string;
  skip: number;
  take: number;
  targetType?: TargetType;
  targetUuid?: string;
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
  actorUuid: string;
  actorAvatarSeed?: string | null;
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
}: ActivityListParams) {
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

  return { activities: activities.map((activity) => ({ ...activity, value: publicActivityValue(activity.value) })), total };
}

// List activities query (with actor name resolution)
export async function listActivitiesWithActorNames(
  params: ActivityListParams
): Promise<{ activities: ActivityResponse[]; total: number }> {
  const { activities: rawActivities, total } = await listActivities(params);
  const identities = await batchResolveActorIdentities(params.companyUuid, rawActivities.map(activity => ({ type: activity.actorType, uuid: activity.actorUuid })));

  // Batch resolve actor names
  const activities: ActivityResponse[] = await Promise.all(
    rawActivities.map(async (activity) => {
      const actor = identities.get(`${activity.actorType}:${activity.actorUuid}`);
      return {
        uuid: activity.uuid,
        targetType: activity.targetType,
        targetUuid: activity.targetUuid,
        action: activity.action,
        actorType: activity.actorType,
        actorName: actor?.name || "Unknown",
        actorUuid: activity.actorUuid,
        ...(activity.actorType === "user" ? { actorAvatarSeed: actor?.avatarSeed ?? null } : {}),
        value: activity.value,
        sessionUuid: activity.sessionUuid,
        sessionName: activity.sessionName,
        createdAt: activity.createdAt.toISOString(),
      };
    })
  );

  return { activities, total };
}

type ActivityDb = Omit<typeof prisma, "$connect" | "$disconnect" | "$on" | "$transaction" | "$extends">;

function buildActivityWrite({
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
  return {
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
  };
}

function publishActivity(params: ActivityCreateParams, uuid: string) {
  eventBus.emit("activity", {
    companyUuid: params.companyUuid,
    projectUuid: params.projectUuid,
    targetType: params.targetType,
    targetUuid: params.targetUuid,
    actorType: params.actorType,
    actorUuid: params.actorUuid,
    action: params.action,
    value: params.value,
    sessionUuid: params.sessionUuid,
    sessionName: params.sessionName,
    uuid,
  });
}

// Create Activity
export async function createActivity(params: ActivityCreateParams) {
  params = await withTeamFences(prisma, params);
  const write = buildActivityWrite(params);
  // Publish after commit: downstream notification listeners use global Prisma.
  const activity = params.action === "start_development"
    ? await prisma.$transaction(async (tx) => {
        await lockResearchProject(tx, params.companyUuid, params.projectUuid);
        return tx.activity.create(write);
      })
    : await prisma.activity.create(write);

  publishActivity(params, activity.uuid);

  return activity;
}

// Create an Activity inside the caller's transaction, so the audited change and
// its audit row commit (or roll back) together. Call publish() AFTER the
// transaction commits — listeners read through the global client.
export async function createActivityInTx(tx: ActivityDb, params: ActivityCreateParams) {
  params = await withTeamFences(tx, params);
  const activity = await tx.activity.create(buildActivityWrite(params));
  return { activity, publish: () => publishActivity(params, activity.uuid) };
}

async function withTeamFences(tx: ActivityDb, params: ActivityCreateParams): Promise<ActivityCreateParams> {
  if (!["assigned", "status_changed", "submitted", "verified", "reopened", "approved", "rejected_to_draft", "elaboration_started", "elaboration_answered", "elaboration_verified", "elaboration_resolved", "elaboration_skipped", "report_created", "product_delegated", "start_development", "yolo_requested"].includes(params.action)) return params;
  const { getIdeaTeamActivityFences } = await import("./idea-team.service");
  const fences = await getIdeaTeamActivityFences(params.companyUuid, params.targetType, params.targetUuid, tx);
  if (!fences.length) return params;
  const value = params.value && typeof params.value === "object" && !Array.isArray(params.value) ? params.value : {};
  return { ...params, value: { ...value, ideaTeamFences: fences } };
}
