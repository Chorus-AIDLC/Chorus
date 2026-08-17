"use client";

// Agent Connections — master-detail observation deck, relocated into the
// "View all" modal.
//
// This is the former standalone `/agent-connections` page body, refactored into
// a presentational view that reads its dataset from the shell-level
// `useAgentPresence()` spine instead of running its own poll + SSE. Capability
// parity with the former page is a hard requirement:
//   - master-detail connection list (online-first with stable identity ties),
//   - per-connection detail (client type + version, online/offline from
//     `effectiveStatus`, host, last-active, uptime ONLY for online),
//   - running/queued execution state + the `interrupted` executions the data
//     source retains,
//   - the interrupt/resume controls (子3), which live inside the shared
//     `ExecutionRow` — so the modal renders interrupted rows together with their
//     resume control (unlike the glanceable popover, which drops them).
//
// Identity inversion (carried over verbatim): every surface leads with the owning
// agent's display name (`agentName`) and demotes the client type to a small badge,
// so two connections that share a client type but belong to different agents stay
// distinguishable.
//
// Layout: a single client component renders BOTH compositions off the same
// dataset and formatters; only Tailwind breakpoints switch between them.
//   - lg+ : two-pane master-detail (rail + detail panel).
//   - < lg: mobile list + drill-down detail; selection state is a normal piece
//           of client state, no separate route.
//
// Liveness: connections + executions come from the provider (single poll + single
// SSE for the whole shell). The only timer owned here is the 1s `nowMs` ticker
// that drives the monospace `HH:MM:SS` uptime/elapsed displays for ONLINE
// connections. Offline connections show no uptime row at all (now - connectedAt
// for a stopped daemon would grow forever, which is misleading — this carries
// forward the shipped uptime bug fix). The ticker only mounts while the view is
// mounted (i.e. while the modal is open), so the closed-modal steady state has no
// interval running.

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import {
  ChevronLeft,
  Clock3,
  ListChecks,
  Loader2,
  PauseCircle,
  Play,
  RadioTower,
  WifiOff,
} from "lucide-react";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { AgentAvatar } from "@/components/ui/agent-avatar";
import { authFetch } from "@/lib/auth-client";
import { clientLogger } from "@/lib/logger-client";
import { useAgentPresence } from "@/contexts/agent-presence-context";
import {
  DaemonConnectCta,
  ExecutionRow,
  ExecutionSection,
  IdentityBlock,
  PathChip,
  SendInstructionBox,
  StatusBadge,
  StatusDot,
  onlineConnectionsOnly,
  useClientTypeLabel,
  useNowTick,
  useRelativeTime,
  useUptimeMono,
  type ConnectionView,
  type ExecutionView,
  type SessionTarget,
} from "@/components/agent-presence";

// =====================================================================
// View-local sub-components
// =====================================================================

// One labeled stat tile — used in both the desktop 2x2 grid and mobile detail.
function StatTile({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div
        className={`mt-1.5 truncate text-[15px] font-medium text-foreground ${mono ? "font-mono" : ""}`}
      >
        {value}
      </div>
    </div>
  );
}

// The connection's working-directory tile — path-first via the shared PathChip
// (a null cwd renders the "unknown path" treatment, the full absolute path is
// on hover). Uses a slightly larger char budget than a row chip since the tile
// has room. The chip self-truncates so a long path never overflows the tile.
function PathTile({ label, cwd }: { label: string; cwd: string | null }) {
  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className="mt-1.5 flex min-w-0">
        <PathChip cwd={cwd} formatOptions={{ charBudget: 40 }} />
      </div>
    </div>
  );
}

// =====================================================================
// Execution pane — running + queued + interrupted tasks for the selected
// connection, sourced from the aggregate provider.
// =====================================================================

