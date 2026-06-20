// Formatters + label helpers for the agent-presence rendering vocabulary.
//
// Presentational only — these hooks read i18n strings and format already-fetched
// values. They do NOT fetch data. They are shared by the pill, popover, modal,
// and the (soon-relocated) Agent Connections page so wording + formatting stay
// byte-identical across every surface.

import { useCallback, useEffect, useState } from "react";
import { useTranslations } from "next-intl";
import type { ExecutionView } from "@/contexts/realtime-context";

// 1s tick that drives the monospace HH:MM:SS uptime/elapsed displays. Returns a
// `nowMs` that updates every `intervalMs`. Shared by the popover and the modal
// view so there is one tick implementation; each caller mounts it only while its
// surface is open (the closed steady state has no interval). A single shared
// ticker per surface (not per row) keeps 100 rows from meaning 100 timers.
export function useNowTick(intervalMs = 1000) {
  const [nowMs, setNowMs] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return nowMs;
}

// Relative "last active" / "started" formatter — reuses the shared `time.*`
// i18n namespace already used elsewhere so wording stays consistent.
export function useRelativeTime() {
  const t = useTranslations("time");
  return useCallback(
    (dateStr: string, nowMs: number) => {
      const diffMs = nowMs - new Date(dateStr).getTime();
      const diffMinutes = Math.floor(diffMs / (1000 * 60));
      const diffHours = Math.floor(diffMs / (1000 * 60 * 60));
      const diffDays = Math.floor(diffMs / (1000 * 60 * 60 * 24));
      if (diffMinutes < 1) return t("justNow");
      if (diffMinutes < 60) return t("minutesAgo", { minutes: diffMinutes });
      if (diffHours < 24) return t("hoursAgo", { hours: diffHours });
      return t("daysAgo", { days: diffDays });
    },
    [t],
  );
}

// Pad an integer to two digits — used by the monospace HH:MM:SS uptime.
export function pad2(n: number) {
  return n < 10 ? `0${n}` : String(n);
}

// Monospace duration that ticks every second from an ISO start to `nowMs`. Days
// are split off into a localized `Dd ` prefix so the seconds-tick stays
// meaningful past 24h — `999:00:00` would lose its scannability. Returns a single
// string (no JSX), intentionally placed inside a font-mono span by the caller.
// Reduced-motion is honored the same way everywhere: the value is a plain ticking
// number, no animation; any decorative pulse is gated behind `motion-safe:` at
// the call site. Shared by both the connection uptime and the running-execution
// elapsed timer (they were byte-identical formatters).
export function useDurationMono() {
  const t = useTranslations("agentConnections");
  return useCallback(
    (fromIso: string, nowMs: number) => {
      const diffMs = Math.max(0, nowMs - new Date(fromIso).getTime());
      const totalSeconds = Math.floor(diffMs / 1000);
      const days = Math.floor(totalSeconds / 86_400);
      const hours = Math.floor((totalSeconds % 86_400) / 3600);
      const minutes = Math.floor((totalSeconds % 3600) / 60);
      const seconds = totalSeconds % 60;
      const hms = `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}`;
      if (days > 0) {
        // Localized day prefix + monospace HH:MM:SS so the second-by-second
        // tick is still visible after 24h.
        return t("uptimeMonoDays", { days, time: hms });
      }
      return hms;
    },
    [t],
  );
}

// Back-compat aliases — uptime (connection) and elapsed (running execution) are
// the same monospace duration, just named for their call sites. Both delegate to
// the single `useDurationMono` implementation so the format can never drift.
export const useUptimeMono = useDurationMono;
export const useElapsedMono = useDurationMono;

export function useClientTypeLabel() {
  const t = useTranslations("agentConnections");
  return useCallback(
    (clientType: string) => {
      switch (clientType) {
        case "claude_code":
          return t("clientClaudeCode");
        case "openclaw":
          return t("clientOpenclaw");
        default:
          return t("clientUnknown");
      }
    },
    [t],
  );
}

// Localized label for the resource kind, shown as a small badge so a user can
// tell at a glance whether the daemon is on a task, an idea, etc.
export function useEntityTypeLabel() {
  const t = useTranslations("agentConnections");
  return useCallback(
    (entityType: string) => {
      switch (entityType) {
        case "task":
          return t("entityTask");
        case "idea":
          return t("entityIdea");
        case "proposal":
          return t("entityProposal");
        case "document":
          return t("entityDocument");
        case "daemon_session":
          // An ad-hoc (non-idea) wake reports its execution as a `daemon_session`.
          // Label it as a conversation (not "Resource"); execHref returns null for
          // it, so no broken deep link — the conversation lives in this modal.
          return t("entityConversation");
        default:
          return t("entityUnknown");
      }
    },
    [t],
  );
}

// Build the in-app deep link for an execution's target resource, or null when it
// can't be linked (no projectUuid resolved, or an unknown entity type). Each
// resource kind routes to its canonical project-scoped surface.
export function execHref(exec: ExecutionView): string | null {
  if (!exec.projectUuid) return null;
  switch (exec.entityType) {
    case "task":
      return `/projects/${exec.projectUuid}/tasks/${exec.entityUuid}`;
    case "idea":
      // The standalone /ideas page was removed — ideas open in the Dashboard side
      // panel via `?panel=`. Link straight to the canonical address (same as
      // global-search) instead of `/ideas/{uuid}`, which would only 308-redirect.
      return `/projects/${exec.projectUuid}/dashboard?panel=${exec.entityUuid}`;
    case "proposal":
      return `/projects/${exec.projectUuid}/proposals/${exec.entityUuid}`;
    case "document":
      return `/projects/${exec.projectUuid}/documents/${exec.entityUuid}`;
    default:
      return null;
  }
}
