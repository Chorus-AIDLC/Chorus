"use client";

// Conversation list — the LEFT pane of the chat-style daemon UI (子3).
//
// Agent-first (elaboration Q2): a small agent Select is the primary axis; below it
// is that agent's conversation list. The dataset is the caller's visible daemon
// sessions (GET /api/daemon-sessions, fetched once by the chat container) — this
// component is presentational and does no fetching. It filters to the selected
// agent, sorts by `lastTurnAt` desc, and paginates CLIENT-SIDE (a page slice + a
// "Load more"): the payload is small and coarse-grained, one row per conversation.
//
// Each row leads with the conversation title (or an idea/ad-hoc fallback label), a
// trigger/source badge is NOT available per-session from the list (the trigger is a
// per-turn property), so the row instead shows a running dot when the conversation
// has a running turn (driven by live transcript status in the container) and a
// relative `lastTurnAt`. Reuses the warm-deck vocabulary + the StatusDot pulse.

import { useTranslations } from "next-intl";
import { MessageCirclePlus, PauseCircle, Sparkles, TriangleAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useNowTick, useRelativeTime } from "../hooks";
import type { SessionTarget } from "../send-instruction-box";
import type { SessionExecStatus } from "./session-execution";

// One selectable agent for the Select: its uuid + a display name resolved from the
// connection list (the session list carries no agentName).
export interface AgentOption {
  agentUuid: string;
  agentName: string;
}

// A conversation list row's display fields, pre-derived by the container so this
// pane stays presentational. `status` is THIS conversation's live execution status
// (running / interrupted / error / idle) — NOT a connection-wide "agent busy" flag.
// `ideaAnchored` drives the small resource badge before an idea conversation's name (an
// ad-hoc conversation — named by the human's opening message — shows no badge).
export interface ConversationRow {
  session: SessionTarget;
  title: string;
  ideaAnchored: boolean;
  status: SessionExecStatus;
}

// The per-conversation status indicator: a running pulse (terracotta), a paused glyph
// for a user-interrupt, an alert glyph for a crash/error, or a quiet idle dot. This is
// the SESSION's state, so two conversations on the same agent can read differently.
function SessionStatusIndicator({ status }: { status: SessionExecStatus }) {
  if (status === "running") {
    return (
      <span aria-hidden className="relative inline-flex h-2.5 w-2.5 items-center justify-center">
        <span className="absolute inline-flex h-full w-full rounded-full bg-[#C67A52] opacity-30 motion-safe:animate-ping" />
        <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-[#C67A52]" />
      </span>
    );
  }
  if (status === "interrupted") {
    return <PauseCircle aria-hidden className="h-3.5 w-3.5 text-[#B45309]" />;
  }
  if (status === "error") {
    return <TriangleAlert aria-hidden className="h-3.5 w-3.5 text-[#DC2626]" />;
  }
  // Idle: a quiet flat dot (no pulse) so the row still has a leading marker.
  return <span aria-hidden className="h-2 w-2 rounded-full bg-[#D7D2C9]" />;
}

function Row({
  row,
  selected,
  onSelect,
  nowMs,
}: {
  row: ConversationRow;
  selected: boolean;
  onSelect: () => void;
  nowMs: number;
}) {
  const t = useTranslations("daemonChat");
  const formatRelative = useRelativeTime();
  // A short status word under the title when the conversation is not idle, so the
  // indicator's meaning is never icon-only (accessible + scannable).
  const statusLabel =
    row.status === "running"
      ? t("running")
      : row.status === "interrupted"
        ? t("statusInterrupted")
        : row.status === "error"
          ? t("statusError")
          : null;
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
        <span className="flex w-2.5 shrink-0 justify-center">
          <SessionStatusIndicator status={row.status} />
        </span>
        <span className="min-w-0 flex-1">
          <span className="flex items-center gap-1.5">
            {row.ideaAnchored && (
              <Badge
                variant="secondary"
                className="shrink-0 gap-1 border-0 bg-[#F3ECFB] px-1.5 py-0 text-[10px] font-medium text-[#7C5BC0]"
              >
                <Sparkles className="h-2.5 w-2.5" aria-hidden />
                {t("badgeIdea")}
              </Badge>
            )}
            <span className="truncate text-[14px] font-semibold text-[#2C2C2C]">
              {row.title}
            </span>
          </span>
          <span className="mt-0.5 flex items-center gap-1.5">
            {statusLabel && (
              <span
                className={`text-[10px] font-semibold uppercase tracking-wide ${
                  row.status === "running"
                    ? "text-[#C67A52]"
                    : row.status === "error"
                      ? "text-[#DC2626]"
                      : "text-[#B45309]"
                }`}
              >
                {statusLabel}
              </span>
            )}
            <span className="truncate font-mono text-[10px] text-[#9A9A9A]">
              {formatRelative(row.session.lastTurnAt, nowMs)}
            </span>
          </span>
        </span>
      </span>
    </Button>
  );
}

