"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { authFetch } from "@/lib/auth-client";
import { getAgentColor } from "@/lib/agent-color";

interface FixedCwdPreference {
  agent: { uuid: string; name: string };
  preference: {
    cwd: string;
  } | null;
}

export function ProjectCwdSummary({ projectUuid }: { projectUuid: string }) {
  const t = useTranslations("fixedCwdAnchor");
  const [preferences, setPreferences] = useState<FixedCwdPreference[]>([]);

  const load = useCallback(async () => {
    const response = await authFetch(
      `/api/projects/${encodeURIComponent(projectUuid)}/agent-cwds`,
    );
    if (!response.ok) return;
    const json = await response.json();
    setPreferences(
      (json?.data?.agents ?? []).filter(
        (item: FixedCwdPreference) => item.preference?.cwd,
      ),
    );
  }, [projectUuid]);

  useEffect(() => {
    let cancelled = false;
    const reload = (event: Event) => {
      const detail = (event as CustomEvent<{ projectUuid?: string }>).detail;
      if (detail?.projectUuid === projectUuid) {
        void load().catch(() => setPreferences([]));
      }
    };
    void load()
      .catch(() => {
        if (!cancelled) setPreferences([]);
      });
    window.addEventListener("project-cwd-updated", reload);
    return () => {
      cancelled = true;
      window.removeEventListener("project-cwd-updated", reload);
    };
  }, [load, projectUuid]);

  if (preferences.length === 0) return null;

  return (
    <div
      className="flex min-w-0 flex-wrap items-center gap-1.5"
      aria-label={t("title")}
    >
      {preferences.map(({ agent, preference }) => (
        // Each badge is led by a per-agent identity dot (getAgentColor hashes the
        // agent name into a light/dark-safe palette) + the visible agent name, so
        // multiple agents' badges are distinguishable at a glance. The cwd path —
        // often sharing a long common prefix across agents — moves into the tooltip.
        <span
          key={agent.uuid}
          className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-border bg-card px-2 py-1 text-[11px] text-muted-foreground"
          title={preference!.cwd}
        >
          <span
            data-testid="cwd-agent-dot"
            className="size-2 shrink-0 rounded-full"
            style={{ backgroundColor: getAgentColor(agent.name) }}
            aria-hidden
          />
          <span className="max-w-[min(12rem,50vw)] truncate font-medium text-foreground">
            {agent.name}
          </span>
        </span>
      ))}
    </div>
  );
}
