/**
 * Shared, pure formatting helpers for per-turn / per-conversation token usage
 * (daemon-token-usage). Kept dependency-free so both the per-turn badge and the
 * conversation-total header can reuse the exact same humanization, and so the
 * rules are unit-testable without rendering.
 */

/**
 * Humanize a token count into a compact label:
 *   < 1000        → the number as-is ("312", "0")
 *   1_000–999_999 → "1.2k" (one decimal, trailing ".0" trimmed → "5k")
 *   ≥ 1_000_000   → "1.2M" (same trimming)
 * A null/negative/NaN input renders "0" so a caller never shows "NaN"/"null".
 * Deterministic and locale-independent (the "k"/"M" suffix is not translated —
 * it reads the same in every locale, matching how the rest of the UI shows
 * compact counts).
 */
export function formatCompactTokens(n: number | null | undefined): string {
  if (typeof n !== "number" || !Number.isFinite(n) || n < 0) return "0";
  if (n < 1000) return String(Math.round(n));
  const trim = (v: number, suffix: string) => {
    // One decimal, then drop a trailing ".0" so 5000 → "5k" not "5.0k".
    const s = v.toFixed(1).replace(/\.0$/, "");
    return `${s}${suffix}`;
  };
  if (n < 1_000_000) return trim(n / 1000, "k");
  return trim(n / 1_000_000, "M");
}

/**
 * The headline per-turn / per-conversation number is input + output tokens only
 * (cache is deliberately excluded — cache-read can be 100× input and would
 * dwarf the meaningful number; the elaboration-locked decision). Nulls count as
 * 0 so a partial usage still sums.
 */
export function headlineTokenTotal(
  inputTokens: number | null | undefined,
  outputTokens: number | null | undefined,
): number {
  return (inputTokens ?? 0) + (outputTokens ?? 0);
}
