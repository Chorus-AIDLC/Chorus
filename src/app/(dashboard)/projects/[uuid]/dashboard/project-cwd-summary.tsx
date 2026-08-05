"use client";

import { useCallback, useEffect, useState } from "react";
import { FolderLock } from "lucide-react";
import { useTranslations } from "next-intl";
import { authFetch } from "@/lib/auth-client";

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
        <span
          key={agent.uuid}
          className="inline-flex max-w-full items-center gap-1.5 rounded-md border border-border bg-card px-2 py-1 text-[11px] text-muted-foreground"
          title={`${agent.name}: ${preference!.cwd}`}
        >
          <FolderLock className="size-3.5 shrink-0 text-primary" aria-hidden />
          <span className="max-w-[min(18rem,65vw)] truncate font-mono">
            {preference!.cwd}
          </span>
        </span>
      ))}
    </div>
  );
}
