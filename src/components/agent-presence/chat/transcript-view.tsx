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
  Info,
  Loader2,
  Lock,
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
      <div className="text-[10px] font-medium uppercase tracking-wide text-[#9A9A9A]">
        {label}
      </div>
      <div
        className={`mt-0.5 truncate text-[13px] font-medium text-[#2C2C2C] ${mono ? "font-mono" : ""}`}
      >
        {value}
      </div>
    </div>
  );
}

// A one-click "copy this conversation's session id" button for the header. The
// session id IS the `claude --resume` anchor (daemon spawns idea-anchored sessions
// with `--session-id = <idea uuid>`, and ad-hoc sessions carry a server-generated
// uuid) — so copying it lets a human take the conversation over locally. We copy
// the BARE id (not a `claude --resume <id>` command and not a `cd <dir> && …`): cwd
// isn't reported yet, so a full command can't be assembled here. Mirrors the copy
// idiom from `daemon-connect-cta.tsx` (guarded clipboard + 2s Copy→Check + a11y).
//
// Responsive label: on mobile the header is cramped, so at rest the button is
// ICON-ONLY (label hidden) to save space; the moment it's copied it briefly
// reveals the "Copied!" confirmation text (then collapses back after 2s). On
// desktop (≥lg) the label is always shown. `aria-label` + `aria-live` keep it
// accessible at every breakpoint, even while the visible label is hidden.
export function CopySessionIdButton({ sessionId }: { sessionId: string }) {
  const t = useTranslations("daemonChat");
  const [copied, setCopied] = useState(false);
  const label = copied ? t("sessionIdCopied") : t("copySessionId");

  const copy = async () => {
    try {
      // Optional-chain so an unavailable Clipboard API (insecure context, etc.)
      // degrades gracefully — the button just no-ops instead of throwing.
      await navigator.clipboard?.writeText(sessionId);
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
      className="inline-flex h-auto items-center gap-1.5 px-1.5 py-0.5 text-[12px] font-medium text-[#6B6B6B] hover:bg-transparent hover:text-[#2C2C2C]"
    >
      {copied ? (
        <Check className="h-3.5 w-3.5 text-green-600" aria-hidden />
      ) : (
        <Copy className="h-3.5 w-3.5" aria-hidden />
      )}
      {/* Hidden on mobile at rest (icon-only, space-saving); revealed on copy as
          the transient confirmation, and always shown on desktop (≥lg). */}
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
}: {
  session: SessionView | null;
  turns: TurnWithMessagesView[];
  title: string;
  loading: boolean;
  error: boolean;
  originConnection: ConnectionView | null;
  originOnline: boolean;
  sessionExecutions: ExecutionView[];
  executionsByUuid: Map<string, ExecutionView>;
  footerLayout?: "inline" | "stacked";
  hasMoreEarlier: boolean;
  loadingEarlier: boolean;
  onLoadEarlier: () => void;
}) {
  const t = useTranslations("daemonChat");
  const nowMs = useNowTick();
  const formatRelative = useRelativeTime();
  const formatUptime = useUptimeMono();
  const formatElapsed = useElapsedMono();

  const agentName =
    originConnection?.agentName?.trim() || t("roleAgent");

  // Current/last turn status for the header badge — the running turn if any,
  // otherwise the newest turn's status.
  const currentTurn = useMemo(() => {
    const running = turns.find((tn) => tn.status === "running");
    return running ?? turns[turns.length - 1] ?? null;
  }, [turns]);

  // The conversation's single composer-hosted execution — its origin connection's
  // CURRENT in-flight work that the reply box's action row reflects. Priority:
  // running (→ Interrupt) > user-interrupted (→ Resume) > crash-interrupted (→ the
  // "auto-recovers" hint, no Resume). We surface this directly off the connection's
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
      {/* Header — the <h3> title on its own line, then a SINGLE flex-wrap line that
          carries the status badges (active/ended + running pulse + elapsed) AND the
          'Connection details' disclosure trigger together (wrapping only if truly
          unavoidable), saving a vertical row. The collapsible CONTENT still expands
          below the whole line on click. The Collapsible wraps both the inline trigger
          and the content so Radix open/close state binds correctly. */}
      <div className="flex flex-col gap-2 px-6 py-2.5 lg:gap-3 lg:py-4">
        <h3 className="truncate text-[17px] font-semibold text-[#2C2C2C]">
          {title}
        </h3>
        <Collapsible>
          <div className="flex flex-wrap items-center gap-2">
            <Badge
              variant="secondary"
              className={`border-0 px-2 py-0.5 text-[10px] font-medium ${
                sessionEnded
                  ? "bg-[#F0EDE8] text-[#6B6B6B]"
                  : "bg-[#DCFCE7] text-[#15803D]"
              }`}
            >
              {sessionEnded ? t("statusEnded") : t("statusActive")}
            </Badge>
            {currentTurn && currentTurn.status === "running" && (
              <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-[#C67A52]">
                <span className="relative inline-flex h-2 w-2 items-center justify-center">
                  <span className="absolute inline-flex h-full w-full rounded-full bg-[#C67A52] opacity-40 motion-safe:animate-ping" />
                  <span className="relative inline-flex h-1 w-1 rounded-full bg-[#C67A52]" />
                </span>
                {t("running")}
                {/* Live elapsed run time of the conversation's running execution —
                    ticks every second off `useNowTick()` (no deep-link; the <h3>
                    header title stays the only navigational affordance). */}
                {runningExecution?.startedAt && (
                  <span
                    className="font-mono tabular-nums text-[#C67A52]"
                    title={t("runningElapsedLabel")}
                  >
                    {formatElapsed(runningExecution.startedAt, nowMs)}
                  </span>
                )}
              </span>
            )}
            {/* Right-aligned action group — the "Copy session ID" button and the
                "Connection details" disclosure trigger sit ADJACENT at the end of the
                status line. `ml-auto` lives on this wrapper (not on the trigger) so the
                two stay grouped together rather than splitting to opposite ends. The
                copy button is gated on `session` (an offline conversation can still be
                resumed locally, so its id is still worth copying); the details trigger
                is gated on `originConnection` (there's nothing to disclose without it). */}
            {(session || originConnection) && (
              <div className="ml-auto flex items-center gap-1">
                {session && (
                  <CopySessionIdButton sessionId={session.sessionId} />
                )}
                {/* Connection details — DEMOTED to a collapsible disclosure that shares
                    the status line. The content (host / version / uptime / started via
                    the reused IdentityBlock + formatters) expands below the line. */}
                {originConnection && (
                  <CollapsibleTrigger className="group inline-flex items-center gap-1.5 text-[12px] font-medium text-[#6B6B6B] hover:text-[#2C2C2C]">
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
          {originConnection && (
            <CollapsibleContent>
              <div className="mt-3 flex flex-col gap-3 rounded-xl border border-[#EFEBE4] bg-[#FCFBF8] p-4">
                <IdentityBlock connection={originConnection} size="sm" />
                <div className="grid grid-cols-2 gap-3">
                  {originOnline && (
                    <DetailField
                      label={t("detailUptime")}
                      value={formatUptime(originConnection.connectedAt, nowMs)}
                      mono
                    />
                  )}
                  <DetailField
                    label={t("detailHost")}
                    value={
                      originConnection.host === ""
                        ? t("detailsHostUnknown")
                        : originConnection.host
                    }
                    mono
                  />
                  {originConnection.startedAt && (
                    <DetailField
                      label={t("detailStarted")}
                      value={formatRelative(originConnection.startedAt, nowMs)}
                    />
                  )}
                </div>
              </div>
            </CollapsibleContent>
          )}
        </Collapsible>
      </div>
      <div className="h-px w-full bg-[#EFEBE4]" />

      {/* Body */}
      {error ? (
        // Distinct error card — never a silent empty (no-silent-error contract).
        <div className="flex flex-1 items-center justify-center p-8">
          <Card className="items-center gap-3 rounded-2xl border-[#E7D9C9] bg-[#FFF9F3] p-8 text-center shadow-none">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-[#D9770615]">
              <WifiOff className="h-6 w-6 text-[#B45309]" />
            </div>
            <h4 className="text-base font-semibold text-[#92400E]">
              {t("loadErrorTitle")}
            </h4>
            <p className="max-w-md text-[13px] leading-relaxed text-[#6B6B6B]">
              {t("loadErrorBody")}
            </p>
          </Card>
        </div>
      ) : loading ? (
        <div className="flex flex-1 items-center justify-center p-8 text-[13px] text-[#9A9A9A]">
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
            <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-[#9A9A9A]">
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
                  className="h-8 gap-1.5 rounded-lg text-[12px] font-medium text-[#C67A52] hover:bg-[#FBF4EF] hover:text-[#C67A52]"
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
            {turns.map((turn) => (
              <TurnBand
                key={turn.uuid}
                turn={turn}
                agentName={agentName}
                linkedExecution={
                  turn.executionUuid
                    ? executionsByUuid.get(turn.executionUuid) ?? null
                    : null
                }
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
        <div className="flex flex-col gap-3 border-t border-[#EFEBE4] bg-[#FAF8F4] px-6 py-2.5 lg:py-4">
          <ConversationReplyBox
            sessionUuid={session.uuid}
            originOnline={originOnline}
            layout={footerLayout}
            controllableExecution={composerExecution}
          />
        </div>
      )}
    </div>
  );
}
