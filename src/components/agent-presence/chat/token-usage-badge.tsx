"use client";

// Per-turn token-usage badge (daemon-token-usage) — sits beside the status Badge in the
// turn band. It shows a COMPACT total (input + output, humanized) and reveals the full
// breakdown (input / output / cache-read / cache-write / model) in a hover/tap tooltip.
//
// Contract (elaboration-locked):
//   • Render NOTHING when the turn reported no usage (usage null, or both token counts
//     null) — no number, no "not reported" text, no placeholder. A no-data turn is simply
//     bare, per the container-scope decision (the "not reported" label is reserved for the
//     structurally-silent Kiro backend, its own idea).
//   • The visible number is input + output ONLY — cache is never folded into it (cache-read
//     can be 100× input). Cache lives in the tooltip breakdown.
//   • Tooltip rows omit any null field (a backend that can't report cache-write shows no
//     cache-write row).
//
// Theme: the badge uses semantic tokens (bg-secondary / text-muted-foreground) and the
// shared TooltipContent is `bg-foreground text-background`, so it reads correctly in BOTH
// light and dark with no fixed-light-only color. Each consumer wraps its own
// TooltipProvider (there is no app-global one) — mirrors reference-notes.tsx.

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

export function TokenUsageBadge({ usage }: { usage: TokenUsage | null }) {
  const t = useTranslations("daemonChat");

  // No-data → no badge (contract: no misleading zeros). We hide the badge unless the turn
  // has POSITIVE token activity in at least one field. This covers three no-data shapes:
  //   • usage is null (pre-feature / silent turn),
  //   • a usage object whose token fields are all null (e.g. only a model reported),
  //   • an all-ZERO usage object — e.g. a superseded/duplicate instruction whose result
  //     frame reported 0/0/0/0 (seen live on turn 8). "0 tok" is exactly the misleading
  //     zero the elaboration decision forbids, so it renders nothing too.
  const anyTokens =
    (usage?.inputTokens ?? 0) +
    (usage?.outputTokens ?? 0) +
    (usage?.cacheCreationTokens ?? 0) +
    (usage?.cacheReadTokens ?? 0);
  if (!usage || anyTokens <= 0) return null;

  const total = headlineTokenTotal(usage.inputTokens, usage.outputTokens);
  const compact = formatCompactTokens(total);

  // Breakdown rows — each omitted when its field is null. Values are shown in full (not
  // compacted) in the tooltip, where there's room and precision is useful.
  const rows: Array<{ label: string; value: string }> = [];
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
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <span
            className="inline-flex cursor-default items-center gap-1 rounded-md bg-secondary px-1.5 py-0 text-[10px] font-medium tabular-nums text-muted-foreground"
            aria-label={t("usageBadgeAria", { total })}
          >
            <Coins className="h-2.5 w-2.5" aria-hidden />
            {t("usageBadgeLabel", { total: compact })}
          </span>
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
