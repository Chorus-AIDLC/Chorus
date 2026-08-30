"use client";

import { useEffect, useRef, useState } from "react";
import { useTranslations } from "next-intl";

import { AgentAvatar } from "@/components/ui/agent-avatar";
import { Button } from "@/components/ui/button";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import type { ActiveIdeaSession } from "@/contexts/agent-presence-context";
import { cn } from "@/lib/utils";

interface ActiveSessionIndicatorProps {
  sessions: readonly ActiveIdeaSession[];
  onSelect: (session: ActiveIdeaSession) => void;
  surface: "tracker" | "graph" | "sidebar";
  className?: string;
}

function sessionIdentity(session: ActiveIdeaSession): string {
  return session.agentName ?? session.agentUuid;
}

export function ActiveSessionIndicator({
  sessions,
  onSelect,
  surface,
  className,
}: ActiveSessionIndicatorProps) {
  const t = useTranslations("activeSessions");
  const [open, setOpen] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (closeTimer.current !== null) clearTimeout(closeTimer.current);
    },
    [],
  );

  if (sessions.length === 0) return null;
  const hasOpenableSession = sessions.some((session) => session.canOpen);
  const leadSession = sessions[0];
  const avatarSize = surface === "graph" ? 22 : 20;

  const cancelClose = () => {
    if (closeTimer.current !== null) {
      clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
  };
  const scheduleClose = () => {
    cancelClose();
    closeTimer.current = setTimeout(() => setOpen(false), 120);
  };
  const select = (session: ActiveIdeaSession) => {
    if (!session.canOpen) return;
    setOpen(false);
    onSelect(session);
  };

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="outline"
          size={surface === "tracker" ? "xs" : "icon-sm"}
          data-testid={`${surface}-active-session-indicator`}
          aria-label={t(
            hasOpenableSession ? "indicatorLabel" : "statusOnlyIndicatorLabel",
            { count: sessions.length },
          )}
          aria-disabled={!hasOpenableSession}
          aria-haspopup={sessions.length > 1 ? "dialog" : undefined}
          onPointerDown={(event) => event.stopPropagation()}
          onPointerEnter={() => {
            cancelClose();
            setOpen(true);
          }}
          onPointerLeave={scheduleClose}
          onFocus={() => setOpen(true)}
          onClick={(event) => {
            event.stopPropagation();
            if (sessions.length === 1 && sessions[0].canOpen) {
              event.preventDefault();
              select(sessions[0]);
            }
          }}
          onKeyDown={(event) => event.stopPropagation()}
          className={cn(
            "group/active relative gap-1.5 overflow-visible border-emerald-500/35 bg-emerald-500/10 font-semibold text-emerald-700 shadow-none transition-[background-color,border-color,box-shadow] hover:border-emerald-500/60 hover:bg-emerald-500/15 hover:text-emerald-700 hover:shadow-[0_3px_10px_-5px_rgba(16,185,129,0.8)] focus-visible:border-emerald-500 focus-visible:ring-emerald-500/50 dark:border-emerald-500/35 dark:bg-emerald-500/10 dark:text-emerald-300 dark:hover:border-emerald-500/60 dark:hover:bg-emerald-500/15 dark:hover:text-emerald-300",
            surface === "tracker"
              ? "h-7 min-w-7 px-1 text-[11px]"
              : surface === "sidebar"
                ? "h-8 min-w-8 px-1 text-[11px]"
                : "h-9 min-w-9 px-1 text-[11px] shadow-sm",
            className,
          )}
        >
          <span className="relative shrink-0" aria-hidden>
            <AgentAvatar
              name={sessionIdentity(leadSession)}
              size={avatarSize}
              className="rounded-full ring-1 ring-emerald-600/25"
            />
            <span className="absolute -bottom-0.5 -right-0.5 size-2 rounded-full border-2 border-card bg-emerald-500" />
            <span className="absolute -bottom-0.5 -right-0.5 size-2 rounded-full bg-emerald-400/75 motion-safe:animate-ping motion-reduce:animate-none" />
          </span>
          {sessions.length > 1 && <span>{sessions.length}</span>}
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        sideOffset={6}
        onPointerDown={(event) => event.stopPropagation()}
        onPointerEnter={cancelClose}
        onPointerLeave={scheduleClose}
        onClick={(event) => event.stopPropagation()}
        className="w-[min(22rem,calc(100vw-2rem))] p-1.5"
        aria-label={t("chooserLabel")}
      >
        <p className="px-2 pb-1.5 pt-1 text-xs font-medium text-muted-foreground">
          {t("runningCount", { count: sessions.length })}
        </p>
        <div className="max-h-64 overflow-y-auto">
          {sessions.map((session) => (
            <Button
              key={session.sessionUuid}
              type="button"
              variant="ghost"
              disabled={!session.canOpen}
              aria-label={
                session.canOpen
                  ? sessionIdentity(session)
                  : t("statusOnlyEntry", { agent: sessionIdentity(session) })
              }
              onClick={() => select(session)}
              className="group/session h-auto w-full min-w-0 items-start justify-start gap-2.5 whitespace-normal px-2 py-2 text-left disabled:cursor-not-allowed disabled:opacity-65"
            >
              <span className="relative mt-0.5 shrink-0" aria-hidden>
                <AgentAvatar
                  name={sessionIdentity(session)}
                  size={30}
                  className="rounded-lg ring-1 ring-border transition-shadow group-hover/session:ring-emerald-500/45"
                />
                <span className="absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full border-2 border-card bg-emerald-500" />
              </span>
              <span className="min-w-0">
                <span className="block truncate text-xs font-medium text-foreground">
                  {sessionIdentity(session)}
                </span>
                <span className="block truncate text-[11px] text-muted-foreground">
                  {session.connectionAvailable
                    ? t("location", {
                        host: session.host ?? t("unknownHost"),
                        cwd: session.cwd ?? t("unknownCwd"),
                      })
                    : t("agentFallback")}
                </span>
                {!session.canOpen && (
                  <span className="block text-[11px] font-medium text-muted-foreground">
                    {t("statusOnly")}
                  </span>
                )}
              </span>
            </Button>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}
