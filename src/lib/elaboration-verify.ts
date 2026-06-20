// Shared enable-predicate for the human-facing "Verify Elaborate" button.
//
// Both idea-detail panels (the `/ideas` route panel and the dashboard
// idea-tracker panel) gate the button on the SAME predicate so the two
// surfaces never drift. It is computed purely from elaboration data already
// loaded into the panels — no extra fetch. The server action re-validates
// the precondition authoritatively, so this is only a UX hint.

import type { ElaborationResponse } from "@/types/elaboration";

// A round is still awaiting answers iff its status is "pending_answers".
// (The legacy "validated" / "needs_followup" statuses read as answered — see
// src/types/elaboration.ts.)
function isRoundPending(status: string): boolean {
  return status === "pending_answers";
}

export interface CanVerifyElaborationInput {
  /** Idea.status — the stored 3-state value (open | elaborating | elaborated). */
  ideaStatus: string | null | undefined;
  /** Idea.elaborationStatus — pending_answers | validating | resolved | null. */
  elaborationStatus: string | null | undefined;
  /** Elaboration data already loaded into the panel (rounds + per-round status). */
  elaboration: ElaborationResponse | null | undefined;
}

/**
 * Whether the human "Verify Elaborate" button should be enabled.
 *
 * Enabled iff ALL hold:
 *  - the Idea is in `elaborating` status,
 *  - the elaboration is not already `resolved`,
 *  - the Idea has at least one elaboration round,
 *  - no round is in `pending_answers` (every round is fully answered).
 */
export function canVerifyElaboration({
  ideaStatus,
  elaborationStatus,
  elaboration,
}: CanVerifyElaborationInput): boolean {
  if (ideaStatus !== "elaborating") return false;
  if (elaborationStatus === "resolved") return false;
  if (!elaboration || elaboration.rounds.length === 0) return false;
  if (elaboration.rounds.some((round) => isRoundPending(round.status))) {
    return false;
  }
  return true;
}
