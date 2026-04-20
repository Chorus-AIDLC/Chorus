"use client";

import { useTranslations } from "next-intl";
import { Loader2, Coins, ChevronRight } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useIdeaLifecycleTokens } from "@/hooks/use-observability";
import { formatTokens } from "@/lib/format-tokens";
import type {
  LifecyclePhase,
  TokenUsage,
} from "@/services/observability.service";

interface TokensViewProps {
  ideaUuid: string;
  projectUuid: string;
  onSelectTask: (taskUuid: string) => void;
}

const PHASE_ORDER: LifecyclePhase[] = [
  "elaboration",
  "proposal",
  "review",
  "execution",
  "verify",
];

function tokensSum(t: TokenUsage): number {
  return (
    t.input_tokens +
    t.output_tokens +
    t.cache_creation_input_tokens +
    t.cache_read_input_tokens
  );
}

export function TokensView({ ideaUuid, projectUuid, onSelectTask }: TokensViewProps) {
  const t = useTranslations();
  const { data, isLoading, error } = useIdeaLifecycleTokens(projectUuid, ideaUuid);

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

  const total = tokensSum(data.totals.sessionTokens);

  if (total === 0 && data.totals.toolCallCount === 0) {
    return (
      <p className="text-sm text-[#9A9A9A] italic">{t("observability.noData")}</p>
    );
  }

  return (
    <div className="space-y-5">
      {/* Summary */}
      <Card className="border-[#E5E2DC] shadow-none rounded-xl gap-0 py-0">
        <CardContent className="p-4">
          <div className="flex items-center gap-2 mb-3">
            <Coins className="h-4 w-4 text-[#C67A52]" />
            <span className="text-[11px] font-medium uppercase tracking-wide text-[#9A9A9A]">
              {t("observability.totalTokens")}
            </span>
          </div>
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-semibold text-[#2C2C2C]">
              {formatTokens(total)}
            </span>
            <span className="text-xs text-[#9A9A9A]">
              {t("observability.outputTokens")} {formatTokens(data.totals.sessionTokens.output_tokens)}
            </span>
          </div>
          <div className="mt-3 flex items-center gap-4 text-[11px] text-[#6B6B6B]">
            <span>
              {t("observability.toolCalls")}:{" "}
              <span className="font-medium text-[#2C2C2C]">
                {data.totals.toolCallCount}
              </span>
            </span>
          </div>
        </CardContent>
      </Card>

      {/* Lifecycle rows */}
      <div>
        <label className="text-[11px] font-medium uppercase tracking-wide text-[#9A9A9A]">
          {t("observability.lifecycle")}
        </label>
        <div className="mt-2 space-y-1.5">
          {PHASE_ORDER.map((phase) => {
            const p = data.phases.find((x) => x.phase === phase);
            if (!p) return null;
            const phaseTotal = tokensSum(p.sessionTokens);
            if (phaseTotal === 0 && p.toolCallCount === 0) return null;
            return (
              <Card
                key={phase}
                className="border-[#E5E2DC] shadow-none rounded-lg gap-0 py-0"
              >
                <CardContent className="flex items-center justify-between p-3">
                  <div className="min-w-0">
                    <div className="text-xs font-medium text-[#2C2C2C]">
                      {t(`observability.phase.${phase}`)}
                    </div>
                    <div className="mt-0.5 flex items-center gap-2 text-[10px] text-[#9A9A9A]">
                      <span>
                        {t("observability.toolCall", { count: p.toolCallCount })}
                      </span>
                      {p.toolErrorCount > 0 && (
                        <Badge
                          variant="secondary"
                          className="bg-red-50 text-red-700 text-[10px]"
                        >
                          {t("observability.toolErrors", {
                            count: p.toolErrorCount,
                          })}
                        </Badge>
                      )}
                    </div>
                  </div>
                  <span className="text-sm font-semibold text-[#C67A52] tabular-nums">
                    {formatTokens(phaseTotal)}
                  </span>
                </CardContent>
              </Card>
            );
          })}
        </div>
      </div>

      {/* Per-task rollup */}
      <div>
        <label className="text-[11px] font-medium uppercase tracking-wide text-[#9A9A9A]">
          {t("observability.taskList")}
        </label>
        {data.tasks.length === 0 ? (
          <p className="mt-2 text-sm italic text-[#9A9A9A]">
            {t("observability.noTasks")}
          </p>
        ) : (
          <div className="mt-2 space-y-1.5">
            {data.tasks.map((task) => {
              const taskTotal = tokensSum(task.sessionTokens);
              return (
                <Button
                  key={task.taskUuid}
                  variant="ghost"
                  className="h-auto w-full justify-between rounded-lg border border-[#E5E2DC] bg-white p-3 hover:bg-[#FAF8F4]"
                  onClick={() => onSelectTask(task.taskUuid)}
                >
                  <div className="flex min-w-0 flex-1 items-center gap-2">
                    <Badge
                      variant="secondary"
                      className="shrink-0 text-[10px] bg-[#F5F2EC] text-[#6B6B6B]"
                    >
                      {task.status}
                    </Badge>
                    <span className="truncate text-xs text-[#2C2C2C]">
                      {task.title}
                    </span>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <span className="text-[10px] text-[#9A9A9A] tabular-nums">
                      {t("observability.toolCall", {
                        count: task.toolCallCount,
                      })}
                    </span>
                    <span className="text-xs font-semibold text-[#C67A52] tabular-nums">
                      {formatTokens(taskTotal)}
                    </span>
                    <ChevronRight className="h-3.5 w-3.5 text-[#9A9A9A]" />
                  </div>
                </Button>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
