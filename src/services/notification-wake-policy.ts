import { Prisma } from "@/generated/prisma/client";

export function legacyNotificationDeliveryWhere(): Prisma.NotificationWhereInput {
  return {
    wakeRecoveryPending: false,
    OR: [
      { wakeRecovery: { equals: Prisma.DbNull } },
      { wakeRecovery: { path: ["deliveryOwner"], equals: "legacy" } },
    ],
  };
}

export function legacyWakeTurnWhere(): Prisma.DaemonSessionTurnWhereInput {
  return { OR: [
    { wakeNotificationUuid: null },
    { wakeNotification: { is: legacyNotificationDeliveryWhere() } },
  ] };
}
