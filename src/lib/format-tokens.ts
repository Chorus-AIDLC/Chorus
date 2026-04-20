// Token count formatter: 420 -> "420", 3_800 -> "3.8k", 1_250_000 -> "1.2M"
export function formatTokens(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "0";

  const negative = n < 0;
  const abs = Math.abs(Math.round(n));
  const prefix = negative ? "-" : "";

  if (abs < 1_000) return `${prefix}${abs}`;
  if (abs < 1_000_000) {
    const k = abs / 1_000;
    return `${prefix}${k.toFixed(1).replace(/\.0$/, "")}k`;
  }
  const m = abs / 1_000_000;
  return `${prefix}${m.toFixed(1).replace(/\.0$/, "")}M`;
}
