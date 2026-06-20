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
//   - Footer: the reused SendInstructionBox (direct-send to the open session +
//     ad-hoc), and — for a running turn whose live execution resolves — the reused
//     ExecutionRow, which carries the shipped Interrupt control. Both are gated on
//     origin-online exactly as the connections deck gates them (the send box does
//     it internally via `originOnline`; the interrupt row only renders when the
//     execution is in the live snapshot, which requires the origin daemon online).
//   - States: a distinct error card on read failure (never a silent empty), a
//     loading state during the first fetch, and a read-only note when the origin is
//     offline.
//
// Live updates are owned by the container (daemon-chat); this pane is presentational
// over the already-patched `turns`.

import { useEffect, useMemo, useRef } from "react";
import { useTranslations } from "next-intl";
import { ChevronDown, ChevronUp, Info, Loader2, Lock, WifiOff } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { IdentityBlock } from "../identity-block";
import { ExecutionRow } from "../execution-row";
import { ConversationReplyBox } from "../send-instruction-box";
import {
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
  // daemon_session:<sessionId>). Rendered with the reused ExecutionRow so its shipped
  // Interrupt + Resume controls appear inline — and ONLY for this conversation's work,
  // so unrelated task cards never crowd the reply box. Does not depend on a per-turn
  // `executionUuid` back-link (which the daemon does not always populate).
  sessionExecutions,
  // Matched by `turn.executionUuid` so an entity-bearing turn can show its deep link.
  executionsByUuid,
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
  hasMoreEarlier: boolean;
  loadingEarlier: boolean;
  onLoadEarlier: () => void;
}) {
  const t = useTranslations("daemonChat");
  const nowMs = useNowTick();
  const formatRelative = useRelativeTime();
  const formatUptime = useUptimeMono();

  const agentName =
    originConnection?.agentName?.trim() || t("roleAgent");

  // Current/last turn status for the header badge — the running turn if any,
  // otherwise the newest turn's status.
  const currentTurn = useMemo(() => {
    const running = turns.find((tn) => tn.status === "running");
    return running ?? turns[turns.length - 1] ?? null;
  }, [turns]);

  // The conversation's controllable executions — its origin connection's CURRENT
  // running / user-interrupted work. ExecutionRow renders the shipped Interrupt
  // (running) and Resume (user-interrupted) controls; we surface these directly off
  // the connection's live slice rather than the per-turn `executionUuid` link, which
  // the daemon does not reliably populate (so the control would otherwise never
  // appear even while the conversation is plainly running). Ordered running-first.
  const controllableExecutions = useMemo(
    () =>
      sessionExecutions
        .filter(
          (e) =>
            e.status === "running" ||
            (e.status === "interrupted" && e.interruptedReason === "user"),
        )
        .sort((a, b) =>
          a.status === b.status ? 0 : a.status === "running" ? -1 : 1,
        ),
    [sessionExecutions],
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
      {/* Header */}
      <div className="flex flex-col gap-3 px-6 py-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <h3 className="truncate text-[17px] font-semibold text-[#2C2C2C]">
              {title}
            </h3>
            <div className="mt-1 flex flex-wrap items-center gap-2">
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
                <span className="inline-flex items-center gap-1 text-[11px] font-medium text-[#C67A52]">
                  <span className="relative inline-flex h-2 w-2 items-center justify-center">
                    <span className="absolute inline-flex h-full w-full rounded-full bg-[#C67A52] opacity-40 motion-safe:animate-ping" />
                    <span className="relative inline-flex h-1 w-1 rounded-full bg-[#C67A52]" />
                  </span>
                  {t("running")}
                </span>
              )}
            </div>
          </div>
        </div>

        {/* Connection details — DEMOTED to a collapsible disclosure, not the
            headline. Holds host / version / uptime / started via the reused
            IdentityBlock + formatters. */}
        {originConnection && (
          <Collapsible>
            <CollapsibleTrigger className="group inline-flex items-center gap-1.5 text-[12px] font-medium text-[#6B6B6B] hover:text-[#2C2C2C]">
              <Info className="h-3.5 w-3.5" aria-hidden />
              {t("detailsLabel")}
              <ChevronDown
                className="h-3.5 w-3.5 transition-transform group-data-[state=open]:rotate-180"
                aria-hidden
              />
            </CollapsibleTrigger>
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
          </Collapsible>
        )}
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
          <div className="flex w-full min-w-0 flex-col gap-5 px-6 py-5">
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

      {/* Footer — the live Interrupt/Resume control(s) for this conversation's
          in-flight work + a PLAIN reply composer (new-conversation/agent/connection
          targeting all live in the left list, so the footer is just "reply here").
          The reply box self-gates on origin-online and shows the read-only reason
          when the daemon is offline. */}
      {!error && session && (
        <div className="flex flex-col gap-3 border-t border-[#EFEBE4] bg-[#FAF8F4] px-6 py-4">
          {controllableExecutions.length > 0 && (
            <ul className="flex flex-col gap-2">
              {controllableExecutions.map((exec) => (
                <ExecutionRow
                  key={exec.uuid}
                  exec={exec}
                  nowMs={nowMs}
                  layout="inline"
                />
              ))}
            </ul>
          )}
          <ConversationReplyBox
            sessionUuid={session.uuid}
            originOnline={originOnline}
            layout="inline"
          />
        </div>
      )}
    </div>
  );
}
