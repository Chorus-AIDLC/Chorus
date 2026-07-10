"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { CheckCircle2, XCircle, AlertTriangle, Info, ChevronDown, ChevronUp, ClipboardCheck } from "lucide-react";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import type { ValidationIssue, ValidationResult } from "@/services/proposal.service";

interface ProposalValidationChecklistProps {
  projectUuid: string;
  proposalUuid: string;
  status: string;
}

const levelIcons = {
  error: XCircle,
  warning: AlertTriangle,
  info: Info,
} as const;

const levelColors = {
  error: { icon: "text-red-500", bg: "bg-red-50", badge: "bg-red-100 text-red-700" },
  warning: { icon: "text-amber-500", bg: "bg-amber-50", badge: "bg-amber-100 text-amber-700" },
  info: { icon: "text-blue-500", bg: "bg-blue-50", badge: "bg-blue-100 text-blue-700" },
} as const;

export function ProposalValidationChecklist({ projectUuid, proposalUuid, status }: ProposalValidationChecklistProps) {
  const t = useTranslations("proposalValidation");
  const [result, setResult] = useState<ValidationResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    if (status !== "draft") return;

    let cancelled = false;

    async function fetchValidation() {
      try {
        setLoading(true);
        setError(null);
        const res = await fetch(`/api/projects/${projectUuid}/proposals/${proposalUuid}/validate`);
        if (!res.ok) {
          throw new Error(`HTTP ${res.status}`);
        }
        const json = await res.json();
        if (!cancelled) {
          setResult(json.data as ValidationResult);
        }
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : "Unknown error");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
        }
      }
    }

    fetchValidation();
    return () => { cancelled = true; };
  }, [projectUuid, proposalUuid, status]);

  if (status !== "draft") return null;

  if (loading) {
    return (
      <Card className="border-[#E5E2DC] dark:border-[#2a2a2e] shadow-none rounded-2xl gap-0 py-0">
        <div className="flex items-center justify-between px-5 py-3.5">
          <div className="flex items-center gap-2.5">
            <ClipboardCheck className="h-4 w-4 text-primary" />
            <span className="text-[13px] font-semibold text-foreground">{t("title")}</span>
          </div>
          <Skeleton className="h-5 w-20" />
        </div>
      </Card>
    );
  }

  if (error) {
    return (
      <Card className="border-red-200 shadow-none rounded-2xl gap-0 py-0">
        <div className="flex items-center justify-between px-5 py-3.5">
          <div className="flex items-center gap-2.5">
            <ClipboardCheck className="h-4 w-4 text-primary" />
            <span className="text-[13px] font-semibold text-foreground">{t("title")}</span>
          </div>
          <div className="flex items-center gap-1.5 text-xs text-red-600">
            <XCircle className="h-3.5 w-3.5" />
            <span>{error}</span>
          </div>
        </div>
      </Card>
    );
  }

  if (!result) return null;

  // Group issues by level
  const grouped: Record<"error" | "warning" | "info", ValidationIssue[]> = {
    error: [],
    warning: [],
    info: [],
  };
  for (const issue of result.issues) {
    grouped[issue.level].push(issue);
  }
  const orderedIssues = [...grouped.error, ...grouped.warning, ...grouped.info];
  const errorCount = grouped.error.length;
  const warningCount = grouped.warning.length;

  // Collapsed header bar
  const header = (
    <button
      type="button"
      onClick={() => setExpanded(!expanded)}
      className="flex w-full items-center justify-between px-5 py-3.5 cursor-pointer hover:bg-background transition-colors rounded-2xl"
    >
      <div className="flex items-center gap-2.5">
        <ClipboardCheck className="h-4 w-4 text-primary" />
        <span className="text-[13px] font-semibold text-foreground">{t("title")}</span>
      </div>
      <div className="flex items-center gap-2.5">
        {result.valid ? (
          <Badge className="border-0 bg-green-100 text-green-700 text-[11px] font-medium">
            <CheckCircle2 className="mr-1 h-3 w-3" />
            {t("passed")}
          </Badge>
        ) : (
          <>
            {errorCount > 0 && (
              <Badge className="border-0 bg-red-100 text-red-700 text-[11px] font-medium">
                <XCircle className="mr-1 h-3 w-3" />
                {t("errorCount", { count: errorCount })}
              </Badge>
            )}
            {warningCount > 0 && (
              <Badge className="border-0 bg-amber-100 text-amber-700 text-[11px] font-medium">
                <AlertTriangle className="mr-1 h-3 w-3" />
                {t("warningCount", { count: warningCount })}
              </Badge>
            )}
          </>
        )}
        {expanded ? (
          <ChevronUp className="h-4 w-4 text-muted-foreground" />
        ) : (
          <ChevronDown className="h-4 w-4 text-muted-foreground" />
        )}
      </div>
    </button>
  );

  return (
    <Card className="border-[#E5E2DC] dark:border-[#2a2a2e] shadow-none rounded-2xl gap-0 py-0 overflow-hidden">
      {header}
      {expanded && (
        <CardContent className="px-4 pb-4 pt-0">
          {orderedIssues.length === 0 ? (
            <div className="flex items-center gap-2 text-xs text-green-600 px-1 py-2">
              <CheckCircle2 className="h-4 w-4" />
              <span>{t("passed")}</span>
            </div>
          ) : (
            <div className="space-y-2">
              {orderedIssues.map((issue, index) => {
                const Icon = levelIcons[issue.level];
                const colors = levelColors[issue.level];
                return (
                  <div
                    key={`${issue.id}-${index}`}
                    className={`flex items-center gap-2.5 rounded-lg px-3 py-2.5 ${colors.bg}`}
                  >
                    <Icon className={`h-3.5 w-3.5 shrink-0 ${colors.icon}`} />
                    <span className="flex-1 min-w-0 text-xs text-foreground">
                      {issue.field ? t(issue.id, { title: issue.field }) : t(issue.id)}
                    </span>
                    <Badge className={`shrink-0 border-0 text-[10px] font-medium ${colors.badge}`}>
                      {t(issue.level)}
                    </Badge>
                  </div>
                );
              })}
            </div>
          )}
        </CardContent>
      )}
    </Card>
  );
}
