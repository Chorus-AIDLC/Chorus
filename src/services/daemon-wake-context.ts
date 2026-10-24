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

const ideaTeamFenceSchema = z.object({
  ideaUuid: z.string().uuid(),
  generation: z.number().int().nonnegative(),
  ownerUuid: z.string().uuid(),
  agentUuid: z.string().uuid(),
  role: z.enum(["orchestrator", "product"]),
});

const wakeContextSchema = z.object({
  version: z.literal(1),
  ideaTeam: ideaTeamFenceSchema.optional(),
  ideaTeams: z.array(ideaTeamFenceSchema).min(1).optional(),
  notificationUuid: z.string().min(1),
  notification: notificationSchema,
}).refine((context) => context.notificationUuid === context.notification.uuid)
  .refine((context) => !context.ideaTeams || Boolean(context.ideaTeam && context.ideaTeams.some((fence) =>
    fence.ideaUuid === context.ideaTeam!.ideaUuid && fence.generation === context.ideaTeam!.generation &&
    fence.ownerUuid === context.ideaTeam!.ownerUuid && fence.agentUuid === context.ideaTeam!.agentUuid && fence.role === context.ideaTeam!.role)));

export type WakeContext = z.infer<typeof wakeContextSchema>;

export function parseWakeContext(value: unknown): WakeContext | null {
  const parsed = wakeContextSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

export function createWakeContext(notification: unknown): WakeContext | null {
  const parsed = notificationSchema.safeParse(notification);
  return parsed.success ? { version: 1, notificationUuid: parsed.data.uuid, notification: parsed.data } : null;
}
