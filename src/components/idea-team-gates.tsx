"use client";

import { useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { ShieldCheck } from "lucide-react";
import type { IdeaTeamContextDto } from "@/types/idea-team";

type GateSummary = Pick<IdeaTeamContextDto, "managed" | "state" | "lead" | "yolo" | "proposalGate" | "taskGate" | "reason">;

export function IdeaTeamGates({ ideaUuid, revision }: { ideaUuid: string; revision?: string }) {
  const translate = useTranslations("ideaTeamGates");
  const [loaded, setLoaded] = useState<{ ideaUuid: string; data: GateSummary } | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    let controller: AbortController | undefined;
    const refresh = async () => {
      controller?.abort();
      const requestController = new AbortController();
      controller = requestController;
      try {
        const response = await fetch(`/api/ideas/${ideaUuid}/team-context`, { signal: requestController.signal, cache: "no-store" });
        const body = await response.json();
        if (!response.ok || !body.success) throw new Error("Team context unavailable");
        if (active && !requestController.signal.aborted) {
          setLoaded({ ideaUuid, data: body.data });
          setFailed(false);
        }
      } catch (error) {
        if (active && !requestController.signal.aborted && !(error instanceof Error && error.name === "AbortError")) setFailed(true);
      }
    };
    void refresh();
    const onFocus = () => { void refresh(); };
    window.addEventListener("focus", onFocus);
    const timer = window.setInterval(onFocus, 30000);
    return () => {
      active = false;
      controller?.abort();
      window.removeEventListener("focus", onFocus);
      window.clearInterval(timer);
    };
  }, [ideaUuid, revision]);

  const context = loaded?.ideaUuid === ideaUuid ? loaded.data : null;
  const leadName = context?.lead?.agentName ?? translate("unavailableLead");
  const gateLabel = (gate: "human" | "lead") => gate === "human" ? translate("human") : leadName;
  const pauseReason = context?.reason === "team_unbound" ? translate("teamUnbound")
    : context?.reason === "lead_ineligible" ? translate("leadIneligible")
      : context?.reason === "lead_not_assignee" ? translate("leadNotAssignee") : null;

  return (
    <section aria-label={translate("title")} className="mt-4 rounded-lg border border-border bg-muted/30 p-3 text-xs text-foreground">
      <h3 className="flex items-center gap-1.5 font-semibold"><ShieldCheck className="h-3.5 w-3.5" />{translate("title")}</h3>
      {failed ? <p role="status" className="mt-2 text-muted-foreground">{translate("error")}</p> : !context ? (
        <p role="status" className="mt-2 text-muted-foreground">{translate("loading")}</p>
      ) : !context.managed ? (
        <p className="mt-2 text-muted-foreground">{translate("unmanaged")}</p>
      ) : (
        <div className="mt-2 space-y-1.5">
          <p>{translate("lead", { name: leadName })}</p>
          <p>{translate("proposal", { name: gateLabel(context.proposalGate) })}</p>
          <p>{translate("task", { name: gateLabel(context.taskGate) })}</p>
          <p className="text-muted-foreground">{translate(context.yolo ? "yolo" : "nonYolo")}</p>
          {context.state === "paused" && <p role="status" className="font-medium text-amber-700 dark:text-amber-400">{translate("paused")}</p>}
          {context.state === "paused" && pauseReason && <p className="text-muted-foreground">{pauseReason}</p>}
        </div>
      )}
    </section>
  );
}
