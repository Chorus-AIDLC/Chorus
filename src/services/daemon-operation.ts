import { z } from "zod";
import type { Prisma } from "@/generated/prisma/client";

export const RESEARCH_INSTRUCTION_PREFIX = "[Chorus Tracker Research]";
export const OPERATION_TRIGGERS = ["idea_creation_requested", "research_requested"] as const;
export type OperationTrigger = (typeof OPERATION_TRIGGERS)[number];

const identity = z.string().min(1).max(100);
export const operationPayloadSchema = z.discriminatedUnion("kind", [
  z.object({
    version: z.literal(1), kind: z.literal("idea_creation"),
    ideaUuid: identity, projectUuid: identity,
    mode: z.enum(["elaborate", "decompose"]), researchFirst: z.boolean(),
    descriptionText: z.string().min(1).max(3000).refine((text) => text.trim().length > 0),
  }).strict(),
  z.object({ version: z.literal(1), kind: z.literal("research"), ideaUuid: identity }).strict(),
]);
export type OperationPayload = z.infer<typeof operationPayloadSchema>;

export function isOperationTrigger(trigger: string): trigger is OperationTrigger {
  return OPERATION_TRIGGERS.includes(trigger as OperationTrigger);
}

/** Prefix recognition exists only at the historical human_instruction boundary. */
export function isResearchTurn(turn: { trigger: string; promptText?: string | null }): boolean {
  return turn.trigger === "research_requested" ||
    (turn.trigger === "human_instruction" && turn.promptText?.startsWith(RESEARCH_INSTRUCTION_PREFIX) === true);
}

// SQL NOT LIKE alone drops NULL prompts. Keep the explicit null branch.
export const NON_RESEARCH_TURN: Prisma.DaemonSessionTurnWhereInput = {
  AND: [
    { trigger: { not: "research_requested" } },
    { OR: [
      { trigger: { not: "human_instruction" } },
      { promptText: null },
      { NOT: { promptText: { startsWith: RESEARCH_INSTRUCTION_PREFIX } } },
    ] },
  ],
};
export const NON_OPERATION_TURN: Prisma.DaemonSessionTurnWhereInput = {
  AND: [NON_RESEARCH_TURN, { trigger: { notIn: [...OPERATION_TRIGGERS] } }],
};

/** Rollback controls new writes only; stored operations always remain readable. */
export function dedicatedOperationWrites(): boolean {
  return process.env.CHORUS_DEDICATED_OPERATION_WRITES !== "false";
}

export function validateOperationPayload(
  trigger: string, raw: unknown,
  anchor: { directIdeaUuid: string | null; projectUuid: string | null },
): OperationPayload {
  const payload = operationPayloadSchema.parse(raw);
  if ((trigger === "idea_creation_requested" ? "idea_creation" :
    trigger === "research_requested" ? "research" : null) !== payload.kind ||
    payload.ideaUuid !== anchor.directIdeaUuid ||
    !anchor.projectUuid ||
    (payload.kind === "idea_creation" && payload.projectUuid !== anchor.projectUuid)) {
    throw new Error("Operation payload does not match its authorized session and Idea");
  }
  return payload;
}
