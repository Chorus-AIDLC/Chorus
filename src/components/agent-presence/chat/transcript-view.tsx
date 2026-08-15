"use client";

// Transcript view — the RIGHT pane of the chat-style daemon UI (子3).
//
// Composition:
//   - Header: the conversation title + its current/last turn status, plus a
//     Collapsible "Connection details" disclosure that DEMOTES the host / version /
//     uptime / started metadata out of the headline (reusing IdentityBlock + the
//     duration/relative formatters). The metadata is no longer competing tiles — it
//     is a secondary disclosure, per the design brief.
//   - Body: the turn bands in a ScrollArea, auto-scrolled to the newest turn. The
//     turn band is the signature element (see turn-band.tsx).
//   - Footer: input + actions ONLY — the reused ConversationReplyBox, whose
//     bottom-right action row now HOSTS this conversation's Interrupt / Resume
//     control (no standalone ExecutionRow card stacked above it any more). The
//     running marker + elapsed time live in the HEADER (prior task). Send is gated
//     on origin-online internally (`originOnline`); Interrupt/Resume reuse the
//     shipped controls and only resolve when the execution is in the live snapshot
//     (which requires the origin daemon online).
//   - States: a distinct error card on read failure (never a silent empty), a
//     loading state during the first fetch, and a read-only note when the origin is
//     offline.
//
// Live updates are owned by the container (daemon-chat); this pane is presentational
// over the already-patched `turns`.

