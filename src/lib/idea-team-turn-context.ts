import { z } from "zod";
import { ApiError } from "./api-handler";
import type { IdeaTeamTurnContext } from "@/types/idea-team";

export const ideaTeamSupplementaryTurnsSchema = z.array(z.object({
  turnUuid: z.string().uuid(),
  admissionUuid: z.string().uuid(),
}).strict()).max(16);

export function readIdeaTeamTurnContext(headers: Headers): { ideaTeamTurn?: IdeaTeamTurnContext } {
  const turnUuid = headers.get("x-chorus-turn-uuid") ?? undefined;
  const admissionUuid = headers.get("x-chorus-admission-uuid") ?? undefined;
  const supplementary = headers.get("x-chorus-idea-team-turns");
  if (supplementary === null) return turnUuid !== undefined || admissionUuid !== undefined ? { ideaTeamTurn: { turnUuid, admissionUuid } } : {};
  let value: unknown;
  try {
    if (supplementary.length > 4096) throw new Error();
    value = JSON.parse(supplementary);
  } catch {
    throw new ApiError("BAD_REQUEST", "X-Chorus-Idea-Team-Turns must be a JSON array of at most 16 turn/admission UUID pairs", 400);
  }
  const parsed = ideaTeamSupplementaryTurnsSchema.safeParse(value);
  if (!turnUuid || !admissionUuid || !parsed.success) throw new ApiError("BAD_REQUEST", "Supplementary Idea Team proofs require primary turn/admission headers and at most 16 turn/admission UUID pairs", 400);
  return { ideaTeamTurn: { turnUuid, admissionUuid, supplementaryTurns: parsed.data } };
}
