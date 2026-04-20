"use client";

// src/app/(dashboard)/projects/[uuid]/observability/agent-observability.tsx
// Client component — date range toggle, agent selection, summary cards, detail view.

import { useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { BarChart3 } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { authFetch } from "@/lib/auth-client";
import { clientLogger } from "@/lib/logger-client";
import type {
  AgentObservabilityResult,
  AgentObservabilityItem,
} from "@/services/observability.service";
import { DailyTokenChart } from "./daily-token-chart";
import { ToolUsageTable } from "./tool-usage-table";

// Heuristic role inference from agent name (the observability API doesn't
// return agent.roles). Falls back to a generic "Agent" label.
function inferRole(name: string): "pm" | "developer" | "admin" | null {
  const lower = name.toLowerCase();
  if (lower.includes("admin")) return "admin";
  if (lower.includes("pm") || lower.includes("product")) return "pm";
  if (lower.includes("dev") || lower.includes("engineer") || lower.includes("worker")) {
    return "developer";
  }
  return null;
}

type RangeDays = 7 | 30 | 90;

interface AgentObservabilityProps {
  projectUuid: string;
  initialData: AgentObservabilityResult;
}

function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

function totalTokens(item: AgentObservabilityItem): number {
  const t = item.sessionTokens;
  return t.input_tokens + t.output_tokens + t.cache_creation_input_tokens + t.cache_read_input_tokens;
}

function isOnline(item: AgentObservabilityItem, from: Date): boolean {
  if (item.dailySeries.length === 0) return false;
  const last = item.dailySeries[item.dailySeries.length - 1].date;
  const lastDate = new Date(`${last}T00:00:00.000Z`);
  const todayKey = new Date().toISOString().slice(0, 10);
  return last === todayKey || lastDate.getTime() >= from.getTime();
}

function roleLabel(
  name: string,
  t: (key: string) => string
): string {
  const role = inferRole(name);
  if (role === "pm") return t("observability.rolePm");
  if (role === "admin") return t("observability.roleAdmin");
  if (role === "developer") return t("observability.roleDeveloper");
  return t("observability.agent");
}

export function AgentObservability({
  projectUuid,
  initialData,
}: AgentObservabilityProps) {
  const t = useTranslations();
  const [days, setDays] = useState<RangeDays>(7);
  const [data, setData] = useState<AgentObservabilityResult>(initialData);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selectedAgentUuid, setSelectedAgentUuid] = useState<string | null>(
    initialData.agents[0]?.agentUuid ?? null
  );

  // Reload data when date range changes.
  useEffect(() => {
    if (days === 7 && data.dateRange.days === 7 && data === initialData) {
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    authFetch(`/api/projects/${projectUuid}/observability?days=${days}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const json = await res.json();
        if (!json.success) throw new Error(json.error ?? "Unknown");
        if (cancelled) return;
        setData(json.data);
        if (
          !selectedAgentUuid ||
          !json.data.agents.find(
            (a: AgentObservabilityItem) => a.agentUuid === selectedAgentUuid
          )
        ) {
          setSelectedAgentUuid(json.data.agents[0]?.agentUuid ?? null);
        }
      })
      .catch((err) => {
        if (cancelled) return;
        clientLogger.error("Failed to load observability:", err);
        setError(t("observability.loadError"));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [days, projectUuid]);

  const summary = useMemo(() => {
    let tokenSum = 0;
    let cacheRead = 0;
    let toolCalls = 0;
    let errors = 0;
    for (const a of data.agents) {
      tokenSum += totalTokens(a);
      cacheRead += a.sessionTokens.cache_read_input_tokens;
      toolCalls += a.toolCallCount;
      errors += a.toolErrorCount;
    }
    const errorRate = toolCalls > 0 ? (errors / toolCalls) * 100 : 0;
    const perDay = days > 0 ? Math.round(toolCalls / days) : 0;
    return { tokenSum, cacheRead, toolCalls, errorRate, perDay };
  }, [data, days]);

  const agents = data.agents;

  const selected = useMemo(
    () => agents.find((a) => a.agentUuid === selectedAgentUuid) ?? null,
    [agents, selectedAgentUuid]
  );

  const rangeButtons: Array<{ value: RangeDays; labelKey: string }> = [
    { value: 7, labelKey: "observability.range7d" },
    { value: 30, labelKey: "observability.range30d" },
    { value: 90, labelKey: "observability.range90d" },
  ];

  return (
    <div className="p-4 md:p-8">
      {/* Header */}
      <div className="mb-6 flex flex-col gap-4 md:flex-row md:items-start md:justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-[#2C2C2C]">
            {t("observability.title")}
          </h1>
          <p className="mt-1 text-sm text-[#6B6B6B]">
            {t("observability.subtitle")}
          </p>
        </div>
        {/* Segmented range control */}
        <div
          className="inline-flex overflow-hidden rounded-lg border border-[#E5E0D8] bg-white"
          role="group"
        >
          {rangeButtons.map((btn, idx) => {
            const active = days === btn.value;
            return (
              <button
                key={btn.value}
                type="button"
                onClick={() => setDays(btn.value)}
                className={`px-4 py-1.5 text-xs font-semibold transition-colors ${
                  active
                    ? "bg-[#C67A52] text-white"
                    : "bg-white text-[#6B6B6B] hover:bg-[#F5F2EC]"
                } ${idx > 0 ? "border-l border-[#E5E0D8]" : ""}`}
              >
                {t(btn.labelKey)}
              </button>
            );
          })}
        </div>
      </div>

      {error && (
        <Card className="mb-6 border-[#E5E0D8] bg-white p-4 text-sm text-[#D32F2F]">
          {error}
        </Card>
      )}

      {/* Summary Cards */}
      <div className="mb-6 grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <SummaryCard
          label={t("observability.totalTokens")}
          value={formatNumber(summary.tokenSum)}
        />
        <SummaryCard
          label={t("observability.toolCalls")}
          value={summary.toolCalls.toLocaleString()}
          hint={t("observability.callsPerDay", { count: summary.perDay })}
          hintTone="muted"
        />
        <SummaryCard
          label={t("observability.cacheRead")}
          value={formatNumber(summary.cacheRead)}
        />
        <SummaryCard
          label={t("observability.errorRate")}
          value={`${summary.errorRate.toFixed(1)}%`}
          hintTone={summary.errorRate > 5 ? "negative" : "muted"}
        />
      </div>

      {/* Body: agent list + detail */}
      {agents.length === 0 ? (
        <Card className="flex flex-col items-center justify-center border-[#E5E0D8] bg-white p-12 text-center">
          <div className="mb-4 flex h-16 w-16 items-center justify-center rounded-full bg-[#F5F2EC]">
            <BarChart3 className="h-8 w-8 text-[#6B6B6B]" />
          </div>
          <h3 className="mb-2 text-lg font-medium text-[#2C2C2C]">
            {t("observability.noData")}
          </h3>
          <p className="max-w-sm text-sm text-[#6B6B6B]">
            {t("observability.noDataDesc")}
          </p>
        </Card>
      ) : (
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-[320px_1fr]">
          {/* Agent list */}
          <Card className="gap-0 overflow-hidden border-[#E5E0D8] bg-white p-0">
            <div className="flex items-center justify-between border-b border-[#F5F2EC] px-5 py-3.5">
              <div className="text-sm font-semibold text-[#2C2C2C]">
                {t("observability.agents")}
              </div>
              <div className="text-[11px] text-[#9A9A9A]">
                {t("observability.agentsCount", { count: agents.length })}
              </div>
            </div>
            <div className="flex flex-col">
              {agents.map((a) => {
                const active = a.agentUuid === selectedAgentUuid;
                const online = isOnline(
                  a,
                  new Date(Date.now() - 24 * 60 * 60 * 1000)
                );
                return (
                  <Button
                    key={a.agentUuid}
                    variant="ghost"
                    onClick={() => setSelectedAgentUuid(a.agentUuid)}
                    className={`h-auto justify-start rounded-none border-b border-[#F5F2EC] px-5 py-3 last:border-b-0 ${
                      active
                        ? "bg-[#F5F2EC] hover:bg-[#F5F2EC]"
                        : "hover:bg-[#FAF8F4]"
                    }`}
                  >
                    <div className="flex w-full items-start gap-3">
                      <span
                        className={`mt-1.5 inline-block h-2 w-2 flex-shrink-0 rounded-full ${
                          online ? "bg-[#22C55E]" : "bg-[#9A9A9A]"
                        }`}
                      />
                      <div className="flex min-w-0 flex-1 flex-col items-start gap-0.5">
                        <div
                          className={`truncate text-[13px] ${
                            active
                              ? "font-semibold text-[#2C2C2C]"
                              : "font-medium text-[#2C2C2C]"
                          }`}
                        >
                          {a.agentName}
                        </div>
                        <div className="flex items-center gap-2 text-[11px] text-[#9A9A9A]">
                          <span>
                            {roleLabel(a.agentName, t)}
                          </span>
                          <span aria-hidden>·</span>
                          <span
                            className={
                              active
                                ? "font-medium text-[#C67A52]"
                                : ""
                            }
                          >
                            {formatNumber(totalTokens(a))} {t("observability.tokensSuffix")}
                          </span>
                        </div>
                      </div>
                    </div>
                  </Button>
                );
              })}
            </div>
          </Card>

          {/* Detail panel */}
          <div className="flex flex-col gap-5">
            {selected ? (
              <>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2.5">
                    <span
                      className={`inline-block h-2.5 w-2.5 rounded-full ${
                        isOnline(
                          selected,
                          new Date(Date.now() - 24 * 60 * 60 * 1000)
                        )
                          ? "bg-[#22C55E]"
                          : "bg-[#9A9A9A]"
                      }`}
                    />
                    <h2 className="text-base font-semibold text-[#2C2C2C]">
                      {selected.agentName}
                    </h2>
                  </div>
                  <span className="rounded-md bg-[#F5F2EC] px-2.5 py-1 text-[11px] font-medium text-[#6B6B6B]">
                    {roleLabel(selected.agentName, t)}
                  </span>
                </div>

                <DailyTokenChart
                  agent={selected}
                  days={days}
                  loading={loading}
                />

                <ToolUsageTable
                  tools={selected.topTools}
                  loading={loading}
                />
              </>
            ) : (
              <Card className="flex flex-col items-center justify-center border-[#E5E0D8] bg-white p-12 text-center">
                <h3 className="mb-2 text-lg font-medium text-[#2C2C2C]">
                  {t("observability.selectAgent")}
                </h3>
                <p className="max-w-sm text-sm text-[#6B6B6B]">
                  {t("observability.selectAgentDesc")}
                </p>
              </Card>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function SummaryCard({
  label,
  value,
  hint,
  hintTone,
}: {
  label: string;
  value: string;
  hint?: string;
  hintTone?: "positive" | "negative" | "muted";
}) {
  const hintColor =
    hintTone === "negative"
      ? "text-[#D32F2F]"
      : hintTone === "positive"
      ? "text-[#16a34a]"
      : "text-[#9A9A9A]";
  return (
    <Card className="gap-2 rounded-xl border-[#E5E0D8] bg-white px-5 py-4">
      <div className="text-xs text-[#9A9A9A]">{label}</div>
      <div className="flex items-end gap-2">
        <div className="text-[22px] font-bold leading-none text-[#2C2C2C]">
          {value}
        </div>
        {hint && (
          <div className={`text-[11px] font-medium ${hintColor}`}>{hint}</div>
        )}
      </div>
    </Card>
  );
}
