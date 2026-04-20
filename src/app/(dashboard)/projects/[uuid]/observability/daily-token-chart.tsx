"use client";

// src/app/(dashboard)/projects/[uuid]/observability/daily-token-chart.tsx
// Bar chart rendered with plain divs — stacked input (darker) over output (lighter).

import { useMemo } from "react";
import { useTranslations } from "next-intl";
import { Card } from "@/components/ui/card";
import type { AgentObservabilityItem } from "@/services/observability.service";

interface DailyTokenChartProps {
  agent: AgentObservabilityItem;
  days: number;
  loading?: boolean;
}

interface DayBucket {
  date: string;
  dayLabel: string;
  input: number;
  output: number;
  total: number;
  isToday: boolean;
}

function formatDayLabel(date: string, todayKey: string): string {
  if (date === todayKey) return "";
  const d = new Date(`${date}T00:00:00.000Z`);
  return String(d.getUTCDate());
}

export function DailyTokenChart({
  agent,
  days,
  loading,
}: DailyTokenChartProps) {
  const t = useTranslations();

  const buckets = useMemo<DayBucket[]>(() => {
    const todayKey = new Date().toISOString().slice(0, 10);

    // Allocate one bucket per day in range. Pure call-count distribution is
    // used here because the API doesn't give per-day input/output token
    // breakdown; we split toolCallCount roughly by the agent's overall ratio
    // between input and output so the stack is visually informative.
    const totalCalls = agent.dailySeries.reduce(
      (acc, d) => acc + d.toolCallCount,
      0
    );
    const inputTokens = agent.sessionTokens.input_tokens;
    const outputTokens = agent.sessionTokens.output_tokens;
    const tokensTotal = inputTokens + outputTokens;

    const map = new Map(agent.dailySeries.map((d) => [d.date, d.toolCallCount]));

    const out: DayBucket[] = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date();
      d.setUTCHours(0, 0, 0, 0);
      d.setUTCDate(d.getUTCDate() - i);
      const key = d.toISOString().slice(0, 10);
      const calls = map.get(key) ?? 0;
      const ratio = totalCalls > 0 ? calls / totalCalls : 0;
      const tokensForDay = tokensTotal * ratio;
      const inputShare =
        tokensTotal > 0 ? inputTokens / tokensTotal : 0.6;
      const outputShare = 1 - inputShare;
      out.push({
        date: key,
        dayLabel: formatDayLabel(key, todayKey),
        input: tokensForDay * inputShare,
        output: tokensForDay * outputShare,
        total: tokensForDay,
        isToday: key === todayKey,
      });
    }
    return out;
  }, [agent, days]);

  const maxTotal = useMemo(
    () => Math.max(1, ...buckets.map((b) => b.total)),
    [buckets]
  );

  // When a large range is selected, skip label rendering for non-today days to
  // avoid a cramped axis.
  const labelEveryN = days <= 7 ? 1 : days <= 30 ? 4 : 10;

  return (
    <Card className="gap-3 border-[#E5E0D8] bg-white px-5 py-4">
      <div className="flex items-center justify-between">
        <div className="text-[13px] font-semibold text-[#2C2C2C]">
          {t("observability.dailyTokenUsage")}
        </div>
        <div className="flex items-center gap-3 text-[10px] text-[#9A9A9A]">
          <div className="flex items-center gap-1.5">
            <span className="inline-block h-2 w-2 rounded-[2px] bg-[#C67A52]" />
            {t("observability.legendInput")}
          </div>
          <div className="flex items-center gap-1.5">
            <span className="inline-block h-2 w-2 rounded-[2px] bg-[#E5C8B5]" />
            {t("observability.legendOutput")}
          </div>
        </div>
      </div>

      <div
        className={`flex h-40 items-end gap-2 ${
          loading ? "opacity-60" : ""
        }`}
      >
        {buckets.map((b, idx) => {
          const heightPct =
            b.total > 0 ? Math.max(4, (b.total / maxTotal) * 100) : 2;
          const inputPct =
            b.total > 0 ? (b.input / b.total) * 100 : 0;
          const outputPct =
            b.total > 0 ? (b.output / b.total) * 100 : 0;
          const showLabel =
            b.isToday || idx === buckets.length - 1 || idx % labelEveryN === 0;
          return (
            <div
              key={b.date}
              className="flex h-full flex-1 flex-col items-center justify-end gap-1"
              title={`${b.date} · ${Math.round(b.total).toLocaleString()} tokens`}
            >
              <div
                className="flex w-full flex-col justify-end"
                style={{ height: `${heightPct}%` }}
              >
                {b.total > 0 ? (
                  <>
                    <div
                      className="w-full rounded-t-[4px] bg-[#C67A52]"
                      style={{ height: `${inputPct}%` }}
                    />
                    <div
                      className="w-full rounded-b-[4px] bg-[#E5C8B5]"
                      style={{ height: `${outputPct}%` }}
                    />
                  </>
                ) : (
                  <div className="h-full w-full rounded-[4px] bg-[#F5F2EC]" />
                )}
              </div>
              <div className="min-h-[12px] text-[9px] text-[#9A9A9A]">
                {showLabel
                  ? b.isToday
                    ? t("observability.today")
                    : b.dayLabel
                  : ""}
              </div>
            </div>
          );
        })}
      </div>
    </Card>
  );
}
