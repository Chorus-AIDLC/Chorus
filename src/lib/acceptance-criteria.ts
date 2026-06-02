/**
 * Shared acceptance-criteria validation — the single source of truth for the
 * "every task / task draft must have at least one non-empty acceptance criterion"
 * invariant.
 *
 * Used by both the proposal service (task drafts stored as JSON) and the MCP
 * tool handlers in `src/mcp/tools/public.ts` (real-task AcceptanceCriterion rows).
 * Keeping the rule here avoids drift between the two enforcement layers.
 */

/** Input shape accepted by the create/edit tools before normalization. */
export interface AcceptanceCriteriaItemInput {
  description: string;
  required?: boolean;
}

/** Normalized acceptance-criterion item ready for persistence. */
export interface NormalizedAcceptanceCriteriaItem {
  description: string;
  required: boolean;
}

/**
 * Standard error message thrown / returned when acceptance criteria are missing
 * or contain no non-blank description.
 */
export const ACCEPTANCE_CRITERIA_REQUIRED_MESSAGE =
  "At least one acceptance criterion with a non-empty description is required.";

/**
 * Drop items whose description is blank after trimming, trim the surviving
 * descriptions, and default `required` to `true`. Order is preserved.
 */
export function normalizeAcceptanceCriteria(
  items: AcceptanceCriteriaItemInput[] | undefined | null,
): NormalizedAcceptanceCriteriaItem[] {
  if (!items) return [];
  return items
    .filter((item) => item.description.trim().length > 0)
    .map((item) => ({
      description: item.description.trim(),
      required: item.required ?? true,
    }));
}

/**
 * True iff at least one item has a non-blank description (after trimming).
 * `undefined`, `null`, an empty array, and an all-blank array all return false.
 */
export function hasNonEmptyAcceptanceCriteria(
  items: AcceptanceCriteriaItemInput[] | undefined | null,
): boolean {
  return normalizeAcceptanceCriteria(items).length > 0;
}
