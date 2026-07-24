// Pure helper for the live conversation-total update (daemon-token-usage).
//
// The `turn_status_changed` SSE event carries only the affected turn, not the session, so
// the header's scalar rollup (`session.totalInputTokens/totalOutputTokens`) would stay
// frozen until a refetch. On a terminal edge carrying usage, the client folds that turn's
// input/output into the local rollup ONCE — deduped by turn uuid against both the fetched
// baseline (every terminal turn the server rollup already counted) and prior live events.
// This mirrors the server's atomic increment. Cache is intentionally NOT rolled up (the
// header headline excludes it — cache-read can be 100× input).
//
// Extracted as a pure function so the dedup + terminal-edge + null-safety rules are
// unit-testable without rendering the chat.

import type { TokenUsage } from "@/services/daemon-session.service";

export interface LiveRollupState {
  totalInputTokens: number;
  totalOutputTokens: number;
}

/**
 * Given the current rollup and a turn's terminal event, return the delta to apply and
 * whether the turn should now be marked counted. Returns `null` when nothing should change
 * (non-terminal, no usage, already counted, or a zero delta).
 *
 * The caller owns the `counted` Set (a ref) — it passes it in for the read and records the
 * uuid when this returns a non-null result.
 *
 * @param counted  Turn uuids already reflected in the rollup (baseline + prior live).
 * @param turn     The event's turn: uuid, status, and (maybe) usage.
 */
export function rollupDeltaForTurn(
  counted: ReadonlySet<string>,
  turn: { uuid: string; status?: string; usage?: TokenUsage | null },
): {
  addInput: number;
  addOutput: number;
  addCacheRead: number;
  addCacheWrite: number;
} | null {
  const terminal = turn.status === "ended" || turn.status === "interrupted";
  if (!terminal) return null;
  const usage = turn.usage ?? null;
  if (!usage) return null;
  if (counted.has(turn.uuid)) return null;
  const addInput = usage.inputTokens ?? 0;
  const addOutput = usage.outputTokens ?? 0;
  const addCacheRead = usage.cacheReadTokens ?? 0;
  const addCacheWrite = usage.cacheCreationTokens ?? 0;
  // Roll up when the turn had ANY positive token activity (not just in/out) so a
  // cache-heavy turn still updates the header tooltip's cache totals live. An all-zero
  // usage (superseded/duplicate turn) contributes nothing → skip.
  if (addInput === 0 && addOutput === 0 && addCacheRead === 0 && addCacheWrite === 0) {
    return null;
  }
  return { addInput, addOutput, addCacheRead, addCacheWrite };
}
