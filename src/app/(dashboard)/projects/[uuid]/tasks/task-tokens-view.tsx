"use client";

import { useTranslations } from "next-intl";
import { Loader2, Coins } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent } from "@/components/ui/card";
import { useEntityTokens } from "@/hooks/use-observability";
import { formatTokens } from "@/lib/format-tokens";
import type { TokenUsage } from "@/services/observability.service";

interface TaskTokensViewProps {
  taskUuid: string;
  projectUuid: string;
}

function tokensSum(t: TokenUsage): number {
  return t.input_tokens + t.output_tokens + t.cache_creation_input_tokens + t.cache_read_input_tokens;
}

export function TaskTokensView({ taskUuid, projectUuid }: TaskTokensViewProps) {
  const t = useTranslations();
  const { data, isLoading, error } = useEntityTokens(projectUuid, "task", taskUuid);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-5 w-5 animate-spin text-[#C67A52]" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive">
        {t("observability.loadFailed")}
      </div>
    );
  }

  if (!data) {
    return (
      <p className="text-sm text-[#9A9A9A] italic">{t("observability.noData")}</p>
    );
  }

  const tu = data.sessionTokens;
  const total = tokensSum(tu);

  if (total === 0 && data.toolCallCount === 0) {
    return (
      <p className="text-sm text-[#9A9A9A] italic">{t("observability.noData")}</p>
    );
  }

  const splitRow = (label: string, value: number, colorClass: string) => (
    <div className="flex items-center justify-between">
      <span className="text-[11px] text-[#6B6B6B]">{label}</span>
      <span className={`text-xs font-semibold tabular-nums ${colorClass}`}>
        {formatTokens(value)}
      </span>
    </div>
  );

  return (
    <div className="space-y-4">
      {/* Summary */}
      <Card className="border-[#E5E2DC] shadow-none rounded-xl gap-0 py-0">
        <CardContent className="p-4">
          <div className="flex items-center gap-2 mb-3">
            <Coins className="h-4 w-4 text-[#C67A52]" />
            <span className="text-[11px] font-medium uppercase tracking-wide text-[#9A9A9A]">
              {t("observability.totalTokens")}
            </span>
          </div>
          <div className="text-2xl font-semibold text-[#2C2C2C]">
            {formatTokens(total)}
          </div>
          <div className="mt-3 grid grid-cols-2 gap-x-6 gap-y-1.5">
            {splitRow(t("observability.input"), tu.input_tokens, "text-[#2C2C2C]")}
            {splitRow(t("observability.output"), tu.output_tokens, "text-[#2C2C2C]")}
            {splitRow(
              t("observability.cacheRead"),
              tu.cache_read_input_tokens,
              "text-[#5A9E6F]"
            )}
            {splitRow(
              t("observability.cacheWrite"),
              tu.cache_creation_input_tokens,
              "text-[#1976D2]"
            )}
          </div>
        </CardContent>
      </Card>

      {/* Session info */}
      <div>
        <label className="text-[11px] font-medium uppercase tracking-wide text-[#9A9A9A]">
          {t("observability.sessionInfo")}
        </label>
        <Card className="mt-2 border-[#E5E2DC] shadow-none rounded-lg gap-0 py-0">
          <CardContent className="flex items-center justify-between p-3">
            <span className="text-xs text-[#6B6B6B]">
              {t("observability.sessions")}
            </span>
            <span className="text-xs font-medium text-[#2C2C2C]">
              {data.sessionCount}
            </span>
          </CardContent>
        </Card>
      </div>

      {/* Tool timeline */}
      <div>
        <div className="flex items-center justify-between">
          <label className="text-[11px] font-medium uppercase tracking-wide text-[#9A9A9A]">
            {t("observability.toolTimeline")}
          </label>
          <span className="text-[10px] text-[#9A9A9A]">
            {t("observability.toolCall", { count: data.toolCallCount })}
          </span>
        </div>
        {data.toolBreakdown.length === 0 ? (
          <p className="mt-2 text-sm italic text-[#9A9A9A]">
            {t("observability.noData")}
          </p>
        ) : (
          <div className="mt-2 space-y-1.5">
            {data.toolBreakdown.map((tool) => (
              <Card
                key={tool.toolName}
                className="border-[#E5E2DC] shadow-none rounded-lg gap-0 py-0"
              >
                <CardContent className="flex items-center justify-between p-3">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xs font-medium text-[#2C2C2C]">
                      {tool.toolName}
                    </div>
                    <div className="mt-0.5 flex items-center gap-2 text-[10px] text-[#9A9A9A]">
                      <span>
                        {t("observability.toolCall", { count: tool.callCount })}
                      </span>
                      {tool.errorCount > 0 && (
                        <Badge
                          variant="secondary"
                          className="bg-red-50 text-red-700 text-[10px]"
                        >
                          {t("observability.toolErrors", {
                            count: tool.errorCount,
                          })}
                        </Badge>
                      )}
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
