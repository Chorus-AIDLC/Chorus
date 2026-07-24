"use client";

// Token-usage badge (daemon-token-usage). ONE shared badge shape used in two places:
//   • per-turn, beside the status Badge in the turn band (`TokenUsageBadge`), and
//   • the conversation header total in transcript-view (`SessionUsageBadge`).
// Both render the SAME `UsageBadge`: a compact SUMMED number (input + output, humanized)
// with a Coins glyph, and a tooltip that reveals the detail breakdown. The owner wanted
// the header to look exactly like a turn's badge — sum on the face, detail on hover.
//
// Contract:
//   • Render NOTHING when there's no positive token activity (null usage / all-null /
//     all-zero) — no misleading "0 tok" (per the elaboration decision).
//   • The visible number is input + output ONLY — cache is never folded into it (cache-read
//     can be 100× input). Cache appears only in the per-turn tooltip breakdown.
//   • Tooltip rows omit any null field.
//
// Interaction: the breakdown uses a Radix **Popover**, NOT a Tooltip. A Tooltip is
// hover/focus-driven and never opens reliably on touch (an earlier controlled-Tooltip + tap
// hack raced Radix's own pointer handling and made the panel flicker/vanish on mobile — the
// owner hit exactly that). A Popover opens on click/TAP and STAYS open until click-outside /
// Escape / re-tap — identical for mouse and touch, no hover dependency, keyboard-accessible
// (trigger is a focusable button; Enter/Space opens).
//
// Theme: semantic tokens (bg-secondary / text-muted-foreground on the face; the shared
// PopoverContent is bg-popover / text-popover-foreground), correct in both light and dark.

import { useTranslations } from "next-intl";
import { Coins } from "lucide-react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { formatCompactTokens, headlineTokenTotal } from "@/lib/token-usage-format";
import type { TokenUsage } from "@/services/daemon-session.service";

export interface UsageBadgeRow {
  label: string;
  value: string;
}

/**
 * The shared presentational badge: a compact label (already humanized) + a breakdown panel
 * that opens on click/tap and stays open (Popover). `ariaLabel` is the accessible name of
 * the badge face.
 */
export function UsageBadge({
  label,
  ariaLabel,
  rows,
}: {
  label: string;
  ariaLabel: string;
  rows: UsageBadgeRow[];
}) {
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button
          type="button"
          className="inline-flex cursor-pointer items-center gap-1 rounded-md bg-secondary px-1.5 py-0 text-[10px] font-medium tabular-nums text-muted-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring"
          aria-label={ariaLabel}
        >
          <Coins className="h-2.5 w-2.5" aria-hidden />
          {label}
        </button>
      </PopoverTrigger>
      {/* Compact panel (override the default w-72 p-4). Semantic tokens → both themes. */}
      <PopoverContent align="start" className="w-fit min-w-[8rem] rounded-md p-2">
        <div className="flex flex-col gap-0.5 text-[11px]">
          {rows.map((r) => (
            <div key={r.label} className="flex items-center justify-between gap-4">
              <span className="opacity-70">{r.label}</span>
              <span className="font-mono tabular-nums">{r.value}</span>
            </div>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

/** True iff a usage object carries positive token activity in any field. */
function hasTokenActivity(usage: TokenUsage | null): usage is TokenUsage {
  if (!usage) return false;
  return (
    (usage.inputTokens ?? 0) +
      (usage.outputTokens ?? 0) +
      (usage.cacheCreationTokens ?? 0) +
      (usage.cacheReadTokens ?? 0) >
    0
  );
}

/**
 * Per-turn badge: summed input+output on the face; tooltip breaks down
 * input / output / cache-read / cache-write / model (null fields omitted). Renders nothing
 * for a turn with no positive token activity (no misleading "0 tok").
 */
export function TokenUsageBadge({ usage }: { usage: TokenUsage | null }) {
  const t = useTranslations("daemonChat");
  if (!hasTokenActivity(usage)) return null;

  const total = headlineTokenTotal(usage.inputTokens, usage.outputTokens);
  const rows: UsageBadgeRow[] = [];
  if (usage.inputTokens != null)
    rows.push({ label: t("usageInput"), value: usage.inputTokens.toLocaleString() });
  if (usage.outputTokens != null)
    rows.push({ label: t("usageOutput"), value: usage.outputTokens.toLocaleString() });
  if (usage.cacheReadTokens != null)
    rows.push({ label: t("usageCacheRead"), value: usage.cacheReadTokens.toLocaleString() });
  if (usage.cacheCreationTokens != null)
    rows.push({ label: t("usageCacheWrite"), value: usage.cacheCreationTokens.toLocaleString() });
  if (usage.model) rows.push({ label: t("usageModel"), value: usage.model });

  return (
    <UsageBadge
      label={t("usageBadgeLabel", { total: formatCompactTokens(total) })}
      ariaLabel={t("usageBadgeAria", { total })}
      rows={rows}
    />
  );
}

/**
 * Conversation-header badge: identical badge shape, driven by the SESSION rollup. The face
 * shows the summed input+output for the whole conversation; the tooltip breaks down Input /
 * Output (the rollup carries no cache, so cache is per-turn only). Renders nothing when the
 * conversation has no reported in/out (all-silent stays clean — no "0 tok").
 */
export function SessionUsageBadge({
  totalInputTokens,
  totalOutputTokens,
  totalCacheReadTokens,
  totalCacheCreationTokens,
}: {
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCacheReadTokens: number;
  totalCacheCreationTokens: number;
}) {
  const t = useTranslations("daemonChat");
  const total = totalInputTokens + totalOutputTokens;
  if (total <= 0) return null;

  // Face = in+out sum (cache excluded — cache-read can be 100× input). Tooltip breaks down
  // Input / Output AND Cache read / Cache write, all at the WHOLE-SESSION scope (the same
  // scope as the face's sum) so the tooltip never mismatches the face. Cache rows appear
  // only when > 0 (a conversation with no cache stays clean).
  const rows: UsageBadgeRow[] = [
    { label: t("usageInput"), value: totalInputTokens.toLocaleString() },
    { label: t("usageOutput"), value: totalOutputTokens.toLocaleString() },
  ];
  if (totalCacheReadTokens > 0)
    rows.push({ label: t("usageCacheRead"), value: totalCacheReadTokens.toLocaleString() });
  if (totalCacheCreationTokens > 0)
    rows.push({ label: t("usageCacheWrite"), value: totalCacheCreationTokens.toLocaleString() });

  return (
    <UsageBadge
      label={t("usageBadgeLabel", { total: formatCompactTokens(total) })}
      ariaLabel={t("conversationUsageAria", { total })}
      rows={rows}
    />
  );
}
