"use client";

import { useEffect, useState } from "react";
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

  useEffect(() => {
    let cancelled = false;
    authFetch(`/api/projects/${encodeURIComponent(projectUuid)}/agent-cwds`)
      .then(async (response) => {
        if (!response.ok) return;
        const json = await response.json();
        if (!cancelled) {
          setPreferences(
            (json?.data?.agents ?? []).filter(
              (item: FixedCwdPreference) => item.preference?.cwd,
            ),
          );
        }
      })
      .catch(() => {
        if (!cancelled) setPreferences([]);
      });
    return () => {
      cancelled = true;
    };
  }, [projectUuid]);

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