export function ConversationList({
  agents,
  selectedAgentUuid,
  onSelectAgent,
  rows,
  selectedSessionUuid,
  onSelectSession,
  onNewConversation,
  visibleCount,
  onLoadMore,
}: {
  agents: AgentOption[];
  selectedAgentUuid: string | null;
  onSelectAgent: (agentUuid: string) => void;
  // The selected agent's conversation rows, already filtered + sorted desc by the
  // container. This pane slices to `visibleCount` for client-side pagination.
  rows: ConversationRow[];
  selectedSessionUuid: string | null;
  onSelectSession: (sessionUuid: string) => void;
  // Start a NEW conversation — clears the selection so the right pane shows the
  // composer. Always offered (chat-app convention) so the user is never one-click
  // away from talking to the agent.
  onNewConversation: () => void;
  // How many rows are currently revealed (the container owns the count + page size
  // so it survives a re-render); "Load more" grows it.
  visibleCount: number;
  onLoadMore: () => void;
}) {
  const t = useTranslations("daemonChat");
  const nowMs = useNowTick();

  const visibleRows = rows.slice(0, visibleCount);
  const hasMore = rows.length > visibleCount;
  // The "New conversation" affordance is active only when an agent is selected and
  // nothing is selected yet (so the right pane is already the composer) — but it
  // remains visible always, just visually marked when it's the current view.
  const composing = selectedSessionUuid === null;

  return (
    <div className="flex h-full flex-col gap-3">
      {/* Agent Select — the primary axis. */}
      <div className="flex flex-col gap-1.5 px-1">
        <span className="text-[11px] font-medium uppercase tracking-wide text-[#9A9A9A]">
          {t("agentSelectLabel")}
        </span>
        <Select
          value={selectedAgentUuid ?? undefined}
          onValueChange={onSelectAgent}
        >
          <SelectTrigger
            aria-label={t("agentSelectLabel")}
            className="w-full rounded-lg border-[#E5E0D8] bg-white text-[13px] text-[#2C2C2C]"
          >
            <SelectValue placeholder={t("agentSelectPlaceholder")} />
          </SelectTrigger>
          <SelectContent>
            {agents.map((a) => (
              <SelectItem key={a.agentUuid} value={a.agentUuid}>
                {a.agentName}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {/* New conversation — the primary action, always present. */}
      <div className="px-1">
        <Button
          type="button"
          onClick={onNewConversation}
          aria-current={composing ? "true" : undefined}
          className={`h-9 w-full justify-center gap-1.5 rounded-lg text-[13px] font-medium ${
            composing
              ? "bg-[#C67A52] text-white hover:bg-[#B56A44]"
              : "border border-[#E5D2C2] bg-[#FBF4EF] text-[#C67A52] hover:bg-[#F6E9DF]"
          }`}
        >
          <MessageCirclePlus className="h-4 w-4" aria-hidden />
          {t("newConversationButton")}
        </Button>
      </div>

      {/* Conversation list card. */}
      <Card className="flex min-h-0 flex-1 flex-col gap-0 overflow-hidden rounded-2xl border-[#E5E0D8] bg-white p-0 shadow-none">
        <div className="flex items-center justify-between px-4 py-3.5">
          <span className="font-mono text-[11px] font-medium uppercase tracking-[1px] text-[#9A9A9A]">
            {t("listHeader")}
          </span>
          <span className="font-mono text-[11px] font-medium text-[#9A9A9A]">
            {rows.length}
          </span>
        </div>
        <div className="h-px w-full bg-[#EFEBE4]" />
        {rows.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-1.5 p-8 text-center">
            <p className="text-[13px] font-medium text-[#6B6B6B]">
              {t("noSessions.title")}
            </p>
            <p className="max-w-[220px] text-[12px] leading-relaxed text-[#9A9A9A]">
              {t("noSessions.body")}
            </p>
          </div>
        ) : (
          <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
            {visibleRows.map((row, idx) => (
              <div key={row.session.uuid}>
                <Row
                  row={row}
                  selected={selectedSessionUuid === row.session.uuid}
                  onSelect={() => onSelectSession(row.session.uuid)}
                  nowMs={nowMs}
                />
                {idx < visibleRows.length - 1 && (
                  <div className="h-px w-full bg-[#F2EEE7]" />
                )}
              </div>
            ))}
            {hasMore && (
              <div className="px-4 py-3">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={onLoadMore}
                  className="h-8 w-full rounded-lg text-[12px] font-medium text-[#C67A52] hover:bg-[#FBF4EF] hover:text-[#C67A52]"
                >
                  {t("loadMore")}
                </Button>
              </div>
            )}
          </div>
        )}
      </Card>
    </div>
  );
}