import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import {
  Check,
  ChevronDown,
  ChevronUp,
  Copy,
  Folder,
  Info,
  Loader2,
  Lock,
  Server,
  WifiOff,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { clientLogger } from "@/lib/logger-client";
import { formatCwd, formatHost } from "@/lib/daemon-instance-format";
import { SessionUsageBadge } from "./token-usage-badge";
import { IdentityBlock } from "../identity-block";
import { ConversationReplyBox } from "../send-instruction-box";
import {
  useElapsedMono,
  useNowTick,
  useRelativeTime,
  useUptimeMono,
} from "../hooks";
import type { ConnectionView, ExecutionView } from "../types";
import type {
  SessionView,
  TurnWithMessagesView,
} from "@/services/daemon-session.service";
import { TurnBand } from "./turn-band";

// A render group: an absorbing turn plus the coalesced-away `merged` turns folded into it.
// Wake coalescing settles the next N-1 same-session pending turns (by ascending seq,
// immediately after the absorbing turn) to `merged`, so the transcript collapses a
// contiguous run of `merged` turns into the immediately-preceding non-merged turn. Pure
// front-end seq-adjacency — no server back-link, no migration (idea 9ea96d38 q2).
export interface TurnGroup {
  absorbing: TurnWithMessagesView;
  merged: TurnWithMessagesView[];
}

// Single O(n) pass over the ascending-by-seq turn list. A `merged` turn folds into the
// most recent NON-merged group; a `merged` turn with no such anchor (a leading run whose
// absorbing turn is outside the loaded window) becomes its OWN standalone group — never
// dropped, and never an anchor for a later merged turn (a merged turn cannot absorb
// another).
export function groupMergedTurns(turns: TurnWithMessagesView[]): TurnGroup[] {
  const groups: TurnGroup[] = [];
  for (const turn of turns) {
    const last = groups[groups.length - 1];
    if (turn.status === "merged" && last && last.absorbing.status !== "merged") {
      last.merged.push(turn);
    } else {
      groups.push({ absorbing: turn, merged: [] });
    }
  }
  return groups;
}

// One labeled metadata field inside the collapsed details disclosure.
function DetailField({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div>
      <div className="text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div
        className={`mt-0.5 truncate text-[13px] font-medium text-foreground ${mono ? "font-mono" : ""}`}
      >
        {value}
      </div>
    </div>
  );
}

// The conversation's INSTANCE IDENTITY chip, shown inline in the header beneath the
// title: path-first (the origin connection's cwd is what makes this conversation a
// distinct (agent, host, cwd) instance), via the shared T1 `formatCwd` truncation
// contract. A legacy daemon that never self-reported a cwd renders the localized
// "unknown path" treatment (formatCwd(null), reusing agentPresence.unknownPath) so the
// chip never silently disappears. Host stays DEMOTED to the "Connection details"
// disclosure and is only surfaced here — as a second, de-emphasized badge — when
// `crossHost` is true (the same agent spans multiple hosts, so the path alone is
// ambiguous). The full path / host is exposed as a hover title.
function InstanceIdentity({
  cwd,
  host,
  crossHost,
}: {
  cwd: string | null;
  host: string;
  crossHost: boolean;
}) {
  // Root-scoped resolver: formatCwd/formatHost return i18n KEYS (e.g.
  // "agentPresence.unknownPath") for unknown values, so we resolve them off the message
  // root rather than a single namespace.
  const tRoot = useTranslations();
  const th = useTranslations("transcriptHeader");

  const cwdFmt = formatCwd(cwd);
  const cwdLabel = cwdFmt.isUnknown ? tRoot(cwdFmt.label) : cwdFmt.label;
  const cwdTitle = cwdFmt.isUnknown ? tRoot(cwdFmt.title) : cwdFmt.title;

  const hostFmt = crossHost ? formatHost(host) : null;
  const hostLabel = hostFmt
    ? hostFmt.isUnknown
      ? tRoot(hostFmt.label)
      : hostFmt.label
    : null;
  const hostTitle = hostFmt
    ? hostFmt.isUnknown
      ? tRoot(hostFmt.title)
      : hostFmt.title
    : null;

  return (
    <div className="flex min-w-0 flex-wrap items-center gap-1.5">
      <span
        className={`inline-flex max-w-full items-center gap-1.5 rounded-md bg-[#F1ECE3] dark:bg-[#201e1a] px-2 py-0.5 ${
          cwdFmt.isUnknown ? "italic text-muted-foreground" : "text-muted-foreground"
        }`}
        title={`${th("cwdAriaLabel")}: ${cwdTitle}`}
        aria-label={`${th("cwdAriaLabel")}: ${cwdTitle}`}
      >
        <Folder className="h-3 w-3 shrink-0 text-[#9A8C7E]" aria-hidden />
        <span className="truncate font-mono text-[11px] font-medium">
          {cwdLabel}
        </span>
      </span>
      {hostLabel !== null && (
        <span
          className="inline-flex max-w-full items-center gap-1 text-[11px] font-medium text-muted-foreground"
          title={`${th("hostAriaLabel")}: ${hostTitle}`}
          aria-label={`${th("hostAriaLabel")}: ${hostTitle}`}
        >
          <Server className="h-3 w-3 shrink-0" aria-hidden />
          <span className={`truncate ${hostFmt?.isUnknown ? "italic" : ""}`}>
            {hostLabel}
          </span>
        </span>
      )}
    </div>
  );
}

// Keep the established copy control while using the backend-owned resume ID.
export function CopySessionIdButton({
  backendSessionId,
}: {
  backendSessionId: string;
}) {
  const t = useTranslations("daemonChat");
  const [copied, setCopied] = useState(false);
  const label = copied ? t("sessionIdCopied") : t("copySessionId");

  const copy = async () => {
    try {
      // Optional-chain so an unavailable Clipboard API (insecure context, etc.)
      // degrades gracefully — the button just no-ops instead of throwing.
      await navigator.clipboard?.writeText(backendSessionId);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      clientLogger.error("Failed to copy session id:", error);
    }
  };

  return (
    <Button
      variant="ghost"
      size="sm"
      onClick={copy}
      title={label}
      aria-label={label}
      aria-live="polite"
      className="inline-flex h-auto items-center gap-1.5 px-1.5 py-0.5 text-[12px] font-medium text-muted-foreground hover:bg-transparent hover:text-foreground"
    >
      {copied ? (
        <Check className="h-3.5 w-3.5 text-green-600" aria-hidden />
      ) : (
        <Copy className="h-3.5 w-3.5" aria-hidden />
      )}
      <span className={copied ? "inline" : "hidden lg:inline"}>{label}</span>
    </Button>
  );
}

export function TranscriptView({
  session,
  turns,
  title,
  loading,
  error,
  // The origin connection of this session (resolved from the connection list by
  // the container), or null when it isn't currently known. Drives the read-only
  // note + the details disclosure. When online, the send box + interrupt are live.
  originConnection,
  originOnline,
  // True when the origin agent currently spans MORE THAN ONE distinct host. The header is
  // path-first (cwd is the instance identity) and host normally lives only in the
  // "Connection details" disclosure; we promote host INLINE beside the path chip only when
  // it actually disambiguates — i.e. this same agent is connected on multiple hosts, so a
  // bare path could belong to either. Resolved by the container from the connection set.
  originCrossHost = false,
  // THIS conversation's CURRENT live executions (running / interrupted), already
  // filtered to the open session by the container (idea:<directIdeaUuid> or
  // daemon_session:<sessionId>). The single relevant one is threaded into the reply
  // composer's action row so its shipped Interrupt / Resume control appears beside
  // Send — and ONLY for this conversation's work, so unrelated task cards never crowd
  // the reply box. Does not depend on a per-turn `executionUuid` back-link (which the
  // daemon does not always populate).
  sessionExecutions,
  // Matched by `turn.executionUuid` so an entity-bearing turn can show its deep link.
  executionsByUuid,
  // The reply composer's action-row geometry: "inline" (desktop two-pane — actions on
  // the footer line) vs "stacked" (mobile drill-down — actions beneath the textarea).
  // A single TranscriptView instance is reused across breakpoints, so the container
  // passes the right value per surface rather than this pane sniffing the viewport.
  footerLayout = "inline",
  // Older-page pagination: `hasMoreEarlier` shows a "load earlier" affordance at the
  // TOP of the transcript; `onLoadEarlier` fetches+prepends the previous page; while
  // `loadingEarlier` the control shows a spinner. The newest page loads first, so a
  // long coding-agent history never renders all at once.
  hasMoreEarlier,
  loadingEarlier,
  onLoadEarlier,
  // Origin-offline escape hatch (T11 / qr3): the origin agent's currently-online
  // connections. When the origin is offline BUT this set is non-empty, the reply box
  // offers a "Continue on an online directory" action that starts a NEW conversation
  // on a chosen online instance (the original stays read-only history). Empty → plain
  // read-only. `onSessionStarted` hands the new session back to the container to
  // auto-select it.
  originAgentOnlineConnections = [],
  onSessionStarted,
}: {
  session: SessionView | null;
  turns: TurnWithMessagesView[];
  title: string;
  loading: boolean;
  error: boolean;
  originConnection: ConnectionView | null;
  originOnline: boolean;
  originCrossHost?: boolean;
  sessionExecutions: ExecutionView[];
  executionsByUuid: Map<string, ExecutionView>;
  footerLayout?: "inline" | "stacked";
  hasMoreEarlier: boolean;
  loadingEarlier: boolean;
  onLoadEarlier: () => void;
  originAgentOnlineConnections?: ConnectionView[];
  onSessionStarted?: (session: SessionView) => void;
}) {
  const t = useTranslations("daemonChat");
  const nowMs = useNowTick();
  const formatRelative = useRelativeTime();
  const formatUptime = useUptimeMono();
  const formatElapsed = useElapsedMono();

  const agentName =
    originConnection?.agentName?.trim() || t("roleAgent");
  const displayConnection =
    originConnection && session?.runtimeCwd
      ? { ...originConnection, cwd: session.runtimeCwd }
      : originConnection;

  // Current/last turn status for the header badge — the running turn if any,
  // otherwise the newest turn's status.
  const currentTurn = useMemo(() => {
    const running = turns.find((tn) => tn.status === "running");
    return running ?? turns[turns.length - 1] ?? null;
  }, [turns]);

  // Collapse contiguous coalesced-away `merged` runs into their absorbing turn so a
  // wake-coalescing batch reads as ONE band (with an expandable "merged N events"
  // section) rather than a string of empty bands. Pure presentational grouping.
  const turnGroups = useMemo(() => groupMergedTurns(turns), [turns]);

  // Conversation token usage (daemon-token-usage): the header renders the SAME badge a turn
  // shows — a compact in+out SUM on the face, with the full breakdown (Input / Output /
  // Cache read / Cache write) in the hover/tap tooltip. All four come from the session's
  // authoritative scalar rollup, so every figure — face and tooltip — is at the SAME
  // whole-session scope (covering paginated-out turns too), with no scope mismatch. Cache is
  // in the tooltip only, never folded into the face sum (cache-read can be 100× input).
  const totalInputTokens = session?.totalInputTokens ?? 0;
  const totalOutputTokens = session?.totalOutputTokens ?? 0;
  const totalCacheReadTokens = session?.totalCacheReadTokens ?? 0;
  const totalCacheCreationTokens = session?.totalCacheCreationTokens ?? 0;

  // The conversation's single composer-hosted execution — its origin connection's
  // CURRENT in-flight work that the reply box's action row reflects. Priority:
  // running (→ Interrupt) > user-interrupted (→ Resume) > crash-interrupted (→ the
  // "exited with error" label + Resume). We surface this directly off the connection's
  // live slice rather than the per-turn `executionUuid` link, which the daemon does
  // not reliably populate (so the control would otherwise never appear even while the
  // conversation is plainly running). Null when the conversation is idle (just Send).
  const composerExecution = useMemo(() => {
    const running = sessionExecutions.find((e) => e.status === "running");
    if (running) return running;
    const userInterrupted = sessionExecutions.find(
      (e) => e.status === "interrupted" && e.interruptedReason === "user",
    );
    if (userInterrupted) return userInterrupted;
    const crashInterrupted = sessionExecutions.find(
      (e) => e.status === "interrupted" && e.interruptedReason === "crash",
    );
    return crashInterrupted ?? null;
  }, [sessionExecutions]);

  // The conversation's CURRENTLY-running execution. Its `startedAt` feeds the live
  // elapsed timer beside the header pulse — same `useElapsedMono()` / `nowMs`
  // formatter the execution rows use, so the header time and the composer's
  // Interrupt control reflect the same run.
  const runningExecution = useMemo(
    () =>
      composerExecution && composerExecution.status === "running"
        ? composerExecution
        : null,
    [composerExecution],
  );

  // Auto-scroll the transcript to the newest turn when the turn list grows or
  // messages append. A ref to the scroll viewport's bottom sentinel.
  const bottomRef = useRef<HTMLDivElement | null>(null);
  const lastTurnUuid = turns[turns.length - 1]?.uuid;
  const lastMsgCount = turns[turns.length - 1]?.messages.length ?? 0;
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ block: "end" });
  }, [lastTurnUuid, lastMsgCount]);

  // The status label for the header (active/ended on the session, plus a live
  // running marker driven by the current turn).
  const sessionEnded = session?.status === "ended";

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Header — the title row carries the <h3> on the LEFT and the path-first instance
          identity chip RIGHT-ALIGNED on the SAME line (justify-between), then a SINGLE
          flex-wrap line below that carries the status badges (active/ended + running pulse
          + elapsed) AND the 'Connection details' disclosure trigger together (wrapping only
          if truly unavoidable). Two rows, not three. The collapsible CONTENT still expands
          below the whole line on click. The Collapsible wraps both the inline trigger and
          the content so Radix open/close state binds correctly. */}
      <div className="flex flex-col gap-2 px-6 py-2.5 lg:gap-3 lg:py-4">
        {/* Title row: title left (truncates), instance-identity chip right (shrink-0). The
            cwd path is the conversation's working-directory identity, so it shares the title
            line rather than claiming its own full-width row. Host stays in the "Connection
            details" disclosure below and only re-surfaces in the chip when the agent spans
            multiple hosts (`originCrossHost`). The chip is gated on `originConnection` —
            without one there is no instance to identify. */}
        <div className="flex items-center justify-between gap-4">
          <h3 className="truncate text-[17px] font-semibold text-foreground min-w-0">
            {title}
          </h3>
          {displayConnection && (
            <div className="shrink-0">
              <InstanceIdentity
                cwd={displayConnection.cwd}
                host={displayConnection.host}
                crossHost={originCrossHost}
              />
            </div>
          )}
        </div>
        <Collapsible>
          <div className="flex flex-wrap items-center gap-2">
            <Badge
              variant="secondary"
              className={`border-0 px-2 py-0.5 text-[10px] font-medium ${
                sessionEnded
                  ? "bg-[#F0EDE8] dark:bg-[#1f1e1c] text-muted-foreground"
                  : "bg-[#DCFCE7] dark:bg-[#13291d] text-[#15803D] dark:text-[#4FD07A]"
              }`}
            >
              {sessionEnded ? t("statusEnded") : t("statusActive")}
            </Badge>
            {currentTurn && currentTurn.status === "running" && (
              <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-primary">
                <span className="relative inline-flex h-2 w-2 items-center justify-center">
                  <span className="absolute inline-flex h-full w-full rounded-full bg-primary opacity-40 motion-safe:animate-ping" />
                  <span className="relative inline-flex h-1 w-1 rounded-full bg-primary" />
                </span>
                {/* The word "Running" is hidden < sm so the status row doesn't wrap on
                    mobile once the token badge is present; the pulse dot + elapsed timer
                    already convey "running" in the tight space. Full label shows ≥ sm. */}
                <span className="hidden sm:inline">{t("running")}</span>
                {/* Live elapsed run time of the conversation's running execution —
                    ticks every second off `useNowTick()` (no deep-link; the <h3>
                    header title stays the only navigational affordance). */}
                {runningExecution?.startedAt && (
                  <span
                    className="font-mono tabular-nums text-primary"
                    title={t("runningElapsedLabel")}
                  >
                    {formatElapsed(runningExecution.startedAt, nowMs)}
                  </span>
                )}
              </span>
            )}
            {/* Conversation token usage (daemon-token-usage): the SAME badge a turn shows —
                a compact SUMMED total (input+output) with the breakdown on hover/tap — driven
                by the session rollup. `SessionUsageBadge` renders nothing when the rollup is
                all-zero, so an all-silent conversation stays clean. Cache is per-turn only. */}
            <SessionUsageBadge
              totalInputTokens={totalInputTokens}
              totalOutputTokens={totalOutputTokens}
              totalCacheReadTokens={totalCacheReadTokens}
              totalCacheCreationTokens={totalCacheCreationTokens}
            />
            {/* Right-aligned action group — the session copy action and the
                "Connection details" disclosure trigger sit ADJACENT at the end of the
                status line. The copy action exists only for a usable backend resume ID. */}
            {(session?.backendSessionId || originConnection) && (
              <div className="ml-auto flex items-center gap-1">
                {session?.backendSessionId && (
                  <CopySessionIdButton
                    backendSessionId={session.backendSessionId}
                  />
                )}
                {/* Connection details — DEMOTED to a collapsible disclosure that shares
                    the status line. The content (host / version / uptime / started via
                    the reused IdentityBlock + formatters) expands below the line. */}
                {originConnection && (
                  <CollapsibleTrigger className="group inline-flex items-center gap-1.5 text-[12px] font-medium text-muted-foreground hover:text-foreground">
                    <Info className="h-3.5 w-3.5" aria-hidden />
                    {t("detailsLabel")}
                    <ChevronDown
                      className="h-3.5 w-3.5 transition-transform group-data-[state=open]:rotate-180"
                      aria-hidden
                    />
                  </CollapsibleTrigger>
                )}
              </div>
            )}
          </div>
          {displayConnection && (
            <CollapsibleContent>
              <div className="mt-3 flex flex-col gap-3 rounded-xl border border-[#EFEBE4] dark:border-[#2a2a2e] bg-[#FCFBF8] dark:bg-[#1e1d1b] p-4">
                <IdentityBlock connection={displayConnection} size="sm" />
                <div className="grid grid-cols-2 gap-3">
                  {originOnline && (
                    <DetailField
                      label={t("detailUptime")}
                      value={formatUptime(displayConnection.connectedAt, nowMs)}
                      mono
                    />
                  )}
                  <DetailField
                    label={t("detailHost")}
                    value={
                      displayConnection.host === ""
                        ? t("detailsHostUnknown")
                        : displayConnection.host
                    }
                    mono
                  />
                  {displayConnection.startedAt && (
                    <DetailField
                      label={t("detailStarted")}
                      value={formatRelative(displayConnection.startedAt, nowMs)}
                    />
                  )}
                </div>
              </div>
            </CollapsibleContent>
          )}
        </Collapsible>
      </div>
      <div className="h-px w-full bg-[#EFEBE4] dark:bg-[#201e1b]" />

      {/* Body */}
      {error ? (
        // Distinct error card — never a silent empty (no-silent-error contract).
        <div className="flex flex-1 items-center justify-center p-8">
          <Card className="items-center gap-3 rounded-2xl border-[#E7D9C9] dark:border-[#33302a] bg-[#FFF9F3] dark:bg-[#2a2113] p-8 text-center shadow-none">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-[#D9770615]">
              <WifiOff className="h-6 w-6 text-[#B45309] dark:text-[#E0A34E]" />
            </div>
            <h4 className="text-base font-semibold text-[#92400E] dark:text-[#E0A34E]">
              {t("loadErrorTitle")}
            </h4>
            <p className="max-w-md text-[13px] leading-relaxed text-muted-foreground">
              {t("loadErrorBody")}
            </p>
          </Card>
        </div>
      ) : loading ? (
        <div className="flex flex-1 items-center justify-center p-8 text-[13px] text-muted-foreground">
          {t("transcriptLoading")}
        </div>
      ) : (
        // `daemon-transcript-scroll`: Radix `ScrollArea.Viewport` injects a content
        // wrapper styled inline `display:table; min-width:100%`. A `display:table`
        // box sizes to its content's max-content width, so a wide transcript block
        // (a markdown TABLE, a long code block) makes that wrapper — and every
        // descendant — grow past the viewport; the `min-w-0` chain below cannot
        // shrink anything under an unbounded `display:table` ancestor, so the block
        // is clipped by the viewport's `overflow-x:hidden` and reads as "wider than
        // the screen" on mobile. A scoped rule in globals.css overrides that injected
        // child to `display:block` (keyed by this class, NOT by editing the shared
        // ui/scroll-area component), which re-bounds it to the viewport width, lets
        // the `min-w-0` chain bite, and lets Streamdown's own `overflow-x:auto`
        // table wrapper scroll within its own region. Verified by live mobile-viewport
        // DOM measurement (a 3000px-wide table: the pane no longer overflows; the
        // table scrolls inside its own region).
        <ScrollArea className="daemon-transcript-scroll min-h-0 w-full flex-1">
          {/* `min-w-0` keeps this column from expanding to a wide child's
              min-content width (e.g. a wide transcript table) — paired with the
              `display:block` override on the Radix viewport child (see the
              `daemon-transcript-scroll` rule in globals.css); without that override
              this alone is insufficient, since the viewport child is `display:table`
              and sizes to content regardless of `min-w-0`. */}
          <div className="flex w-full min-w-0 flex-col gap-3 px-6 py-3 lg:gap-5 lg:py-5">
            {/* Privacy note — once per pane: the transcript is daemon-self-reported. */}
            <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-muted-foreground">
              <Lock className="mt-0.5 h-3 w-3 shrink-0" aria-hidden />
              <span>{t("privacyNote")}</span>
            </p>
            {/* Load-earlier — at the TOP so older turns prepend above the loaded window.
                The newest page renders first; a long history is never loaded all at
                once. Hidden once there is nothing earlier to fetch. */}
            {hasMoreEarlier && (
              <div className="flex justify-center">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={onLoadEarlier}
                  disabled={loadingEarlier}
                  className="h-8 gap-1.5 rounded-lg text-[12px] font-medium text-primary hover:bg-[#FBF4EF] dark:hover:bg-[#26241f] hover:text-primary"
                >
                  {loadingEarlier ? (
                    <Loader2 className="h-3.5 w-3.5 motion-safe:animate-spin" aria-hidden />
                  ) : (
                    <ChevronUp className="h-3.5 w-3.5" aria-hidden />
                  )}
                  {loadingEarlier ? t("loadingEarlier") : t("loadEarlier")}
                </Button>
              </div>
            )}
            {turnGroups.map((group) => (
              <TurnBand
                key={group.absorbing.uuid}
                turn={group.absorbing}
                agentName={agentName}
                linkedExecution={
                  group.absorbing.executionUuid
                    ? executionsByUuid.get(group.absorbing.executionUuid) ?? null
                    : null
                }
                mergedEvents={group.merged.map((m) => ({
                  turn: m,
                  linkedExecution: m.executionUuid
                    ? executionsByUuid.get(m.executionUuid) ?? null
                    : null,
                }))}
              />
            ))}
            <div ref={bottomRef} />
          </div>
        </ScrollArea>
      )}

      {/* Footer — input + actions ONLY. The reply composer's bottom-right action row
          hosts this conversation's Interrupt / Resume control (running / interrupted);
          there is no standalone ExecutionRow card stacked above it any more (the
          running marker + elapsed time live in the header). New-conversation / agent /
          connection targeting all live in the left list, so the footer is just "reply
          here". The reply box self-gates on origin-online and shows the read-only
          reason when the daemon is offline; while running the textarea stays usable. */}
      {!error && session && (
        <div className="flex flex-col gap-3 border-t border-[#EFEBE4] dark:border-[#2a2a2e] bg-background px-6 py-2.5 lg:py-4">
          <ConversationReplyBox
            sessionUuid={session.uuid}
            originOnline={originOnline}
            layout={footerLayout}
            controllableExecution={composerExecution}
            agentUuid={originConnection?.agentUuid ?? null}
            onlineConnections={originAgentOnlineConnections}
            onSessionStarted={onSessionStarted}
          />
        </div>
      )}
    </div>
  );
}
