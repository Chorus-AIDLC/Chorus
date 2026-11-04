"use client";

import { useTranslations } from "next-intl";
import { InterruptButton, ResumeButton, type InterruptTarget } from "./execution-row";
import type { ExecutionView } from "./types";

export function ConversationExecutionControl({
  execution,
  stuckTurnTarget,
}: {
  execution?: ExecutionView | null;
  stuckTurnTarget?: InterruptTarget | null;
}) {
  const t = useTranslations("agentConnections");
  if (stuckTurnTarget) return <InterruptButton target={stuckTurnTarget} variant="stuckTurn" />;
  if (execution?.status === "running") return <InterruptButton target={execution} />;
  if (execution?.status !== "interrupted") return null;
  if (execution.interruptedReason === "user") return <ResumeButton exec={execution} />;
  if (execution.interruptedReason !== "crash") return null;
  return (
    <>
      <span className="text-[11px] font-medium text-[#B45309] dark:text-[#E0A34E]">
        {t("execCrashExited")}
      </span>
      <ResumeButton exec={execution} />
    </>
  );
}
