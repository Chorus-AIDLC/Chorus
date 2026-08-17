"use client";

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import { authFetch } from "@/lib/auth-client";
import { getAgentColor } from "@/lib/agent-color";
import { useAgentPresenceOptional } from "@/contexts/agent-presence-context";
import { AgentAvatar } from "@/components/ui/agent-avatar";
import { Button } from "@/components/ui/button";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";

interface FixedCwdPreference {
  agent: { uuid: string; name: string };
  preference: {
    host: string;
    cwd: string;
  } | null;
}

export function ProjectCwdSummary({ projectUuid }: { projectUuid: string }) {
  const t = useTranslations("fixedCwdAnchor");
  // Optional: the overview lives under the shell-level AgentPresenceProvider, but use the
  // non-throwing variant so the badge still renders (name + cwd tooltip) if it is ever
  // mounted outside a provider — clicking just no-ops there.
  const presence = useAgentPresenceOptional();
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
    <TooltipProvider>
      <div
        className="flex min-w-0 flex-wrap items-center gap-1.5"
        aria-label={t("title")}
      >
        {preferences.map(({ agent, preference }) => (
          // Each badge is led by a per-agent identity dot (getAgentColor hashes the agent
          // name into a light/dark-safe palette) + the visible agent name, so multiple
          // agents' badges are distinguishable at a glance. The cwd path — often sharing a
          // long common prefix across agents — shows in a real (immediate) tooltip on
          // hover/focus, and clicking the badge opens that agent's daemon chat.
          <Tooltip key={agent.uuid}>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                aria-label={t("openAgentChat", { agent: agent.name })}
                onClick={() =>
                  presence?.openChatForAgent(agent.uuid, {
                    host: preference!.host,
                    cwd: preference!.cwd,
                  })
                }
                className="inline-flex h-auto max-w-full items-center gap-1.5 rounded-md border border-border bg-card px-2 py-1 text-[11px] font-normal text-muted-foreground hover:bg-accent hover:text-accent-foreground"
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
              </Button>
            </TooltipTrigger>
            {/* Hover card: the agent's avatar alongside its (often long,
                common-prefixed) cwd, so the identity is unmistakable on hover —
                the compact trigger keeps its color dot + name. */}
            <TooltipContent side="bottom" className="flex items-center gap-2">
              <AgentAvatar name={agent.name} size="sm" className="rounded-md" />
              <span className="font-mono">{preference!.cwd}</span>
            </TooltipContent>
          </Tooltip>
        ))}
      </div>
    </TooltipProvider>
  );
}
