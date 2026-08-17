"use client";

// Presence drill-down — per-(agent, host, cwd) instance rendering vocabulary.
//
// PR #353 made `cwd` part of a DaemonConnection's unique identity
// `(agentUuid, clientType, host, cwd)`, so one agent can be online in several
// working directories at once and each `(agent, host, cwd)` is a distinct,
// independently-online instance. The presence surface keeps one row per AGENT
// and expands it to one sub-row per live INSTANCE, each leading with its own
// `cwd` (path-first) and carrying its own `effectiveStatus` dot.
//
// Host is part of identity (the same path on two machines is two real
// instances) so it is NOT removed — it is de-emphasized: shown once at the
// agent header for a single-host agent, and promoted to a dimmed per-row
// monospace suffix only when the agent has live instances on 2+ DISTINCT hosts.
// A legacy `cwd = null` connection (an old daemon that never self-reported a
// working directory) renders as an explicit "unknown path" instance and is
// still individually listed.
//
// Truncation is delegated wholesale to the T1 formatter
// (`src/lib/daemon-instance-format.ts`): a long path left-truncates keeping its
// final segment, a long host right-truncates within a capped width, and the
// full value is exposed on hover (title). The status dot, any tag, and the
// path chip are laid out so the dot never shrinks and a long path/host never
// pushes it off the row.
//
// Presentational + prop-driven (no data fetching). Shared by the pill popover
// and (the cwd surfacing in) the modal so the path-first vocabulary stays
// byte-identical.

import { useTranslations } from "next-intl";
import { ChevronDown, Folder, FolderX, Monitor } from "lucide-react";
import {
  formatCwd,
  formatHost,
  type FormatCwdOptions,
} from "@/lib/daemon-instance-format";
import { AgentAvatar } from "@/components/ui/agent-avatar";
import { Button } from "@/components/ui/button";
import { StatusDot } from "./status";
import { useClientTypeLabel, useElapsedMono, useRelativeTime } from "./hooks";
import type { ConnectionView, ExecutionView } from "./types";

// ===== Pure grouping helpers (unit-tested independent of React) =====

// One agent's live + offline instances, plus the derived host-conditional flag.
export interface AgentInstanceGroup {
  agentUuid: string;
  agentName: string | null;
  // The client type carried by this agent's connections. Connections of one
  // agent can in principle differ by clientType (the unique key includes it),
  // but for the header badge we surface the first connection's type — the rows
  // themselves are keyed by the full connection so nothing is lost.
  clientType: string;
  connections: ConnectionView[];
  // How many connections are effectively online (drives the header dot + count).
  onlineCount: number;
  // True when this agent has connections on 2+ DISTINCT hosts. When true, each
  // instance row promotes its host to a per-row suffix so same-cwd rows on
  // different hosts stay distinguishable; when false, the host is shown once at
  // the agent header instead of repeated per row.
  multiHost: boolean;
  // The single host to show at the header when `multiHost` is false. The empty
  // string ("") means host-less — the caller resolves it to "unknown host".
  // Undefined when `multiHost` is true (host lives per-row instead).
  singleHost: string | undefined;
}

const MISSING_NAME_SORT_KEY = "\uffff";
const NULL_CWD_SORT_KEY = "\uffff";

function normalizedTextSortKey(value: string | null): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed.toLocaleLowerCase("en-US") : MISSING_NAME_SORT_KEY;
}

function cwdSortKey(value: string | null): string {
  return value === null ? NULL_CWD_SORT_KEY : value;
}

