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
// Mobile: Radix Tooltip is hover/focus-only by default, so it never opens on touch. We make
// it a CONTROLLED tooltip that also toggles open on TAP (pointerup) — desktop hover + keyboard
// focus still open it via `onOpenChange`. This is why each badge instance owns its own
// TooltipProvider + open state (there is no app-global provider — mirrors reference-notes.tsx).
//
// Theme: semantic tokens (bg-secondary / text-muted-foreground) + the shared TooltipContent
// (bg-foreground / text-background), correct in both light and dark with no fixed-light hex.

import { useState } from "react";
import { useTranslations } from "next-intl";
import { Coins } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { formatCompactTokens, headlineTokenTotal } from "@/lib/token-usage-format";
import type { TokenUsage } from "@/services/daemon-session.service";

export interface UsageBadgeRow {
  label: string;
  value: string;
}

/**
 * The shared presentational badge: a compact label (already humanized) + a breakdown
 * tooltip. Hover/focus opens it on desktop; a tap toggles it on touch (controlled `open`).
 * `ariaLabel` is the accessible name of the badge face.
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
  // Controlled so a TAP can open it on touch devices (Radix hover/focus won't fire there).
  // `onOpenChange` keeps desktop hover + keyboard focus working; the tap handler toggles.
  const [open, setOpen] = useState(false);

  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip open={open} onOpenChange={setOpen}>
        <TooltipTrigger asChild>
          <button
            type="button"
            // Toggle on tap/click (covers touch, where hover never fires). `onPointerUp`
            // fires for both mouse and touch; we flip the controlled state so a second tap
            // closes it. Desktop hover still opens via onOpenChange before any click.
            onPointerUp={() => setOpen((v) => !v)}
            className="inline-flex cursor-default items-center gap-1 rounded-md bg-secondary px-1.5 py-0 text-[10px] font-medium tabular-nums text-muted-foreground outline-none focus-visible:ring-1 focus-visible:ring-ring"
            aria-label={ariaLabel}
          >
            <Coins className="h-2.5 w-2.5" aria-hidden />
            {label}
          </button>
        </TooltipTrigger>
        <TooltipContent className="max-w-xs">
          <div className="flex flex-col gap-0.5 text-[11px]">
            {rows.map((r) => (
              <div key={r.label} className="flex items-center justify-between gap-4">
                <span className="opacity-70">{r.label}</span>
                <span className="font-mono tabular-nums">{r.value}</span>
              </div>
            ))}
          </div>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
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
}: {
  totalInputTokens: number;
  totalOutputTokens: number;
}) {
  const t = useTranslations("daemonChat");
  const total = totalInputTokens + totalOutputTokens;
  if (total <= 0) return null;

  const rows: UsageBadgeRow[] = [
    { label: t("usageInput"), value: totalInputTokens.toLocaleString() },
    { label: t("usageOutput"), value: totalOutputTokens.toLocaleString() },
  ];

  return (
    <UsageBadge
      label={t("usageBadgeLabel", { total: formatCompactTokens(total) })}
      ariaLabel={t("conversationUsageAria", { total })}
      rows={rows}
    />
  );
}
