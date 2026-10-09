import { z } from "zod";
import { prisma } from "@/lib/prisma";
import logger from "@/lib/logger";
import { createWakeContext } from "@/services/daemon-wake-context";
import { createTurnAndResolveTarget, triggerForAction, type WakeNotificationContext, type WakeTurnResult } from "@/services/notification-turn";

const recoverySchema = z.object({
  version: z.literal(1),
  deliveryOwner: z.enum(["outbox", "protocol1", "legacy"]).optional(),
  pinnedHost: z.string().nullable().optional(),
  pinnedCwd: z.string().nullable().optional(),
  temporaryHost: z.string().nullable().optional(),
  temporaryRuntimeCwd: z.string().nullable().optional(),
  resolvedCwdSource: z.string().nullable().optional(),
  resolvedCwdHost: z.string().nullable().optional(),
  resolvedRuntimeCwd: z.string().nullable().optional(),
  resolvedCwdAvailability: z.enum(["ready", "offline", "invalid"]).nullable().optional(),
});

export function notificationWakeRecoveryData(context: WakeNotificationContext) {
  const trigger = triggerForAction(context.action);
  if (context.recipientType !== "agent" || !trigger ||
      trigger === "human_instruction" || trigger === "idea_creation_requested" || trigger === "research_requested") return {};
  return { wakeRecovery: recoverySchema.parse({ ...context, version: 1, deliveryOwner: "outbox" }), wakeRecoveryPending: true };
}

export async function settleNotificationWakeRecovery(notificationUuid: string, result: WakeTurnResult, source: "initial" | "recovery" = "initial") {
  if (source === "initial") {
    const notification = await prisma.notification.findUnique({ where: { uuid: notificationUuid } });
    const recovery = recoverySchema.safeParse(notification?.wakeRecovery);
    if (!recovery.success || recovery.data.deliveryOwner !== "outbox") return false;
    const settled = await prisma.notification.updateMany({
      where: { uuid: notificationUuid, wakeRecoveryPending: true, wakeRecovery: { equals: notification!.wakeRecovery! } },
      data: {
        wakeRecovery: { ...recovery.data, deliveryOwner: result.turn ? "legacy" : "protocol1" },
        wakeRecoveryPending: !result.turn && result.recoveryDeferred === true,
      },
    });
    return settled.count === 1 && !!result.turn;
  }
  await prisma.notification.updateMany({
    where: { uuid: notificationUuid, wakeRecoveryPending: true },
    data: { wakeRecoveryPending: !result.turn && result.recoveryDeferred === true },
  });
  return false;
}

export async function recoverDeferredNotificationWakes(params: {
  companyUuid: string; agentUuid: string; connectionUuid: string;
}) {
  const notifications = await prisma.notification.findMany({
    where: { companyUuid: params.companyUuid, recipientType: "agent", recipientUuid: params.agentUuid, wakeRecoveryPending: true },
    orderBy: [{ updatedAt: "asc" }, { id: "asc" }],
    take: 100,
  });
  for (const notification of notifications) {
    const recovery = recoverySchema.safeParse(notification.wakeRecovery);
    if (!recovery.success) {
      logger.warn({ notificationUuid: notification.uuid }, "Unsupported deferred notification wake context");
      await prisma.notification.updateMany({ where: { uuid: notification.uuid, wakeRecoveryPending: true }, data: { wakeRecoveryPending: false } });
      continue;
    }
    if (recovery.data.deliveryOwner === "legacy") continue;
    const claimed = await prisma.notification.updateMany({
      where: { uuid: notification.uuid, wakeRecoveryPending: true, wakeRecovery: { equals: notification.wakeRecovery! } },
      data: { wakeRecovery: { ...recovery.data, deliveryOwner: "protocol1" } },
    });
    if (claimed.count !== 1) continue;
    const existing = await prisma.daemonSessionTurn.findUnique({ where: { wakeNotificationUuid: notification.uuid } });
    if (existing) {
      await prisma.notification.updateMany({ where: { uuid: notification.uuid, wakeRecoveryPending: true }, data: { wakeRecoveryPending: false } });
      continue;
    }
    const result = await createTurnAndResolveTarget({
      ...notification,
      ...recovery.data,
      wakeContext: createWakeContext(notification),
      recoveryConnectionUuid: params.connectionUuid,
    });
    await settleNotificationWakeRecovery(notification.uuid, result, "recovery");
  }
}
