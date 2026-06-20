// src/services/daemon-session-naming.ts
// Shared, dependency-light conversation-naming helpers (子3 follow-up).
//
// A daemon conversation is NAMED by what the human first said to it: its opening
// `human_instruction` turn, collapsed + clamped. This logic is needed by THREE callers —
// the targeting list (`daemon-instruction.service`), the execution enrichment
// (`daemon-execution.service`), and (mirrored) the client chat — so it lives in this
// LEAF module rather than in `daemon-session.service`, whose transitive import graph
// (notification/mention/logger) we do NOT want to drag into the execution service.
//
// Only Prisma is imported. Pure functions + one batched query; no event bus, no logger.

import { prisma } from "@/lib/prisma";

// Max length of a conversation's derived display name. Single-sourced so the sidebar
// list, the popover/footer ExecutionRow, and the targeting list can NEVER name the same
// conversation differently. The client mirrors this value (chat/daemon-chat.tsx).
export const CONVERSATION_NAME_MAX = 60;

/**
 * Derive a conversation's display name from its opening human instruction: collapse
 * whitespace to a single line and clamp to `CONVERSATION_NAME_MAX`, so a long first
 * message stays a scannable one-line title. Returns "" for a missing/blank instruction
 * (callers fall back to a localized label) — never a partial/garbled string.
 */
export function conversationNameFromInstruction(
  promptText: string | null | undefined,
): string {
  const flat = (promptText ?? "").replace(/\s+/g, " ").trim();
  if (!flat) return "";
  return flat.length > CONVERSATION_NAME_MAX
    ? `${flat.slice(0, CONVERSATION_NAME_MAX).trimEnd()}…`
    : flat;
}

/**
 * Batch-resolve each session's OPENING human-instruction text, keyed by `sessionUuid`.
 * One query for any number of sessions: the earliest (`seq` asc) `human_instruction`
 * turn per session with a non-null body wins (first-seen-per-session in the ordered
 * result). Sessions with no such turn are simply absent from the map. Used by both the
 * targeting list and the execution enrichment so the "name a conversation by its first
 * message" rule is single-sourced. A READ that does NOT swallow — a query failure
 * propagates.
 */
export async function getFirstInstructionBySessionUuid(
  sessionUuids: string[],
): Promise<Map<string, string>> {
  const byUuid = new Map<string, string>();
  if (sessionUuids.length === 0) return byUuid;
  const turns = await prisma.daemonSessionTurn.findMany({
    where: {
      sessionUuid: { in: sessionUuids },
      trigger: "human_instruction",
      promptText: { not: null },
    },
    select: { sessionUuid: true, promptText: true, seq: true },
    orderBy: [{ sessionUuid: "asc" }, { seq: "asc" }],
  });
  for (const turn of turns) {
    if (!byUuid.has(turn.sessionUuid) && turn.promptText) {
      byUuid.set(turn.sessionUuid, turn.promptText);
    }
  }
  return byUuid;
}
