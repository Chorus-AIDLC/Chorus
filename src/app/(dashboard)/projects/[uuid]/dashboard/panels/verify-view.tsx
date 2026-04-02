"use client";

import { useState, useEffect } from "react";
import { useTranslations } from "next-intl";
import { Loader2, CircleCheck, CircleX, Timer, AlertTriangle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { ScrollArea } from "@/components/ui/scroll-area";
import { getVerifyViewDataAction, type VerifyViewData } from "./actions";

// Status colors
const statusColors: Record<string, string> = {
  open: "bg-[#FFF3E0] text-[#E65100]",
  assigned: "bg-[#E3F2FD] text-[#1976D2]",
  in_progress: "bg-[#E8F5E9] text-[#5A9E6F]",
  to_verify: "bg-[#F3E5F5] text-[#7B1FA2]",
  done: "bg-[#E0F2F1] text-[#00796B]",
  closed: "bg-[#F5F5F5] text-[#9A9A9A]",
};

const statusI18nKeys: Record<string, string> = {
  open: "status.open",
  assigned: "status.assigned",
  in_progress: "status.inProgress",
  to_verify: "status.toVerify",
  done: "status.done",
  closed: "status.closed",
};

function CriterionStatusIcon({ status }: { status: string }) {
  if (status === "passed") return <CircleCheck className="h-4 w-4 text-green-600" />;
  if (status === "failed") return <CircleX className="h-4 w-4 text-red-600" />;
  return <Timer className="h-4 w-4 text-[#9A9A9A]" />;
}

interface VerifyViewProps {
  ideaUuid: string;
  projectUuid: string;
}

export function VerifyView({ ideaUuid, projectUuid }: VerifyViewProps) {
  const t = useTranslations();
  const [data, setData] = useState<VerifyViewData | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      setIsLoading(true);
      setError(null);
      const result = await getVerifyViewDataAction(ideaUuid, projectUuid);
      if (result.success && result.data) {
        setData(result.data);
      } else {
        setError(result.error || t("common.genericError"));
      }
      setIsLoading(false);
    }
    load();
  }, [ideaUuid, projectUuid, t]);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-5 w-5 animate-spin text-[#9A9A9A]" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="flex items-center gap-2 text-sm text-red-600">
          <AlertTriangle className="h-4 w-4" />
          <span>{error}</span>
        </div>
      </div>
    );
  }

  if (!data || data.tasks.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center py-12 text-center">
        <Timer className="h-8 w-8 text-[#E5E0D8] mb-3" />
        <p className="text-sm text-[#9A9A9A]">{t("panel.verify.noTasks")}</p>
      </div>
    );
  }

  const progressPercent =
    data.overallProgress.total > 0
      ? Math.round((data.overallProgress.verified / data.overallProgress.total) * 100)
      : 0;

  return (
    <ScrollArea className="h-full">
      <div className="space-y-5 p-1">
        {/* Overall Progress */}
        <div>
          <div className="flex items-center justify-between mb-2">
            <span className="text-[11px] font-medium uppercase tracking-wide text-[#9A9A9A]">
              {t("panel.verify.overallProgress")}
            </span>
            <span className="text-xs text-[#6B6B6B]">
              {t("acceptanceCriteria.progress", {
                passed: data.overallProgress.verified,
                total: data.overallProgress.total,
              })}
            </span>
          </div>
          <Progress value={progressPercent} className="h-2" />
          <div className="mt-1 text-right text-[10px] text-[#9A9A9A]">
            {progressPercent}%
          </div>
        </div>

        {/* Task List */}
        <div className="space-y-3">
          {data.tasks.map((task) => (
            <Card key={task.uuid} className="p-4 border-[#E5E0D8]">
              {/* Task Header */}
              <div className="flex items-center gap-2 mb-3">
                <Badge className={`text-[10px] ${statusColors[task.status] || ""}`}>
                  {t(statusI18nKeys[task.status] || task.status)}
                </Badge>
                <span className="text-sm font-medium text-[#2C2C2C] truncate">
                  {task.title}
                </span>
              </div>

              {/* Task Progress */}
              {task.acceptanceSummary.total > 0 && (
                <div className="mb-3">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-[10px] text-[#9A9A9A]">
                      {t("acceptanceCriteria.progress", {
                        passed: task.acceptanceSummary.passed,
                        total: task.acceptanceSummary.total,
                      })}
                    </span>
                  </div>
                  <Progress
                    value={
                      task.acceptanceSummary.total > 0
                        ? (task.acceptanceSummary.passed / task.acceptanceSummary.total) * 100
                        : 0
                    }
                    className="h-1.5"
                  />
                </div>
              )}

              {/* Acceptance Criteria List */}
              {task.acceptanceCriteriaItems.length > 0 ? (
                <div className="space-y-1.5">
                  {task.acceptanceCriteriaItems.map((item) => (
                    <div
                      key={item.uuid}
                      className="flex items-start gap-2 rounded-md bg-[#FAF8F4] px-2.5 py-2"
                    >
                      <div className="mt-0.5 shrink-0">
                        <CriterionStatusIcon status={item.status} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <span className="text-xs text-[#2C2C2C] leading-snug">
                          {item.description}
                        </span>
                        {item.required && (
                          <Badge variant="outline" className="ml-1.5 text-[9px] py-0 align-middle">
                            {t("acceptanceCriteria.required")}
                          </Badge>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="text-xs text-[#9A9A9A] italic">
                  {t("acceptanceCriteria.noItems")}
                </p>
              )}
            </Card>
          ))}
        </div>
      </div>
    </ScrollArea>
  );
}
