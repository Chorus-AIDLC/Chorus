"use client";

// Agent Connections — master-detail observation deck.
//
// Identity inversion: every surface leads with the owning agent's display name
// (`agentName` from the read API) and demotes the client type to a small badge.
// Two connections that share a client type but belong to different agents must
// stay distinguishable, so the agent name wins as primary identity everywhere.
//
// Layout: a single client component renders BOTH compositions off the same
// dataset and formatters; only Tailwind breakpoints switch between them.
//   - lg+ : two-pane master-detail (rail + detail panel).
//   - < lg: mobile list + drill-down detail; selection state is a normal piece
//           of client state, no separate route.
//
// Liveness intervals (both clear on unmount):
//   - 15s POLL_INTERVAL_MS — refreshes the dataset so online↔offline flips
//     surface without a manual reload.
//   - 1s  UPTIME_TICK_MS  — drives the monospace `HH:MM:SS` uptime ticker for
//     ONLINE connections only. Offline connections show no uptime row at all
//     (now - connectedAt for a stopped daemon would grow forever, which is
//     misleading — this carries forward the shipped uptime bug fix).
//
// Pulse animation is gated behind Tailwind's `motion-safe:` variant so it
// degrades to a static dot under `prefers-reduced-motion`.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import Link from "next/link";
import {
  Bot,
  Clock3,
  ChevronLeft,
  ExternalLink,
  ListChecks,
  Loader2,
  Play,
  RadioTower,
  Sparkles,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { authFetch } from "@/lib/auth-client";
import { clientLogger } from "@/lib/logger-client";
import {
  RealtimeProvider,
  useExecutionSubscription,
  type ExecutionView,
} from "@/contexts/realtime-context";

// Shape returned by GET /api/agent-connections (see daemon-connection.service.ts → ConnectionView).
interface ConnectionView {
  uuid: string;
  agentUuid: string;
  agentName: string | null;
  clientType: string;
  clientVersion: string | null;
  host: string; // "" when host-less
  startedAt: string | null;
  status: string;
  effectiveStatus: "online" | "offline";
  connectedAt: string;
  lastSeenAt: string;
  disconnectedAt: string | null;
}

const POLL_INTERVAL_MS = 15_000;
const UPTIME_TICK_MS = 1_000;

// =====================================================================
// Formatters (shared by desktop + mobile compositions)
// =====================================================================

// Relative "last active" / "started" formatter — reuses the shared `time.*`
// i18n namespace already used elsewhere so wording stays consistent.
function useRelativeTime() {
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
function pad2(n: number) {
  return n < 10 ? `0${n}` : String(n);
}

// Monospace uptime that ticks every second. Days are split off into a
// localized `Dd ` prefix so the seconds-tick stays meaningful past 24h —
// `999:00:00` would lose its scannability. Returns a single string (no JSX),
// which is intentionally placed inside a font-mono span by the caller.
function useUptimeMono() {
  const t = useTranslations("agentConnections");
  return useCallback(
    (connectedAt: string, nowMs: number) => {
      const diffMs = Math.max(0, nowMs - new Date(connectedAt).getTime());
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

// Monospace elapsed timer for a RUNNING execution row, ticking every second off
// the same shared `nowMs` the uptime ticker uses. Returns a single string (no
// JSX). Mirrors useUptimeMono — past 24h a localized `Dd ` prefix keeps the
// second-by-second tick scannable. Reduced-motion is honored the same way the
// uptime is: the value is a plain ticking number, no animation; any decorative
// pulse around it is gated behind `motion-safe:` at the call site.
function useElapsedMono() {
  const t = useTranslations("agentConnections");
  return useCallback(
    (startedAt: string, nowMs: number) => {
      const diffMs = Math.max(0, nowMs - new Date(startedAt).getTime());
      const totalSeconds = Math.floor(diffMs / 1000);
      const days = Math.floor(totalSeconds / 86_400);
      const hours = Math.floor((totalSeconds % 86_400) / 3600);
      const minutes = Math.floor((totalSeconds % 3600) / 60);
      const seconds = totalSeconds % 60;
      const hms = `${pad2(hours)}:${pad2(minutes)}:${pad2(seconds)}`;
      if (days > 0) {
        return t("uptimeMonoDays", { days, time: hms });
      }
      return hms;
    },
    [t],
  );
}

function useClientTypeLabel() {
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

// =====================================================================
// Shared sub-components
// =====================================================================

// Pulsing online dot — green core with a translucent halo that animates only
// under `motion-safe:`. Offline renders as a flat grey dot, no halo.
function StatusDot({
  online,
  size = "sm",
}: {
  online: boolean;
  size?: "sm" | "md";
}) {
  const halo = size === "md" ? "h-2.5 w-2.5" : "h-2 w-2";
  const core = size === "md" ? "h-1.5 w-1.5" : "h-1 w-1";
  if (!online) {
    return (
      <span
        aria-hidden
        className={`${halo} rounded-full bg-[#9A9A9A] opacity-60`}
      />
    );
  }
  return (
    <span aria-hidden className={`relative inline-flex ${halo} items-center justify-center`}>
      <span
        className={`absolute inline-flex h-full w-full rounded-full bg-[#22C55E] opacity-30 motion-safe:animate-ping`}
      />
      <span className={`relative inline-flex ${core} rounded-full bg-[#22C55E]`} />
    </span>
  );
}

function StatusBadge({ online }: { online: boolean }) {
  const t = useTranslations("agentConnections");
  return (
    <Badge
      className={`gap-1.5 rounded-full border-0 px-2.5 py-1 text-[11px] font-semibold tracking-wide ${
        online ? "bg-[#DCFCE7] text-[#15803D]" : "bg-[#F0EDE8] text-[#6B6B6B]"
      }`}
    >
      <StatusDot online={online} />
      {(online ? t("statusOnline") : t("statusOffline")).toUpperCase()}
    </Badge>
  );
}

// Identity tile (icon-on-tinted-square + agent name + clientType badge + version·host subline).
// Used by desktop detail header AND mobile list cards / mobile detail screen,
// just at slightly different sizes via `size`.
function IdentityBlock({
  connection,
  size,
}: {
  connection: ConnectionView;
  size: "sm" | "md" | "lg";
}) {
  const t = useTranslations("agentConnections");
  const clientTypeLabel = useClientTypeLabel();
  const online = connection.effectiveStatus === "online";

  // Icon: bot for online (active agent), clock for offline (paused/stopped).
  const Icon = online ? Bot : Clock3;
  const iconColor = online ? "#C67A52" : "#9A9A9A";
  const tileColor = online ? "#C67A5214" : "#9A9A9A14";

  const tileSize = size === "lg" ? "h-12 w-12" : size === "md" ? "h-10 w-10" : "h-9 w-9";
  const iconSize = size === "lg" ? "h-6 w-6" : size === "md" ? "h-5 w-5" : "h-4 w-4";
  const tileRadius = size === "lg" ? "rounded-xl" : "rounded-lg";
  const nameSize = size === "lg" ? "text-[20px]" : size === "md" ? "text-[16px]" : "text-[14px]";

  const agentName = connection.agentName?.trim() || t("unknownAgent");
  const version = connection.clientVersion ?? t("versionUnknown");
  const host = connection.host === "" ? t("hostUnknown") : connection.host;

  return (
    <div className="flex min-w-0 items-center gap-3">
      <div
        className={`${tileSize} ${tileRadius} flex shrink-0 items-center justify-center`}
        style={{ backgroundColor: tileColor }}
      >
        <Icon className={iconSize} style={{ color: iconColor }} />
      </div>
      <div className="min-w-0 flex-1">
        <div className={`truncate font-semibold text-[#2C2C2C] ${nameSize}`}>
          {agentName}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1">
          <Badge
            variant="secondary"
            className="shrink-0 border-0 bg-[#F0EDE8] px-2 py-0.5 text-[10px] font-medium text-[#6B6B6B]"
          >
            {clientTypeLabel(connection.clientType)}
          </Badge>
          <span className="truncate font-mono text-[11px] text-[#9A9A9A]">
            v{version} · {host}
          </span>
        </div>
      </div>
    </div>
  );
}

// One labeled stat tile — used in both the desktop 2x2 grid and mobile detail.
function StatTile({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="rounded-xl border border-[#E5E0D8] bg-white p-4">
      <div className="text-[11px] font-medium uppercase tracking-wide text-[#9A9A9A]">
        {label}
      </div>
      <div
        className={`mt-1.5 truncate text-[15px] font-medium text-[#2C2C2C] ${mono ? "font-mono" : ""}`}
      >
        {value}
      </div>
    </div>
  );
}

// =====================================================================
// Execution view — running + queued tasks for the selected connection
// =====================================================================

// Build the in-app deep link for an execution's target resource, or null when it
// can't be linked (no projectUuid resolved, or an unknown entity type). Each
// resource kind routes to its canonical project-scoped surface.
function execHref(exec: ExecutionView): string | null {
  if (!exec.projectUuid) return null;
  switch (exec.entityType) {
    case "task":
      return `/projects/${exec.projectUuid}/tasks/${exec.entityUuid}`;
    case "idea":
      return `/projects/${exec.projectUuid}/ideas/${exec.entityUuid}`;
    case "proposal":
      return `/projects/${exec.projectUuid}/proposals/${exec.entityUuid}`;
    case "document":
      return `/projects/${exec.projectUuid}/documents/${exec.entityUuid}`;
    default:
      return null;
  }
}

// Localized label for the resource kind, shown as a small badge so a user can
// tell at a glance whether the daemon is on a task, an idea, etc.
function useEntityTypeLabel() {
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
        default:
          return t("entityUnknown");
      }
    },
    [t],
  );
}

// One execution row: the target resource's title (deep-linked per resource kind),
// a small resource-kind badge, an optional root-idea session badge, and (for
// running rows only) a live HH:MM:SS elapsed indicator off `startedAt`. Queued
// rows show a static "waiting" hint, never a timer. A row whose resource no
// longer resolves (deleted) falls back to a localized placeholder title and
// renders as plain text (no link).
function ExecutionRow({
  exec,
  nowMs,
}: {
  exec: ExecutionView;
  nowMs: number;
}) {
  const t = useTranslations("agentConnections");
  const formatElapsed = useElapsedMono();
  const entityTypeLabel = useEntityTypeLabel();
  const running = exec.status === "running";

  const title = exec.entityTitle?.trim() || t("execEntityUnknown");
  const href = execHref(exec);

  return (
    <li className="flex items-center gap-3 rounded-xl border border-[#E5E0D8] bg-white px-3.5 py-3">
      <span
        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-lg ${
          running ? "bg-[#C67A5214]" : "bg-[#F0EDE8]"
        }`}
        aria-hidden
      >
        {running ? (
          // Decorative spin gated behind motion-safe so reduced-motion users see
          // a static icon (same reduced-motion regime as the online pulse dot).
          <Loader2 className="h-4 w-4 text-[#C67A52] motion-safe:animate-spin" />
        ) : (
          <Clock3 className="h-4 w-4 text-[#9A9A9A]" />
        )}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <Badge
            variant="secondary"
            className="shrink-0 border-0 bg-[#F0EDE8] px-1.5 py-0 text-[10px] font-medium text-[#6B6B6B]"
          >
            {entityTypeLabel(exec.entityType)}
          </Badge>
          {href ? (
            <Link
              href={href}
              className="group inline-flex min-w-0 items-center gap-1.5 truncate text-[14px] font-medium text-[#2C2C2C] hover:text-[#C67A52]"
            >
              <span className="truncate">{title}</span>
              <ExternalLink className="h-3.5 w-3.5 shrink-0 text-[#C8C3BA] group-hover:text-[#C67A52]" />
            </Link>
          ) : (
            <span className="block truncate text-[14px] font-medium text-[#9A9A9A]">
              {title}
            </span>
          )}
        </div>
        {exec.rootIdeaTitle && (
          <div className="mt-1 flex items-center gap-1.5">
            <Sparkles className="h-3 w-3 shrink-0 text-[#9A8C7E]" aria-hidden />
            <span className="truncate text-[11px] text-[#9A8C7E]">
              {t("execSession", { idea: exec.rootIdeaTitle })}
            </span>
          </div>
        )}
      </div>
      {running ? (
        exec.startedAt ? (
          <span
            className="shrink-0 font-mono text-[12px] font-medium tabular-nums text-[#15803D]"
            title={t("execElapsedLabel")}
          >
            {formatElapsed(exec.startedAt, nowMs)}
          </span>
        ) : null
      ) : (
        <span className="shrink-0 text-[11px] font-medium text-[#9A9A9A]">
          {t("execWaiting")}
        </span>
      )}
    </li>
  );
}

// A labeled section (running / queued) with a count badge and its rows.
function ExecutionSection({
  icon: Icon,
  label,
  count,
  children,
}: {
  icon: typeof Play;
  label: string;
  count: number;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center gap-2">
        <Icon className="h-4 w-4 text-[#C67A52]" aria-hidden />
        <span className="text-[12px] font-semibold uppercase tracking-wide text-[#6B6B6B]">
          {label}
        </span>
        <Badge
          variant="secondary"
          className="border-0 bg-[#F0EDE8] px-1.5 py-0 font-mono text-[10px] font-medium text-[#9A8C7E]"
        >
          {count}
        </Badge>
      </div>
      <ul className="flex flex-col gap-2">{children}</ul>
    </div>
  );
}

// The execution pane that replaces the old "coming soon" placeholder. First
// paint reads GET /api/daemon/execution-state?connectionUuid=… (correct state
// before any SSE event), then subscribes to execution:{connectionUuid} via the
// RealtimeProvider and re-renders on each event (a task starting/finishing, or
// the connection going offline → empty active set). Keyed by connection uuid at
// the call site so switching connections resets fetch state cleanly.
function ExecutionPane({
  connectionUuid,
  nowMs,
}: {
  connectionUuid: string;
  nowMs: number;
}) {
  const t = useTranslations("agentConnections");
  const [executions, setExecutions] = useState<ExecutionView[]>([]);
  const [loading, setLoading] = useState(true);

  // First-paint fetch — runs once per connection (component is keyed by uuid).
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    (async () => {
      try {
        const res = await authFetch(
          `/api/daemon/execution-state?connectionUuid=${encodeURIComponent(connectionUuid)}`,
        );
        if (!res.ok) return;
        const json = await res.json();
        if (!cancelled && json.success) {
          setExecutions(json.data.executions ?? []);
        }
      } catch (error) {
        clientLogger.error("Failed to fetch daemon execution state:", error);
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [connectionUuid]);

  // Live updates — the SSE event carries the connection's full current active
  // set, so we replace wholesale (no merge). Filtered to this connection by the
  // hook. Offline → empty set → the empty state renders.
  useExecutionSubscription(connectionUuid, (event) => {
    setExecutions(event.executions);
  });

  const running = useMemo(
    () => executions.filter((e) => e.status === "running"),
    [executions],
  );
  const queued = useMemo(
    () => executions.filter((e) => e.status === "queued"),
    [executions],
  );

  return (
    <div className="flex h-full min-h-[180px] flex-col gap-4 rounded-xl border border-[#EFEBE4] bg-[#FCFBF8] p-5">
      <div className="flex items-center gap-2">
        <ListChecks className="h-4 w-4 text-[#C67A52]" aria-hidden />
        <span className="text-[14px] font-semibold text-[#2C2C2C]">
          {t("execTitle")}
        </span>
      </div>

      {loading ? (
        <div className="flex flex-1 items-center justify-center gap-2 py-6 text-[13px] text-[#9A9A9A]">
          <Loader2 className="h-4 w-4 motion-safe:animate-spin" aria-hidden />
          {t("execLoading")}
        </div>
      ) : running.length === 0 && queued.length === 0 ? (
        <div className="flex flex-1 flex-col items-center justify-center gap-2 py-8 text-center">
          <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#F0EDE8]">
            <Clock3 className="h-5 w-5 text-[#9A9A9A]" aria-hidden />
          </div>
          <p className="text-[13px] font-medium text-[#6B6B6B]">
            {t("execEmptyTitle")}
          </p>
          <p className="max-w-xs text-[12px] leading-relaxed text-[#9A9A9A]">
            {t("execEmptyBody")}
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-5">
          {running.length > 0 && (
            <ExecutionSection icon={Play} label={t("execRunning")} count={running.length}>
              {running.map((exec) => (
                <ExecutionRow key={exec.uuid} exec={exec} nowMs={nowMs} />
              ))}
            </ExecutionSection>
          )}
          {queued.length > 0 && (
            <ExecutionSection icon={ListChecks} label={t("execQueued")} count={queued.length}>
              {queued.map((exec) => (
                <ExecutionRow key={exec.uuid} exec={exec} nowMs={nowMs} />
              ))}
            </ExecutionSection>
          )}
        </div>
      )}
    </div>
  );
}

// =====================================================================
// Connection rail row (desktop) + connection card (mobile list)
// =====================================================================

function RailRow({
  connection,
  selected,
  onSelect,
  nowMs,
}: {
  connection: ConnectionView;
  selected: boolean;
  onSelect: () => void;
  nowMs: number;
}) {
  const t = useTranslations("agentConnections");
  const clientTypeLabel = useClientTypeLabel();
  const formatRelative = useRelativeTime();
  const online = connection.effectiveStatus === "online";
  const agentName = connection.agentName?.trim() || t("unknownAgent");
  const host = connection.host === "" ? t("hostUnknown") : connection.host;

  return (
    <Button
      variant="ghost"
      onClick={onSelect}
      aria-current={selected ? "true" : undefined}
      className={`relative h-auto w-full justify-start gap-0 rounded-none px-0 py-0 text-left transition-colors ${
        selected
          ? "bg-[#FBF4EF] hover:bg-[#FBF4EF]"
          : "bg-white hover:bg-[#FAF8F4]"
      }`}
    >
      {selected && (
        <span
          aria-hidden
          className="absolute inset-y-0 left-0 w-[3px] bg-[#C67A52]"
        />
      )}
      <span className="flex w-full items-center gap-3 px-4 py-3.5">
        <span className="shrink-0">
          <StatusDot online={online} size="md" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[14px] font-semibold text-[#2C2C2C]">
            {agentName}
          </span>
          <span className="mt-0.5 flex items-center gap-1.5">
            <Badge
              variant="secondary"
              className="shrink-0 border-0 bg-[#F0EDE8] px-1.5 py-0 text-[10px] font-medium text-[#6B6B6B]"
            >
              {clientTypeLabel(connection.clientType)}
            </Badge>
            <span className="truncate font-mono text-[10px] text-[#9A9A9A]">
              · {host}
            </span>
          </span>
        </span>
        <span
          className={`shrink-0 text-[11px] font-medium tabular-nums ${
            online ? "text-[#15803D]" : "text-[#9A9A9A]"
          }`}
        >
          {formatRelative(connection.lastSeenAt, nowMs)}
        </span>
      </span>
    </Button>
  );
}

function MobileCard({
  connection,
  onSelect,
  nowMs,
}: {
  connection: ConnectionView;
  onSelect: () => void;
  nowMs: number;
}) {
  const t = useTranslations("agentConnections");
  const formatRelative = useRelativeTime();
  const formatUptime = useUptimeMono();
  const online = connection.effectiveStatus === "online";

  return (
    <Button
      variant="ghost"
      onClick={onSelect}
      className="block h-auto w-full rounded-2xl p-0 text-left hover:bg-transparent"
    >
      <Card className="w-full gap-3.5 rounded-2xl border-[#E5E0D8] bg-white p-4 shadow-none transition-colors hover:bg-[#FBF4EF]/40">
        <div className="flex items-center justify-between gap-3">
          <IdentityBlock connection={connection} size="md" />
          <div className="shrink-0">
            <StatusBadge online={online} />
          </div>
        </div>
        <div className="h-px w-full bg-[#F2EEE7]" />
        <div className="grid grid-cols-2 gap-3">
          {/* Uptime tile is conditional — offline cards omit it entirely so the
              footer becomes a single Last-active tile, never a placeholder dash. */}
          {online ? (
            <div>
              <div className="text-[11px] font-medium uppercase tracking-wide text-[#9A9A9A]">
                {t("fieldUptime")}
              </div>
              <div className="mt-1 truncate font-mono text-[14px] font-medium text-[#2C2C2C]">
                {formatUptime(connection.connectedAt, nowMs)}
              </div>
            </div>
          ) : (
            <div />
          )}
          <div>
            <div className="text-[11px] font-medium uppercase tracking-wide text-[#9A9A9A]">
              {t("fieldLastActive")}
            </div>
            <div className="mt-1 truncate text-[14px] font-medium text-[#2C2C2C]">
              {formatRelative(connection.lastSeenAt, nowMs)}
            </div>
          </div>
        </div>
      </Card>
    </Button>
  );
}

// =====================================================================
// Detail composition (shared by desktop right-pane + mobile detail screen)
// =====================================================================

function DetailContent({
  connection,
  nowMs,
  variant,
}: {
  connection: ConnectionView;
  nowMs: number;
  variant: "desktop" | "mobile";
}) {
  const t = useTranslations("agentConnections");
  const formatRelative = useRelativeTime();
  const formatUptime = useUptimeMono();
  const online = connection.effectiveStatus === "online";

  // The desktop variant frames the whole panel (rounded white card) — mobile
  // sits directly on the page background and uses individual stat tiles.
  if (variant === "desktop") {
    return (
      <div className="flex h-full flex-col">
        <div className="flex items-start justify-between gap-4 px-6 py-5">
          <IdentityBlock connection={connection} size="md" />
          <div className="shrink-0 pt-1">
            <StatusBadge online={online} />
          </div>
        </div>
        <div className="h-px w-full bg-[#EFEBE4]" />
        <div className="flex flex-1 flex-col gap-6 p-6">
          <div className="grid grid-cols-2 gap-4">
            {/* Uptime is online-only. The slot stays empty for offline
                connections — never a placeholder dash, never a misleading
                ever-growing duration. */}
            {online ? (
              <div className="rounded-xl border border-[#E5E0D8] bg-white p-4">
                <div className="text-[11px] font-medium uppercase tracking-wide text-[#9A9A9A]">
                  {t("fieldUptime")}
                </div>
                <div className="mt-2 truncate font-mono text-[22px] font-medium tabular-nums text-[#2C2C2C]">
                  {formatUptime(connection.connectedAt, nowMs)}
                </div>
              </div>
            ) : (
              <div />
            )}
            <StatTile
              label={t("fieldLastActive")}
              value={formatRelative(connection.lastSeenAt, nowMs)}
            />
            <StatTile
              label={t("fieldStarted")}
              value={
                connection.startedAt
                  ? formatRelative(connection.startedAt, nowMs)
                  : t("startedUnknown")
              }
            />
            <StatTile
              label={t("fieldHost")}
              value={connection.host === "" ? t("hostUnknown") : connection.host}
              mono
            />
          </div>
          <div className="flex-1">
            <ExecutionPane
              key={connection.uuid}
              connectionUuid={connection.uuid}
              nowMs={nowMs}
            />
          </div>
        </div>
      </div>
    );
  }

  // Mobile variant
  return (
    <div className="flex flex-col gap-5 px-5 pb-6">
      <div className="flex flex-col gap-4">
        <IdentityBlock connection={connection} size="lg" />
        <div>
          <StatusBadge online={online} />
        </div>
      </div>
      <div className="grid gap-3">
        {online && (
          <div className="rounded-xl border border-[#E5E0D8] bg-white p-4">
            <div className="text-[11px] font-medium uppercase tracking-wide text-[#9A9A9A]">
              {t("fieldUptime")}
            </div>
            <div className="mt-2 truncate font-mono text-[22px] font-medium tabular-nums text-[#2C2C2C]">
              {formatUptime(connection.connectedAt, nowMs)}
            </div>
          </div>
        )}
        <div className="grid grid-cols-2 gap-3">
          <StatTile
            label={t("fieldLastActive")}
            value={formatRelative(connection.lastSeenAt, nowMs)}
          />
          <StatTile
            label={t("fieldStarted")}
            value={
              connection.startedAt
                ? formatRelative(connection.startedAt, nowMs)
                : t("startedUnknown")
            }
          />
        </div>
        <StatTile
          label={t("fieldHost")}
          value={connection.host === "" ? t("hostUnknown") : connection.host}
          mono
        />
      </div>
      <ExecutionPane
        key={connection.uuid}
        connectionUuid={connection.uuid}
        nowMs={nowMs}
      />
    </div>
  );
}

// =====================================================================
// Page
// =====================================================================

// The page content is wrapped in a RealtimeProvider by the default export below.
// This is REQUIRED for live execution updates: the dashboard layout only mounts
// a RealtimeProvider for project-scoped pages (/projects/{uuid}/…), so a global
// page like /agent-connections would otherwise have no provider — and
// `useExecutionSubscription` (used by ExecutionPane) would silently no-op,
// freezing the detail pane at its first-paint state. Wrapping here is
// self-contained (no projectUuid needed): the provider opens the company-wide
// /api/events SSE stream, which is the stream that forwards execution:{uuid}
// events to the browser.
function AgentConnectionsPageContent() {
  const t = useTranslations("agentConnections");
  const [connections, setConnections] = useState<ConnectionView[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedUuid, setSelectedUuid] = useState<string | null>(null);
  const [nowMs, setNowMs] = useState(() => Date.now());

  const fetchConnections = useCallback(async () => {
    try {
      const res = await authFetch("/api/agent-connections");
      if (!res.ok) return;
      const json = await res.json();
      if (json.success) {
        setConnections(json.data.connections ?? []);
      }
    } catch (error) {
      clientLogger.error("Failed to fetch agent connections:", error);
    } finally {
      setLoading(false);
    }
  }, []);

  // 15s dataset poll — picks up online↔offline flips without manual reload.
  useEffect(() => {
    fetchConnections();
    const id = setInterval(fetchConnections, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [fetchConnections]);

  // 1s "now" tick — drives the monospace HH:MM:SS uptime ticker. Kept as a
  // single shared interval (not per-row) so 100 rows don't mean 100 timers.
  // It's running unconditionally because the formatters are cheap and any
  // online row needs it; if there are zero online rows, every formatter ignores
  // the value, so the cost is a no-op re-render every second.
  useEffect(() => {
    const id = setInterval(() => setNowMs(Date.now()), UPTIME_TICK_MS);
    return () => clearInterval(id);
  }, []);

  const onlineCount = useMemo(
    () => connections.filter((c) => c.effectiveStatus === "online").length,
    [connections],
  );

  // Selection is derived, not stored-then-synced: the explicit `selectedUuid`
  // wins when it still resolves, otherwise we fall back to the first connection
  // (already sorted online-first by the service). Deriving it inline means the
  // desktop detail pane shows the default on the very first paint — no
  // one-frame flash of the "select a connection" prompt before an effect fires.
  const selected = useMemo(
    () =>
      connections.find((c) => c.uuid === selectedUuid) ??
      connections[0] ??
      null,
    [connections, selectedUuid],
  );
  // Highlight the rail row that matches what the detail pane actually shows,
  // which is the derived selection (not the raw `selectedUuid`, which may be
  // null on first load or stale after a poll).
  const selectedId = selected?.uuid ?? null;

  // Mobile drill-down state: any row tap on mobile sets selectedUuid AND opens
  // the detail screen. We use a separate `mobileDetailOpen` so going back
  // doesn't lose the selection (and so desktop, which always shows detail,
  // is unaffected).
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false);

  // Guard against the mobile detail silently swapping to a different agent: if
  // the user has drilled into a connection and it later drops out of a poll,
  // close the drill-down back to the list instead of re-pinning the detail
  // screen to connections[0] (which would show a different agent under the
  // same open detail view without the user navigating).
  useEffect(() => {
    if (
      mobileDetailOpen &&
      selectedUuid &&
      !connections.some((c) => c.uuid === selectedUuid)
    ) {
      setMobileDetailOpen(false);
    }
  }, [connections, mobileDetailOpen, selectedUuid]);

  return (
    <div className="min-h-full bg-[#FAF8F4]">
      {/* ===========================================================
          MOBILE: drill-down detail view (renders on top when open).
          ========================================================== */}
      {mobileDetailOpen && selected && (
        <div className="lg:hidden">
          <div className="sticky top-0 z-10 flex items-center gap-1 border-b border-[#EFEBE4] bg-[#FAF8F4] px-3 py-2.5">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setMobileDetailOpen(false)}
              className="h-9 gap-1 px-2 text-[15px] font-normal text-[#C67A52] hover:bg-[#FBF4EF] hover:text-[#C67A52]"
            >
              <ChevronLeft className="h-5 w-5" />
              {t("mobileBack")}
            </Button>
          </div>
          <div className="pt-4">
            <DetailContent connection={selected} nowMs={nowMs} variant="mobile" />
          </div>
        </div>
      )}

      {/* ===========================================================
          MOBILE list + DESKTOP master-detail.
          The mobile list is hidden when the drill-down is open.
          The desktop layout (lg+) is always rendered — it ignores the
          mobile-only `mobileDetailOpen` flag.
          ========================================================== */}
      <div
        className={`${
          mobileDetailOpen ? "hidden lg:flex" : "flex"
        } min-h-full flex-col gap-6 px-4 py-5 md:px-8 md:py-6 lg:gap-6 lg:px-8 lg:py-7`}
      >
        {/* Header */}
        <header className="flex flex-col gap-2 lg:flex-row lg:items-start lg:justify-between lg:gap-6">
          <div className="flex flex-col gap-1.5">
            <h1 className="text-[22px] font-semibold text-[#2C2C2C] lg:text-[24px]">
              {t("title")}
            </h1>
            <p className="max-w-[640px] text-[13px] leading-relaxed text-[#6B6B6B]">
              {t("subtitle")}
            </p>
          </div>
          {!loading && connections.length > 0 && (
            <div className="inline-flex items-center gap-2 self-start rounded-full border border-[#E5E0D8] bg-white px-3.5 py-1.5">
              <StatusDot online={onlineCount > 0} size="md" />
              <span className="text-[13px] font-medium text-[#2C2C2C]">
                {t("summary", { online: onlineCount, total: connections.length })}
              </span>
            </div>
          )}
        </header>

        {/* Body */}
        {loading ? (
          <p className="text-sm text-[#6B6B6B]">{t("loading")}</p>
        ) : connections.length === 0 ? (
          <Card className="items-center gap-3 rounded-2xl border-[#E5E0D8] bg-white p-8 text-center shadow-none md:p-12">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-[#C67A5215]">
              <RadioTower className="h-6 w-6 text-[#C67A52]" />
            </div>
            <h2 className="text-base font-semibold text-[#2C2C2C]">
              {t("empty.title")}
            </h2>
            <p className="max-w-md text-[13px] leading-relaxed text-[#6B6B6B]">
              {t("empty.body")}
            </p>
          </Card>
        ) : (
          <>
            {/* MOBILE: stacked card list (< lg) */}
            <div className="flex flex-col gap-3 lg:hidden">
              {connections.map((connection) => (
                <MobileCard
                  key={connection.uuid}
                  connection={connection}
                  nowMs={nowMs}
                  onSelect={() => {
                    setSelectedUuid(connection.uuid);
                    setMobileDetailOpen(true);
                  }}
                />
              ))}
            </div>

            {/* DESKTOP: master-detail (lg+) */}
            <div className="hidden flex-1 gap-5 lg:flex">
              {/* Connection rail */}
              <Card className="flex w-[340px] shrink-0 flex-col gap-0 overflow-hidden rounded-2xl border-[#E5E0D8] bg-white p-0 shadow-none">
                <div className="flex items-center justify-between px-4 py-4">
                  <span className="font-mono text-[11px] font-medium uppercase tracking-[1px] text-[#9A9A9A]">
                    {t("railHeader")}
                  </span>
                  <span className="font-mono text-[11px] font-medium text-[#9A9A9A]">
                    {connections.length}
                  </span>
                </div>
                <div className="h-px w-full bg-[#EFEBE4]" />
                <div className="flex flex-col">
                  {connections.map((connection, idx) => (
                    <div key={connection.uuid}>
                      <RailRow
                        connection={connection}
                        selected={selectedId === connection.uuid}
                        onSelect={() => setSelectedUuid(connection.uuid)}
                        nowMs={nowMs}
                      />
                      {idx < connections.length - 1 && (
                        <div className="h-px w-full bg-[#F2EEE7]" />
                      )}
                    </div>
                  ))}
                </div>
              </Card>

              {/* Detail panel */}
              <Card className="flex flex-1 flex-col overflow-hidden rounded-2xl border-[#E5E0D8] bg-white p-0 shadow-none">
                {selected ? (
                  <DetailContent
                    connection={selected}
                    nowMs={nowMs}
                    variant="desktop"
                  />
                ) : (
                  <div className="flex flex-1 items-center justify-center p-12 text-[13px] text-[#9A9A9A]">
                    {t("selectPrompt")}
                  </div>
                )}
              </Card>
            </div>
          </>
        )}
      </div>
    </div>
  );
}

// Default export: wrap the page in a RealtimeProvider (no projectUuid → opens the
// company-wide /api/events stream) so ExecutionPane's execution:{connectionUuid}
// subscription actually receives live updates. Without this, the layout leaves
// this global page provider-less and live updates never fire (the detail pane
// would be frozen at first-paint until reload).
export default function AgentConnectionsPage() {
  return (
    <RealtimeProvider>
      <AgentConnectionsPageContent />
    </RealtimeProvider>
  );
}
