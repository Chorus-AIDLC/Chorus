import { z } from "zod";

const notificationSchema = z.object({
  uuid: z.string().min(1),
  action: z.string().min(1),
  entityType: z.string().min(1),
  entityUuid: z.string().min(1),
  projectUuid: z.string(),
  recipientType: z.literal("agent"),
  recipientUuid: z.string().min(1),
  message: z.string(),
  entityTitle: z.string(),
  projectName: z.string(),
  actorType: z.string(),
  actorUuid: z.string(),
  actorName: z.string(),
  instructionText: z.string().nullable().optional(),
});

const wakeContextSchema = z.object({
  version: z.literal(1),
  notificationUuid: z.string().min(1),
  notification: notificationSchema,
}).refine((context) => context.notificationUuid === context.notification.uuid);

export type WakeContext = z.infer<typeof wakeContextSchema>;

export function parseWakeContext(value: unknown): WakeContext | null {
  const parsed = wakeContextSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function createWakeContext(notification: unknown): WakeContext | null {
  const parsed = notificationSchema.safeParse(notification);
  return parsed.success ? { version: 1, notificationUuid: parsed.data.uuid, notification: parsed.data } : null;
}