// The execution pane reads the selected connection's executions from the
// provider's aggregate `executionsByConnection` map. First-paint parity: the
// provider has already fetched `GET /api/daemon/executions` (the aggregate
// equivalent of the former per-connection `execution-state` fetch) and merges
// live `execution:{connectionUuid}` SSE events, so the rows for this connection
// are present on first paint — partitioned to the correct connection by the map
// key — before any new SSE event. The pane no longer fetches anything itself
// (no double-subscribe with the shell-level provider).
function ExecutionPane({
  executions,
  nowMs,
  executionsLoaded,
  rowLayout = "inline",
}: {
  executions: ExecutionView[];
  nowMs: number;
  // False only during the first-paint window where the connection list has
  // loaded but the execution aggregate has not yet settled. While false AND this
  // connection has no rows yet, show a loading state rather than the "Nothing
  // running" empty state (which would be a false negative for a busy connection).
  executionsLoaded: boolean;
  // Geometry of the execution rows, forwarded from the detail variant: the wide
  // desktop master-detail pane uses "inline" (room to spare), the narrow mobile
  // drill-down uses "stacked" so a running row's title is not squeezed by the
  // elapsed timer + Interrupt/Resume controls (same fix the sidebar popover got).
  rowLayout?: "inline" | "stacked";
}) {
  const t = useTranslations("agentConnections");

  const running = useMemo(
    () => executions.filter((e) => e.status === "running"),
    [executions],
  );
  const queued = useMemo(
    () => executions.filter((e) => e.status === "queued"),
    [executions],
  );
  // Sticky interrupted rows (子3): a stopped, resumable (or crash-auto-recovering)
  // wake. Shown in its own section so it reads as standing state, not active work.
  // The modal DOES render these (with their resume control via ExecutionRow);
  // only the glanceable popover drops them.
  const interrupted = useMemo(
    () => executions.filter((e) => e.status === "interrupted"),
    [executions],
  );

  return (
    <div className="flex h-full min-h-[180px] flex-col gap-4 rounded-xl border border-[#EFEBE4] dark:border-[#2a2a2e] bg-[#FCFBF8] dark:bg-[#1e1d1b] p-5">
      <div className="flex items-center gap-2">
        <ListChecks className="h-4 w-4 text-primary" aria-hidden />
        <span className="text-[14px] font-semibold text-foreground">
          {t("execTitle")}
        </span>
      </div>

      {running.length === 0 && queued.length === 0 && interrupted.length === 0 ? (
        !executionsLoaded ? (
          // Connections settled but the execution aggregate hasn't yet — show a
          // loading state instead of "Nothing running" so a busy connection
          // never flashes a false-empty in the first-paint window.
          <div className="flex flex-1 flex-col items-center justify-center gap-2 py-8 text-center">
            <Loader2
              className="h-5 w-5 text-muted-foreground motion-safe:animate-spin"
              aria-hidden
            />
            <p className="text-[13px] font-medium text-muted-foreground">
              {t("execLoading")}
            </p>
          </div>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-2 py-8 text-center">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-[#F0EDE8] dark:bg-[#1f1e1c]">
              <Clock3 className="h-5 w-5 text-muted-foreground" aria-hidden />
            </div>
            <p className="text-[13px] font-medium text-muted-foreground">
              {t("execEmptyTitle")}
            </p>
            <p className="max-w-xs text-[12px] leading-relaxed text-muted-foreground">
              {t("execEmptyBody")}
            </p>
          </div>
        )
      ) : (
        <div className="flex flex-col gap-5">
          {running.length > 0 && (
            <ExecutionSection icon={Play} label={t("execRunning")} count={running.length}>
              {running.map((exec) => (
                <ExecutionRow key={exec.uuid} exec={exec} nowMs={nowMs} layout={rowLayout} />
              ))}
            </ExecutionSection>
          )}
          {queued.length > 0 && (
            <ExecutionSection icon={ListChecks} label={t("execQueued")} count={queued.length}>
              {queued.map((exec) => (
                <ExecutionRow key={exec.uuid} exec={exec} nowMs={nowMs} layout={rowLayout} />
              ))}
            </ExecutionSection>
          )}
          {interrupted.length > 0 && (
            <ExecutionSection
              icon={PauseCircle}
              label={t("execInterrupted")}
              count={interrupted.length}
            >
              {interrupted.map((exec) => (
                <ExecutionRow key={exec.uuid} exec={exec} nowMs={nowMs} layout={rowLayout} />
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
          ? "bg-[#FBF4EF] dark:bg-[#221e1b] hover:bg-[#FBF4EF] dark:hover:bg-[#26241f]"
          : "bg-card hover:bg-background"
      }`}
    >
      {selected && (
        <span
          aria-hidden
          className="absolute inset-y-0 left-0 w-[3px] bg-primary"
        />
      )}
      <span className="flex w-full items-center gap-3 px-4 py-3.5">
        {/* Agent identity avatar — the rail previously led with only a status
            dot (T3 missed it). The shared DiceBear <AgentAvatar> is seeded by
            the agent name; the online/offline dot is kept as a corner badge so
            liveness still reads at a glance. The mobile card + desktop detail
            get their avatar through <IdentityBlock>, so only this rail row
            takes a direct avatar (no double avatar). */}
        <span className="relative shrink-0">
          <AgentAvatar name={agentName} size="md" className="rounded-lg" />
          <span className="absolute -bottom-1 -right-1 rounded-full bg-card p-0.5">
            <StatusDot online={online} size="md" />
          </span>
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="truncate text-[14px] font-semibold text-foreground">
            {agentName}
          </span>
          {/* Path-first: the connection's working directory is the primary
              per-instance identity (a monospace path chip), so two connections
              of one agent that differ only by cwd stay distinguishable in the
              rail. The client type + host are demoted to a dimmed suffix. */}
          <PathChip cwd={connection.cwd} />
          <span className="mt-0.5 flex min-w-0 items-center gap-1.5">
            <Badge
              variant="secondary"
              className="shrink-0 border-0 bg-[#F0EDE8] dark:bg-[#1f1e1c] px-1.5 py-0 text-[10px] font-medium text-muted-foreground"
            >
              {clientTypeLabel(connection.clientType)}
            </Badge>
            <span className="truncate font-mono text-[10px] text-muted-foreground">
              · {host}
            </span>
          </span>
        </span>
        <span
          className={`shrink-0 text-[11px] font-medium tabular-nums ${
            online ? "text-[#15803D] dark:text-[#4FD07A]" : "text-muted-foreground"
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
      <Card className="w-full gap-3.5 rounded-2xl border-border bg-card p-4 shadow-none transition-colors hover:bg-[#FBF4EF] dark:hover:bg-[#26241f]/40">
        <div className="flex items-center justify-between gap-3">
          <IdentityBlock connection={connection} size="md" />
          <div className="shrink-0">
            <StatusBadge online={online} />
          </div>
        </div>
        <div className="h-px w-full bg-[#F2EEE7] dark:bg-[#201e1a]" />
        <div className="grid grid-cols-2 gap-3">
          {/* Uptime tile is conditional — offline cards omit it entirely so the
              footer becomes a single Last-active tile, never a placeholder dash. */}
          {online ? (
            <div>
              <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                {t("fieldUptime")}
              </div>
              <div className="mt-1 truncate font-mono text-[14px] font-medium text-foreground">
                {formatUptime(connection.connectedAt, nowMs)}
              </div>
            </div>
          ) : (
            <div />
          )}
          <div>
            <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              {t("fieldLastActive")}
            </div>
            <div className="mt-1 truncate text-[14px] font-medium text-foreground">
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
  executions,
  nowMs,
  variant,
  executionsLoaded,
  sessions,
  onlineConnections,
}: {
  connection: ConnectionView;
  executions: ExecutionView[];
  nowMs: number;
  variant: "desktop" | "mobile";
  executionsLoaded: boolean;
  // The caller's visible daemon sessions (with `originOnline`) + the online
  // connections of THIS connection's agent — both fed straight into the send dock
  // so it gates the direct/ad-hoc paths without its own fetch.
  sessions: SessionTarget[];
  onlineConnections: ConnectionView[];
}) {
  const t = useTranslations("agentConnections");
  const td = useTranslations("agentPresence.drilldown");
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
        <div className="h-px w-full bg-[#EFEBE4] dark:bg-[#201e1b]" />
        <div className="flex flex-1 flex-col gap-6 p-6">
          <div className="grid grid-cols-2 gap-4">
            {/* Uptime is online-only. The slot stays empty for offline
                connections — never a placeholder dash, never a misleading
                ever-growing duration. */}
            {online ? (
              <div className="rounded-xl border border-border bg-card p-4">
                <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
                  {t("fieldUptime")}
                </div>
                <div className="mt-2 truncate font-mono text-[22px] font-medium tabular-nums text-foreground">
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
            <PathTile label={td("fieldPath")} cwd={connection.cwd} />
            <StatTile
              label={t("fieldHost")}
              value={connection.host === "" ? t("hostUnknown") : connection.host}
              mono
            />
          </div>
          <div className="flex-1">
            <ExecutionPane
              executions={executions}
              nowMs={nowMs}
              executionsLoaded={executionsLoaded}
              rowLayout="inline"
            />
          </div>
          {/* Transmit dock — the human send side (子2). Sits beneath the
              execution state as the deck's "compose + dispatch" surface; gated
              on the selected session's origin being online. */}
          <SendInstructionBox
            connection={connection}
            sessions={sessions}
            onlineConnections={onlineConnections}
            layout="inline"
          />
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
          <div className="rounded-xl border border-border bg-card p-4">
            <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              {t("fieldUptime")}
            </div>
            <div className="mt-2 truncate font-mono text-[22px] font-medium tabular-nums text-foreground">
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
        <PathTile label={td("fieldPath")} cwd={connection.cwd} />
        <StatTile
          label={t("fieldHost")}
          value={connection.host === "" ? t("hostUnknown") : connection.host}
          mono
        />
      </div>
      <ExecutionPane
        executions={executions}
        nowMs={nowMs}
        executionsLoaded={executionsLoaded}
        rowLayout="stacked"
      />
      {/* Transmit dock (mobile drill-down) — stacked layout so the compose
          footer + Send drop beneath the textarea on the narrow screen. */}
      <SendInstructionBox
        connection={connection}
        sessions={sessions}
        onlineConnections={onlineConnections}
        layout="stacked"
      />
    </div>
  );
}

// =====================================================================
// View
// =====================================================================

// The relocated Agent Connections body. Reads connections + executions from the
// shell-level `useAgentPresence()` provider (single poll + single SSE for the
// whole shell — no per-connection fetch, no double-subscribe). Hosted in a Dialog
// by `AgentConnectionsModal`.
export function AgentConnectionsView() {
  const t = useTranslations("agentConnections");
  const {
    status,
    connections,
    onlineCount,
    executionsByConnection,
    executionsLoaded,
  } = useAgentPresence();
  const nowMs = useNowTick();

  // Daemon-session targeting list for the send dock (子2). Fetched here (the
  // presence provider carries connections + executions, not sessions) on the same
  // cadence as the view is mounted: an immediate fetch plus a 15s refresh so a
  // session's `originOnline` flag re-settles after a daemon connects/disconnects,
  // matching the connection poll's self-healing cadence. A failed fetch leaves the
  // last-known list rather than zeroing it (no silent error — logged) so the dock
  // never flips to "no online connection" on a transient blip.
  const [sessions, setSessions] = useState<SessionTarget[]>([]);
  const fetchSessions = useCallback(async () => {
    try {
      const res = await authFetch("/api/daemon-sessions");
      if (!res.ok) return;
      const json = await res.json();
      if (json.success) {
        setSessions(json.data.sessions ?? []);
      }
    } catch (error) {
      clientLogger.error("Failed to fetch daemon sessions:", error);
    }
  }, []);
  useEffect(() => {
    fetchSessions();
    const id = setInterval(fetchSessions, 15_000);
    return () => clearInterval(id);
  }, [fetchSessions]);

  const [selectedUuid, setSelectedUuid] = useState<string | null>(null);

  // Online-only presence (T11 / qr2): this "View all" deck shows ONLY live
  // instances — the same online-only contract as the pill popover. We derive the
  // visible set once and feed it to the rail (desktop), the card list (mobile),
  // the selection/derivation, and the rail count, so an offline instance
  // (including a legacy null-cwd "unknown path" row) never appears and an agent
  // with no online instance drops out entirely. The provider's raw `connections`
  // is still the source of `onlineCount`/`status` (the no-silent-error gate) and
  // of `selectedAgentOnlineConnections` (which independently filters online).
  const visibleConnections = useMemo(
    () => onlineConnectionsOnly(connections, executionsByConnection),
    [connections, executionsByConnection],
  );

  // "loading" only on the very first poll before any data has settled. Once the
  // provider has connections, an in-flight re-poll keeps showing the list.
  const loading = status === "loading";
  // A failed first poll (status "error" with no cached connections) must render
  // as a DISTINCT error state — never the "no connections" empty card, which
  // would masquerade a fetch failure as a definitive zero (the no-silent-error
  // contract the pill already honors). A later poll failure that still has a
  // cached list keeps showing the list (the provider never zeros it).
  const showError = status === "error" && connections.length === 0;

  // Selection is derived, not stored-then-synced: the explicit `selectedUuid`
  // wins when it still resolves, otherwise we fall back to the first connection
  // (already sorted online-first by the service). Deriving it inline means the
  // desktop detail pane shows the default on the very first paint — no
  // one-frame flash of the "select a connection" prompt before an effect fires.
  const selected = useMemo(
    () =>
      visibleConnections.find((c) => c.uuid === selectedUuid) ??
      visibleConnections[0] ??
      null,
    [visibleConnections, selectedUuid],
  );
  // Highlight the rail row that matches what the detail pane actually shows,
  // which is the derived selection (not the raw `selectedUuid`, which may be
  // null on first load or stale after a poll).
  const selectedId = selected?.uuid ?? null;

  // The selected connection's executions, partitioned to it by the provider's
  // aggregate map key. Present on first paint (the provider fetched the
  // aggregate on mount), equivalent to the former per-connection fetch.
  const selectedExecutions = selectedId
    ? executionsByConnection[selectedId] ?? []
    : [];

  // The online connections that belong to the SELECTED connection's agent — the
  // candidate set for the ad-hoc session picker (the picker never lists another
  // agent's connections; the server re-verifies ownership + online on POST).
  const selectedAgentOnlineConnections = useMemo(
    () =>
      selected
        ? connections.filter(
            (c) =>
              c.agentUuid === selected.agentUuid &&
              c.effectiveStatus === "online",
          )
        : [],
    [connections, selected],
  );

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
      !visibleConnections.some((c) => c.uuid === selectedUuid)
    ) {
      setMobileDetailOpen(false);
    }
  }, [visibleConnections, mobileDetailOpen, selectedUuid]);

  return (
    <div className="min-h-full bg-background">
      {/* ===========================================================
          MOBILE: drill-down detail view (renders on top when open).
          ========================================================== */}
      {mobileDetailOpen && selected && (
        <div className="lg:hidden">
          <div className="sticky top-0 z-10 flex items-center gap-1 border-b border-[#EFEBE4] dark:border-[#2a2a2e] bg-background px-3 py-2.5">
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setMobileDetailOpen(false)}
              className="h-9 gap-1 px-2 text-[15px] font-normal text-primary hover:bg-[#FBF4EF] dark:hover:bg-[#26241f] hover:text-primary"
            >
              <ChevronLeft className="h-5 w-5" />
              {t("mobileBack")}
            </Button>
          </div>
          <div className="pt-4">
            <DetailContent
              connection={selected}
              executions={selectedExecutions}
              nowMs={nowMs}
              variant="mobile"
              executionsLoaded={executionsLoaded}
              sessions={sessions}
              onlineConnections={selectedAgentOnlineConnections}
            />
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
            <h2 className="text-[22px] font-semibold text-foreground lg:text-[24px]">
              {t("title")}
            </h2>
            <p className="max-w-[640px] text-[13px] leading-relaxed text-muted-foreground">
              {t("subtitle")}
            </p>
          </div>
          {!loading && visibleConnections.length > 0 && (
            <div className="inline-flex items-center gap-2 self-start rounded-full border border-border bg-card px-3.5 py-1.5">
              <StatusDot online={onlineCount > 0} size="md" />
              {/* Online-only deck: `total` is the VISIBLE (online) count, not the
                  raw connection count — offline rows are hidden, so claiming a
                  higher total than the rendered rows would be misleading. */}
              <span className="text-[13px] font-medium text-foreground">
                {t("summary", {
                  online: onlineCount,
                  total: visibleConnections.length,
                })}
              </span>
            </div>
          )}
        </header>

        {/* Body */}
        {loading ? (
          <p className="text-sm text-muted-foreground">{t("loading")}</p>
        ) : showError ? (
          // A failed fetch with no cached list — render a DISTINCT error card,
          // never the "no connections" empty state (no silent error).
          <Card className="items-center gap-3 rounded-2xl border-[#E7D9C9] dark:border-[#33302a] bg-[#FFF9F3] dark:bg-[#2a2113] p-8 text-center shadow-none md:p-12">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-[#D9770615]">
              <WifiOff className="h-6 w-6 text-[#B45309] dark:text-[#E0A34E]" />
            </div>
            <h3 className="text-base font-semibold text-[#92400E] dark:text-[#E0A34E]">
              {t("loadErrorTitle")}
            </h3>
            <p className="max-w-md text-[13px] leading-relaxed text-muted-foreground">
              {t("loadErrorBody")}
            </p>
          </Card>
        ) : visibleConnections.length === 0 ? (
          <Card className="items-center gap-4 rounded-2xl border-border bg-card p-8 text-center shadow-none md:p-12">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary/[0.08]">
              <RadioTower className="h-6 w-6 text-primary" />
            </div>
            <h3 className="text-base font-semibold text-foreground">
              {t("empty.title")}
            </h3>
            {/* The hand-written "run chorus daemon" sentence is replaced by the
                shared daemon-connect CTA so this surface stays consistent with
                the pill popover + onboarding completion screen and the command
                can never drift. */}
            <div className="w-full max-w-md text-left">
              <DaemonConnectCta variant="prominent" />
            </div>
          </Card>
        ) : (
          <>
            {/* MOBILE: stacked card list (< lg) — online instances only. */}
            <div className="flex flex-col gap-3 lg:hidden">
              {visibleConnections.map((connection) => (
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
              <Card className="flex w-[340px] shrink-0 flex-col gap-0 overflow-hidden rounded-2xl border-border bg-card p-0 shadow-none">
                <div className="flex items-center justify-between px-4 py-4">
                  <span className="font-mono text-[11px] font-medium uppercase tracking-[1px] text-muted-foreground">
                    {t("railHeader")}
                  </span>
                  <span className="font-mono text-[11px] font-medium text-muted-foreground">
                    {visibleConnections.length}
                  </span>
                </div>
                <div className="h-px w-full bg-[#EFEBE4] dark:bg-[#201e1b]" />
                <div className="flex flex-col">
                  {visibleConnections.map((connection, idx) => (
                    <div key={connection.uuid}>
                      <RailRow
                        connection={connection}
                        selected={selectedId === connection.uuid}
                        onSelect={() => setSelectedUuid(connection.uuid)}
                        nowMs={nowMs}
                      />
                      {idx < visibleConnections.length - 1 && (
                        <div className="h-px w-full bg-[#F2EEE7] dark:bg-[#201e1a]" />
                      )}
                    </div>
                  ))}
                </div>
              </Card>

              {/* Detail panel */}
              <Card className="flex flex-1 flex-col overflow-hidden rounded-2xl border-border bg-card p-0 shadow-none">
                {selected ? (
                  <DetailContent
                    connection={selected}
                    executions={selectedExecutions}
                    nowMs={nowMs}
                    variant="desktop"
                    executionsLoaded={executionsLoaded}
                    sessions={sessions}
                    onlineConnections={selectedAgentOnlineConnections}
                  />
                ) : (
                  <div className="flex flex-1 items-center justify-center p-12 text-[13px] text-muted-foreground">
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
