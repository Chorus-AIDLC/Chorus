"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { ShieldCheck } from "lucide-react";
import type { IdeaTeamContextDto } from "@/types/idea-team";

type GateSummary = Omit<IdeaTeamContextDto, "routing" | "ideaUuid">;

const PAUSE_REASONS: Record<string, string> = {
  orchestrator_ineligible: "orchestratorIneligible",
};

// Compact gate summary. Renders nothing for unmanaged Ideas — the normal
// assignee display already covers them; server-side gates apply regardless.
export function IdeaTeamGates({ ideaUuid, revision, className }: { ideaUuid: string; revision?: string; className?: string }) {
  const t = useTranslations("ideaTeamGates");
  const [loaded, setLoaded] = useState<{ ideaUuid: string; data: GateSummary } | null>(null);

  // Silent refresh on focus / every 30s so external reassignment, unbinding or
  // pausing never leaves a stale gate on screen. A failed refresh hides it.
  useEffect(() => {
    let controller: AbortController | undefined;
    const refresh = () => {
      controller?.abort();
      const current = new AbortController();
      controller = current;
      fetch(`/api/ideas/${ideaUuid}/team-context`, { signal: current.signal, cache: "no-store" })
        .then((response) => response.json())
        .then((body) => {
          if (!current.signal.aborted) setLoaded(body?.success ? { ideaUuid, data: body.data } : null);
        })
        .catch((error: unknown) => {
          if (!current.signal.aborted && !(error instanceof Error && error.name === "AbortError")) setLoaded(null);
        });
    };
    refresh();
    window.addEventListener("focus", refresh);
    const timer = window.setInterval(refresh, 30000);
    return () => {
      controller?.abort();
      window.removeEventListener("focus", refresh);
      window.clearInterval(timer);
    };
  }, [ideaUuid, revision]);

  const context = loaded?.ideaUuid === ideaUuid ? loaded.data : null;
  if (!context?.managed) return null;

  const assigneeName = context.orchestrator?.agentName ?? t("unavailableLead");
  const gateLabel = (gate: "human" | "orchestrator") => (gate === "human" ? t("human") : assigneeName);
  const pauseReason = context.reason && PAUSE_REASONS[context.reason];

  return (
    <section aria-label={t("title")} className={`mt-4 rounded-lg border border-border bg-muted/30 p-3 text-xs text-foreground ${className ?? ""}`}>
      <h3 className="flex items-center gap-1.5 font-semibold"><ShieldCheck className="h-3.5 w-3.5" />{t("title")}</h3>
      <div className="mt-2 space-y-1">
        <p>{t("proposal", { name: gateLabel(context.proposalGate) })}</p>
        <p>{t("task", { name: gateLabel(context.taskGate) })}</p>
        {context.state === "paused" && (
          <p role="status" className="font-medium text-amber-700 dark:text-amber-400">
            {t("paused")}{pauseReason ? ` ${t(pauseReason)}` : ""}
          </p>
        )}
      </div>
    </section>
  );
}
