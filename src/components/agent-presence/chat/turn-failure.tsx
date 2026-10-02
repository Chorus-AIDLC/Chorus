"use client";

import { useId, useState } from "react";
import { useTranslations } from "next-intl";
import { ChevronDown, ChevronUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { WakeError } from "@/lib/daemon-wake-error";

export function TurnFailure({
  reason,
  wakeError,
}: {
  reason: "crash" | "invalid_path";
  wakeError?: WakeError | null;
}) {
  const t = useTranslations("daemonChat");
  const id = useId();
  const [expanded, setExpanded] = useState(false);
  const diagnostic = wakeError?.message.trim() ? wakeError : null;
  const details = diagnostic?.details?.trim();
  const signal = diagnostic?.signal?.trim();
  const exitCode = diagnostic?.exitCode;
  const hasDetails = !!details || exitCode != null || !!signal;
  const Chevron = expanded ? ChevronUp : ChevronDown;

  return (
    <section
      aria-labelledby={`${id}-heading`}
      className="min-w-0 rounded-lg border border-destructive/25 bg-destructive/5 px-3 py-2.5"
    >
      <h3
        id={`${id}-heading`}
        className="text-[12px] font-semibold text-destructive"
      >
        {t("turnFailureTitle")}
      </h3>
      <p className="mt-1 whitespace-pre-wrap text-[12px] leading-relaxed text-foreground [overflow-wrap:anywhere]">
        {diagnostic?.message ??
          t(reason === "invalid_path" ? "turnFailureInvalidPath" : "turnFailureCrash")}
      </p>
      {hasDetails && (
        <>
          <Button
            id={`${id}-toggle`}
            type="button"
            variant="ghost"
            size="xs"
            className="mt-2 h-auto max-w-full justify-start whitespace-normal py-1 text-left text-muted-foreground [overflow-wrap:anywhere]"
            aria-expanded={expanded}
            aria-controls={`${id}-details`}
            onClick={() => setExpanded((value) => !value)}
          >
            <Chevron aria-hidden />
            {t(expanded ? "turnFailureHideDetails" : "turnFailureShowDetails")}
          </Button>
          {expanded && (
            <div
              id={`${id}-details`}
              role="region"
              aria-labelledby={`${id}-toggle`}
              tabIndex={0}
              className="mt-2 max-h-64 min-w-0 overflow-y-auto rounded-md border border-border bg-muted p-3 text-[11px] leading-relaxed text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [overflow-wrap:anywhere]"
            >
              {exitCode != null && <p>{t("turnFailureExitCode", { code: exitCode })}</p>}
              {signal && <p>{t("turnFailureSignal", { signal })}</p>}
              {details && (
                <pre className="whitespace-pre-wrap font-mono [overflow-wrap:anywhere]">
                  {details}
                </pre>
              )}
            </div>
          )}
        </>
      )}
    </section>
  );
}