function compareText(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/**
 * Stable defensive ordering for frontend presence views. The backend already
 * returns deterministic order, but local derived surfaces can receive arrays
 * from tests, cached state, or future transforms; normalize before grouping so
 * equivalent refreshes cannot jump because of raw array order.
 */
export function sortConnectionsForPresence(
  connections: ConnectionView[],
  executionsByConnection: Record<string, ExecutionView[]> = {},
): ConnectionView[] {
  return [...connections].sort((a, b) => {
    const activityRankDiff =
      connectionActivityRank(a, executionsByConnection[a.uuid] ?? []) -
      connectionActivityRank(b, executionsByConnection[b.uuid] ?? []);
    return (
      activityRankDiff ||
      compareText(normalizedTextSortKey(a.agentName), normalizedTextSortKey(b.agentName)) ||
      compareText(a.agentUuid, b.agentUuid) ||
      compareText(cwdSortKey(a.cwd), cwdSortKey(b.cwd)) ||
      compareText(a.host, b.host) ||
      compareText(a.clientType, b.clientType) ||
      compareText(a.uuid, b.uuid)
    );
  });
}

/**
 * Group a flat list of connections into one entry per agent after applying the
 * stable presence comparator. Agent group order and connection order within an
 * agent are therefore deterministic rather than inherited from raw API/cache
 * array order. Pure: no side effects, safe in render/test.
 *
 * `multiHost` is derived from the count of DISTINCT non-empty-considered host
 * strings across the agent's connections (the empty-string host counts as its
 * own host so a host-less + a named connection still reads as 2 hosts and the
 * suffix appears to disambiguate them). `singleHost` is set only when there is
 * exactly one distinct host.
 */
export function groupConnectionsByAgent(
  connections: ConnectionView[],
  executionsByConnection: Record<string, ExecutionView[]> = {},
): AgentInstanceGroup[] {
  const orderedConnections = sortConnectionsForPresence(
    connections,
    executionsByConnection,
  );
  const order: string[] = [];
  const byAgent = new Map<string, ConnectionView[]>();
  for (const conn of orderedConnections) {
    if (!byAgent.has(conn.agentUuid)) {
      byAgent.set(conn.agentUuid, []);
      order.push(conn.agentUuid);
    }
    byAgent.get(conn.agentUuid)!.push(conn);
  }

  return order.map((agentUuid) => {
    const conns = byAgent.get(agentUuid)!;
    const hosts = new Set(conns.map((c) => c.host));
    const multiHost = hosts.size > 1;
    return {
      agentUuid,
      agentName: conns[0].agentName,
      clientType: conns[0].clientType,
      connections: conns,
      onlineCount: conns.filter((c) => c.effectiveStatus === "online").length,
      multiHost,
      singleHost: multiHost ? undefined : conns[0].host,
    };
  });
}

/**
 * Keep only the effectively-ONLINE connections. Presence is "what is live right
 * now" — an offline (host, cwd) place is not a presence fact and a legacy
 * null-cwd offline row would otherwise surface as a phantom "unknown path"
 * instance. Filtering centrally here (rather than at each surface) means BOTH
 * the pill popover and the connections-view "View all" render the same
 * online-only set, and an agent that drops to zero online connections simply
 * produces no group (so it disappears from presence rather than lingering as an
 * all-offline row). Pure: no side effects, safe in render/test.
 *
 * NOTE: this does NOT replace the picker/assign online-only filtering (those
 * surfaces already feed `InstancePicker` an online-only candidate set) nor the
 * assign "fully-offline agent → plain notification" path — it is purely the
 * PRESENCE surfaces' online-only filter.
 */
export function onlineConnectionsOnly(
  connections: ConnectionView[],
  executionsByConnection: Record<string, ExecutionView[]> = {},
): ConnectionView[] {
  return sortConnectionsForPresence(
    connections.filter((c) => c.effectiveStatus === "online"),
    executionsByConnection,
  );
}

function connectionActivityRank(
  connection: ConnectionView,
  executions: ExecutionView[],
): number {
  if (connection.effectiveStatus !== "online") return 3;
  if (executions.some((e) => e.status === "running")) return 0;
  if (executions.some((e) => e.status === "queued")) return 1;
  return 2;
}

// The derived activity state of one instance, used to drive both the subline
// text and the status-dot tint. Pure so the branch logic is unit-testable
// independent of React / i18n.
//   - "offline"  → grey dot + "offline · <relative last-seen>"
//   - "running"  → terracotta dot + "<running> · <elapsed>" (earliest running)
//   - "queued"   → green dot + "<N queued>"
//   - "idle"     → green dot + "idle"
export type InstanceActivityState = "offline" | "running" | "queued" | "idle";

export interface InstanceActivity {
  state: InstanceActivityState;
  // For "running": the ISO start of the earliest running execution (drives the
  // elapsed timer). For "queued": the queued count. Null/0 otherwise.
  runningStartedAt: string | null;
  queuedCount: number;
}

/**
 * Derive an instance's activity state from its `effectiveStatus` and its
 * current execution slice. Offline always wins (an offline daemon shows no
 * activity); among online states a running execution outranks a queued one,
 * which outranks idle. The earliest running execution's `startedAt` anchors the
 * elapsed timer (falling back to `createdAt` when a running row has no
 * `startedAt` yet). Pure — no React, no i18n.
 */
export function deriveInstanceActivity(
  connection: ConnectionView,
  executions: ExecutionView[],
): InstanceActivity {
  if (connection.effectiveStatus !== "online") {
    return { state: "offline", runningStartedAt: null, queuedCount: 0 };
  }
  const running = executions.filter((e) => e.status === "running");
  const queued = executions.filter((e) => e.status === "queued");
  if (running.length > 0) {
    // Earliest running first so the elapsed timer reflects the longest-running
    // turn on this instance.
    const earliest = [...running].sort((a, b) =>
      (a.startedAt ?? a.createdAt).localeCompare(b.startedAt ?? b.createdAt),
    )[0];
    return {
      state: "running",
      runningStartedAt: earliest.startedAt ?? earliest.createdAt,
      queuedCount: queued.length,
    };
  }
  if (queued.length > 0) {
    return { state: "queued", runningStartedAt: null, queuedCount: queued.length };
  }
  return { state: "idle", runningStartedAt: null, queuedCount: 0 };
}

// Resolve an instance's activity into a localized subline string + a tinted
// status dot. Kept as a hook (not a component) so the caller composes it into
// the `InstanceRow`'s `activity` / `dot` props. `nowMs` drives the elapsed
// timer for a running instance.
export function useInstanceActivity(
  connection: ConnectionView,
  executions: ExecutionView[],
  nowMs: number,
): { text: string; dot: React.ReactNode } {
  const td = useTranslations("agentPresence.drilldown");
  const formatElapsed = useElapsedMono();
  const formatRelative = useRelativeTime();
  const activity = deriveInstanceActivity(connection, executions);

  switch (activity.state) {
    case "offline":
      return {
        text: td("offlineSince", {
          time: formatRelative(connection.lastSeenAt, nowMs),
        }),
        dot: <StatusDot online={false} size="md" />,
      };
    case "running":
      return {
        text: td("runningFor", {
          time: activity.runningStartedAt
            ? formatElapsed(activity.runningStartedAt, nowMs)
            : "",
        }),
        // Terracotta "busy" dot — distinct from the green online-idle dot so a
        // working instance reads as active at a glance (matches design.pen).
        dot: (
          <span
            aria-hidden
            className="inline-flex h-2.5 w-2.5 rounded-full bg-primary"
          />
        ),
      };
    case "queued":
      return {
        text: td("queuedCount", { count: activity.queuedCount }),
        dot: <StatusDot online size="md" />,
      };
    default:
      return {
        text: td("idle"),
        dot: <StatusDot online size="md" />,
      };
  }
}

// ===== Presentational sub-components =====

// The monospace path chip — the primary per-instance identity. A null cwd
// (legacy daemon) renders the "unknown path" sentinel with a distinct
// folder-x icon; the full absolute path is exposed on hover (title) for a
// known cwd. The chip flex-shrinks (it owns the truncation budget) so it never
// pushes the row's status dot off the row.
export function PathChip({
  cwd,
  formatOptions,
}: {
  cwd: string | null;
  formatOptions?: FormatCwdOptions;
}) {
  const t = useTranslations("agentPresence");
  // Coerce a missing cwd (`undefined`, e.g. a connection projected before the
  // cwd column existed) to the `null` "unknown path" sentinel so the formatter
  // — whose contract is `string | null` — never sees `undefined`.
  const formatted = formatCwd(cwd ?? null, formatOptions);
  // The formatter returns an i18n KEY when the value is unknown — resolve it
  // here so the raw key is never printed. The `agentPresence` namespace is the
  // root because `UNKNOWN_PATH_KEY` is `agentPresence.unknownPath`.
  const label = formatted.isUnknown ? t("unknownPath") : formatted.label;
  const title = formatted.isUnknown ? t("unknownPath") : formatted.title;
  const Icon = formatted.isUnknown ? FolderX : Folder;

  return (
    <span
      title={title}
      className="inline-flex min-w-0 items-center gap-1.5 rounded-md bg-[#F0EDE8] dark:bg-[#1f1e1c] px-2 py-1"
    >
      <Icon className="h-3.5 w-3.5 shrink-0 text-[#9A8E7E]" aria-hidden />
      <span
        className={`min-w-0 truncate font-mono text-[12px] font-semibold ${
          formatted.isUnknown ? "text-muted-foreground" : "text-[#3A3631]"
        }`}
      >
        {label}
      </span>
    </span>
  );
}

// A dimmed monospace host suffix (used only when the agent spans 2+ hosts).
// Right-truncated + width-capped by the T1 formatter; full host on hover.
function HostSuffix({ host }: { host: string }) {
  const t = useTranslations("agentPresence");
  const formatted = formatHost(host);
  const label = formatted.isUnknown ? t("unknownHost") : formatted.label;
  const title = formatted.isUnknown ? t("unknownHost") : formatted.title;
  return (
    <span
      title={title}
      className="inline-flex min-w-0 max-w-[140px] shrink items-center gap-1 truncate font-mono text-[11px] text-muted-foreground"
    >
      <Monitor className="h-3 w-3 shrink-0" aria-hidden />
      <span className="truncate">{label}</span>
    </span>
  );
}

// One instance sub-row: path chip (primary) + a secondary subline that carries
// the per-row host suffix (multi-host agents only) and an optional activity
// string, with the instance's own status dot pinned to the right edge.
//
// `dotColor` lets a caller (the popover) tint the dot for a running instance
// (terracotta) distinctly from an online-idle (green) / offline (grey) one;
// when omitted it falls back to the shared online/offline StatusDot.
export function InstanceRow({
  connection,
  showHost,
  activity,
  dot,
}: {
  connection: ConnectionView;
  // When true (agent spans 2+ hosts), render the per-row host suffix.
  showHost: boolean;
  // Optional activity / status text for the subline (e.g. "building · 01:42",
  // "idle", "offline · 14m ago"). Already localized + formatted by the caller.
  activity?: string;
  // Optional custom dot; when omitted the shared online/offline dot is used.
  dot?: React.ReactNode;
}) {
  const online = connection.effectiveStatus === "online";
  const hasSubline = showHost || !!activity;

  return (
    <div className="flex items-center gap-2.5">
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <PathChip cwd={connection.cwd} />
        {hasSubline && (
          <div className="flex min-w-0 items-center gap-1.5 pl-0.5">
            {showHost && <HostSuffix host={connection.host} />}
            {showHost && activity && (
              <span aria-hidden className="shrink-0 text-[11px] text-[#C9C2B6]">
                ·
              </span>
            )}
            {activity && (
              <span className="min-w-0 truncate text-[11px] text-muted-foreground">
                {activity}
              </span>
            )}
          </div>
        )}
      </div>
      <span className="shrink-0">
        {dot ?? <StatusDot online={online} size="md" />}
      </span>
    </div>
  );
}

// The agent group header: bot tile + agent name + a host-conditional subline
// (single host once, or "client · N hosts" when multi-host) + an instance count
// and the agent's aggregate online dot on the right.
//
// Collapse toggle (T11 / qr1): when `onToggle` is supplied the WHOLE header is a
// real, keyboard-accessible toggle button carrying `aria-expanded`, and the
// chevron rotates to reflect `expanded` (default COLLAPSED — the caller seeds
// `expanded={false}` so the noisy per-cwd rows are hidden until the user opens
// the agent). Without `onToggle` the header is a plain, non-interactive row
// (the chevron is then purely decorative) so static surfaces keep their current
// look. The instance count reflects whatever connection set the caller grouped
// (presence surfaces group online-only, so it reads as the online count).
export function AgentGroupHeader({
  group,
  expanded,
  onToggle,
}: {
  group: AgentInstanceGroup;
  // Current expand state — drives the chevron rotation + `aria-expanded`. Only
  // meaningful when `onToggle` is supplied (an interactive header).
  expanded?: boolean;
  // When supplied, the header becomes a real expand/collapse toggle button.
  onToggle?: () => void;
}) {
  const t = useTranslations("agentPresence");
  const td = useTranslations("agentPresence.drilldown");
  const tc = useTranslations("agentConnections");
  const clientTypeLabel = useClientTypeLabel();

  const agentName = group.agentName?.trim() || tc("unknownAgent");
  const anyOnline = group.onlineCount > 0;
  const interactive = typeof onToggle === "function";

  // Subline: for a single-host agent show the client type + the one host
  // (resolving the host-less "" to "unknown host"); for a multi-host agent show
  // the client type + an "N hosts" count (the per-row host suffix disambiguates
  // the actual hosts).
  const distinctHosts = new Set(group.connections.map((c) => c.host)).size;
  const hostLabel =
    group.singleHost === ""
      ? t("unknownHost")
      : (group.singleHost ?? "");
  const subline = group.multiHost
    ? `${clientTypeLabel(group.clientType)} · ${td("hostsCount", { count: distinctHosts })}`
    : `${clientTypeLabel(group.clientType)} · ${hostLabel}`;

  const inner = (
    <>
      <ChevronDown
        className={`h-4 w-4 shrink-0 text-[#B7AE9F] transition-transform ${
          interactive && expanded ? "rotate-180" : ""
        }`}
        aria-hidden
      />
      {/* Agent identity tile — the shared DiceBear <AgentAvatar> seeded by the
          agent name (replaces the former terracotta/grey Bot glyph). Online/
          offline liveness is still conveyed by the aggregate StatusDot on the
          right of this header, so the tile no longer needs to carry it. */}
      <AgentAvatar name={agentName} size={36} className="rounded-lg" />
      <div className="min-w-0 flex-1 text-left">
        <div className="truncate text-[14px] font-semibold text-foreground">
          {agentName}
        </div>
        <div className="mt-0.5 truncate text-[12px] text-muted-foreground">
          {subline}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <span className="text-[12px] text-muted-foreground">
          {td("instancesCount", { count: group.connections.length })}
        </span>
        <StatusDot online={anyOnline} size="md" />
      </div>
    </>
  );

  if (!interactive) {
    return <div className="flex items-center gap-2.5">{inner}</div>;
  }

  return (
    <Button
      type="button"
      variant="ghost"
      onClick={onToggle}
      aria-expanded={expanded}
      aria-label={
        expanded
          ? td("collapseAgent", { agent: agentName })
          : td("expandAgent", { agent: agentName })
      }
      className="flex h-auto w-full items-center justify-start gap-2.5 rounded-lg px-1.5 py-1 hover:bg-[#FBF4EF] dark:hover:bg-[#26241f]"
    >
      {inner}
    </Button>
  );
}
