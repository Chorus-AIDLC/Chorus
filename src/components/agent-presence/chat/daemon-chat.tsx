"use client";

// Daemon Chat — the two-pane composition that REPLACES the master-detail
// connections view as the "View all" modal body (子3 — chat-style daemon UI).
//
// Left pane: an agent Select + that agent's conversation list (agent-first, Q2),
// newest-first by `lastTurnAt`, client-side paginated. Right pane: the selected
// conversation's turn-by-turn transcript (header + collapsible details + bands +
// footer with the reused send box + interrupt).
//
// Data:
//   - The conversation LIST is `GET /api/daemon-sessions` (the same endpoint the
//     send box's targeting uses), fetched here on mount + a 15s refresh so a
//     session's `originOnline` + a new conversation re-settle (matching the
//     connections view's session-poll cadence). Connections (for agent names + the
//     ad-hoc online set) come from the shell-level provider — single poll, no
//     second connection fetch here.
//   - The transcript DETAIL is `GET /api/daemon-sessions/[uuid]` on selection.
//   - LIVE updates flow through the AgentPresenceProvider API (NOT a realtime-context
//     hook — the modal lives under AgentPresenceProvider, OUTSIDE every
//     RealtimeProvider, so a realtime-context transcript hook would silently no-op):
//     `setOpenSession(uuid)` reconnects the shell stream with `?sessionUuid=` so the
//     server subscribes that one transcript channel, and `subscribeTranscript(cb)`
//     fans the `turn_created` / `turn_status_changed` / `transcript_appended`
//     triggers into the open conversation — appending a band, patching a band's
//     status in place, or growing a turn's message tail, all without polling.
//
// Responsive: desktop two-pane (lg+); mobile list → drill-down detail (< lg),
// reusing the connections view's breakpoint pattern (a `mobileDetailOpen` flag,
// selection survives back).

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { ChevronLeft, MessagesSquare, WifiOff } from "lucide-react";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { authFetch } from "@/lib/auth-client";
import { clientLogger } from "@/lib/logger-client";
import { useAgentPresence } from "@/contexts/agent-presence-context";
import type { ExecutionView } from "../types";
import type { SessionTarget } from "../send-instruction-box";
import type {
  SessionDetailView,
  SessionView,
  TranscriptMessageView,
  TurnWithMessagesView,
} from "@/services/daemon-session.service";
import {
  ConversationList,
  type AgentOption,
  type ConversationRow,
} from "./conversation-list";
import { TranscriptView } from "./transcript-view";
import { NewConversationPane } from "./new-conversation-pane";
import { executionsForSession, sessionExecStatus } from "./session-execution";

const PAGE_SIZE = 12;

// Max length of an ad-hoc conversation's derived name (its opening instruction, clamped)
// — module scope (not re-created per render) and matching the server's
// CONVERSATION_NAME_MAX so the list/popover/footer name a conversation identically.
const ADHOC_NAME_MAX = 60;

// Clamp an opening instruction to a scannable one-line conversation name (collapse
// whitespace + truncate). Mirrors the server's `conversationNameFromInstruction`.
function clampInstructionName(opener: string): string {
  const flat = opener.replace(/\s+/g, " ").trim();
  return flat.length > ADHOC_NAME_MAX
    ? `${flat.slice(0, ADHOC_NAME_MAX).trimEnd()}…`
    : flat;
}

// Apply one live transcript event to the open conversation's turns. Pure (returns a
// new array) so it is trivially testable and React detects the change:
//  - turn_created  → append the new band (idempotent: replace if it already exists)
//  - turn_status_changed → patch that band's status/timestamps in place
//  - transcript_appended → append the event's message tail to the affected turn,
//    de-duped by message uuid (so a re-delivered event doesn't double-render)
// Insert a turn into an ascending-by-`seq` array at its correct position (NOT blindly
// appended). The transcript is rendered + paginated assuming ascending seq — `loadEarlier`
// uses `turns[0].seq` as the older-page cursor and the transcript header/auto-scroll use
// `turns[turns.length - 1]` as the newest turn — so a materialized turn with a lower seq
// than the loaded window must land in order, not at the end. Returns a NEW array.
function insertTurnBySeq(
  turns: TurnWithMessagesView[],
  incoming: TurnWithMessagesView,
): TurnWithMessagesView[] {
  // Newest-turn fast path (the overwhelmingly common live case: a brand-new turn).
  if (turns.length === 0 || incoming.seq > turns[turns.length - 1].seq) {
    return [...turns, incoming];
  }
  const at = turns.findIndex((tn) => tn.seq > incoming.seq);
  const pos = at === -1 ? turns.length : at;
  return [...turns.slice(0, pos), incoming, ...turns.slice(pos)];
}

// Union two turn lists by uuid, sorted ascending by `seq`. Used to (a) merge a freshly
// fetched page with live turns accrued during the fetch, and (b) prepend an older page
// without trusting array order. When the same turn appears in both, the INCOMING copy
// wins (it is fresher — e.g. a live event carrying a newer message tail / status), EXCEPT
// its messages are unioned by message-uuid so neither side's retained messages are lost.
export function mergeTurnPage(
  existing: TurnWithMessagesView[],
  incoming: TurnWithMessagesView[],
): TurnWithMessagesView[] {
  const byUuid = new Map<string, TurnWithMessagesView>();
  for (const t of existing) byUuid.set(t.uuid, t);
  for (const t of incoming) {
    const prev = byUuid.get(t.uuid);
    if (!prev) {
      byUuid.set(t.uuid, t);
      continue;
    }
    // Same turn on both sides: take the incoming turn fields, union the message tails by
    // uuid (preserving order: prev's first, then any incoming messages not already seen).
    const seen = new Set(prev.messages.map((m) => m.uuid));
    const extra = t.messages.filter((m) => !seen.has(m.uuid));
    byUuid.set(t.uuid, { ...t, messages: [...prev.messages, ...extra] });
  }
  return [...byUuid.values()].sort((a, b) => a.seq - b.seq);
}

export function applyTranscriptEvent(
  turns: TurnWithMessagesView[],
  event: {
    trigger: "turn_created" | "turn_status_changed" | "transcript_appended";
    turn: { uuid: string } & Partial<TurnWithMessagesView>;
    messages: TranscriptMessageView[];
  },
): TurnWithMessagesView[] {
  const idx = turns.findIndex((tn) => tn.uuid === event.turn.uuid);

  if (event.trigger === "turn_created") {
    const incoming: TurnWithMessagesView = {
      ...(event.turn as TurnWithMessagesView),
      messages: [],
    };
    if (idx === -1) return insertTurnBySeq(turns, incoming);
    // Already present (raced with the initial fetch) — keep our messages, refresh
    // the turn fields.
    const next = [...turns];
    next[idx] = { ...incoming, messages: turns[idx].messages };
    return next;
  }

  if (idx === -1) {
    // status-change / append for a turn we don't have yet (raced ahead of its
    // create, OR an update to a turn outside the loaded window). Materialize it from
    // the event at its correct seq position so nothing is silently dropped AND the
    // ascending-by-seq invariant the pagination/scroll rely on is preserved.
    return insertTurnBySeq(turns, {
      ...(event.turn as TurnWithMessagesView),
      messages: event.messages ?? [],
    });
  }

  const next = [...turns];
  if (event.trigger === "turn_status_changed") {
    next[idx] = { ...next[idx], ...event.turn };
    return next;
  }

  // transcript_appended — grow the tail, de-duped by uuid.
  const existingUuids = new Set(next[idx].messages.map((m) => m.uuid));
  const appended = (event.messages ?? []).filter(
    (m) => !existingUuids.has(m.uuid),
  );
  next[idx] = {
    ...next[idx],
    ...event.turn,
    messages: [...next[idx].messages, ...appended],
  };
  return next;
}

export function DaemonChat() {
  const t = useTranslations("daemonChat");
  const {
    status,
    connections,
    executionsByConnection,
    setOpenSession,
    subscribeTranscript,
  } = useAgentPresence();

  // ===== Conversation list (GET /api/daemon-sessions) =====
  const [sessions, setSessions] = useState<SessionTarget[]>([]);
  const [listStatus, setListStatus] = useState<"loading" | "ok" | "error">(
    "loading",
  );
  const fetchSessions = useCallback(async () => {
    try {
      const res = await authFetch("/api/daemon-sessions");
      if (!res.ok) {
        setListStatus("error");
        return;
      }
      const json = await res.json();
      if (json.success) {
        setSessions(json.data.sessions ?? []);
        setListStatus("ok");
      } else {
        setListStatus("error");
      }
    } catch (error) {
      clientLogger.error("Failed to fetch daemon sessions:", error);
      setListStatus("error");
    }
  }, []);
  useEffect(() => {
    fetchSessions();
    const id = setInterval(fetchSessions, 15_000);
    return () => clearInterval(id);
  }, [fetchSessions]);

  // ===== Agent axis (agent-first) =====
  // Resolve a display name per agentUuid from the connection list (sessions carry
  // no name); fall back to the agent's first session title or a generic label so a
  // disconnected agent with history still appears.
  const agents = useMemo<AgentOption[]>(() => {
    const names = new Map<string, string>();
    for (const c of connections) {
      if (!names.has(c.agentUuid) && c.agentName?.trim()) {
        names.set(c.agentUuid, c.agentName.trim());
      }
    }
    const agentUuids = new Set<string>([
      ...connections.map((c) => c.agentUuid),
      ...sessions.map((s) => s.agentUuid),
    ]);
    return [...agentUuids].map((agentUuid) => ({
      agentUuid,
      agentName: names.get(agentUuid) ?? t("roleAgent"),
    }));
  }, [connections, sessions, t]);

  // Default-select the agent with the most recent conversation so the modal never
  // opens empty. Derived-then-pinned: the explicit selection wins when it still
  // resolves, otherwise fall back to the most-recent agent.
  const mostRecentAgentUuid = useMemo(() => {
    let best: { agentUuid: string; lastTurnAt: string } | null = null;
    for (const s of sessions) {
      if (!best || s.lastTurnAt > best.lastTurnAt) {
        best = { agentUuid: s.agentUuid, lastTurnAt: s.lastTurnAt };
      }
    }
    return best?.agentUuid ?? agents[0]?.agentUuid ?? null;
  }, [sessions, agents]);

  const [pickedAgentUuid, setPickedAgentUuid] = useState<string | null>(null);
  const selectedAgentUuid =
    pickedAgentUuid && agents.some((a) => a.agentUuid === pickedAgentUuid)
      ? pickedAgentUuid
      : mostRecentAgentUuid;

  // PIN the agent once the data has SETTLED, so the visible agent does NOT silently
  // switch out from under the user: `mostRecentAgentUuid` chases the 15s poll / SSE, so a
  // turn arriving on ANOTHER agent's conversation would otherwise flip the selection and
  // clear the open transcript mid-read. We wait for the first connections poll + session
  // list to settle (`status`/`listStatus === "ok"`) before pinning, so the frozen default
  // is computed from REAL data (not the empty-list fallback during first paint). After
  // that the user can still re-pick via the Select.
  useEffect(() => {
    if (
      !pickedAgentUuid &&
      status === "ok" &&
      listStatus === "ok" &&
      mostRecentAgentUuid
    ) {
      setPickedAgentUuid(mostRecentAgentUuid);
    }
  }, [pickedAgentUuid, status, listStatus, mostRecentAgentUuid]);

  // ===== Conversation rows for the selected agent =====
  // Each conversation's status is derived from ITS OWN matching executions (idea
  // sessions → `idea:<directIdeaUuid>`, ad-hoc → `daemon_session:<sessionId>`), looked
  // up in its ORIGIN connection's slice — so two conversations on the same agent read
  // independently (running / interrupted / error / idle), not a shared "agent busy"
  // flag. A flat map of all executions (across connections) keyed by connection lets us
  // resolve each session's origin slice.

  // The conversation's display NAME, derived from the most meaningful field available:
  //   1. an explicit `title` (rare — a server-set name) wins,
  //   2. an idea-anchored session → its idea's title (rendered with an "Idea" badge in
  //      the list; the badge is added by the row, this returns just the name),
  //   3. an ad-hoc session → its opening human instruction (truncated), so the chat is
  //      named by what the human first said,
  //   4. last-resort fallbacks (idea/ad-hoc + short id) only when none of the above
  //      resolved yet (e.g. a brand-new conversation before its first turn re-syncs).
  // Accepts the optional naming fields so it works for both the list row (SessionTarget,
  // which carries them) and the detail pane (SessionView, which does not — it falls
  // through to the fallback, then the row title is used as the authoritative name).
  const conversationName = useCallback(
    (s: {
      title: string | null;
      directIdeaUuid: string | null;
      sessionId: string;
      firstInstruction?: string | null;
      ideaTitle?: string | null;
    }): string => {
      if (s.title?.trim()) return s.title.trim();
      if (s.directIdeaUuid) {
        if (s.ideaTitle?.trim()) return s.ideaTitle.trim();
        return t("conversationIdea", { id: s.directIdeaUuid.slice(0, 8) });
      }
      const opener = s.firstInstruction?.trim();
      if (opener) return clampInstructionName(opener);
      return t("conversationAdHoc", { id: s.sessionId.slice(0, 8) });
    },
    [t],
  );

  const rows = useMemo<ConversationRow[]>(() => {
    if (!selectedAgentUuid) return [];
    return sessions
      .filter((s) => s.agentUuid === selectedAgentUuid)
      .sort((a, b) => (a.lastTurnAt < b.lastTurnAt ? 1 : -1))
      .map((session) => ({
        session,
        title: conversationName(session),
        // An idea-anchored conversation gets a resource badge before its name; an ad-hoc
        // one (named by the human's opening message) does not.
        ideaAnchored: session.directIdeaUuid != null,
        // This conversation's own live status from its origin connection's slice.
        status: sessionExecStatus(
          executionsByConnection[session.originConnectionUuid] ?? [],
          session,
        ),
      }));
  }, [sessions, selectedAgentUuid, executionsByConnection, conversationName]);

  // Client-side pagination — reset to one page when the agent changes.
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [selectedAgentUuid]);

  // ===== Selected conversation + its transcript (GET /api/daemon-sessions/[uuid]) =====
  const [selectedSessionUuid, setSelectedSessionUuid] = useState<string | null>(
    null,
  );
  // Resolve the selection: explicit pick wins when it's still in the current agent's
  // rows; otherwise null (the right pane shows the select prompt).
  const selectedSession = useMemo(
    () => rows.find((r) => r.session.uuid === selectedSessionUuid) ?? null,
    [rows, selectedSessionUuid],
  );

  const [detail, setDetail] = useState<SessionDetailView | null>(null);
  const [turns, setTurns] = useState<TurnWithMessagesView[]>([]);
  const [detailLoading, setDetailLoading] = useState(false);
  const [detailError, setDetailError] = useState(false);
  // Older-page pagination: whether earlier turns exist before the loaded window, and a
  // mid-flight flag for the "load earlier" fetch (separate from the first-paint load).
  const [hasMoreEarlier, setHasMoreEarlier] = useState(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  // Guard against an out-of-order response overwriting a newer selection.
  const detailReqRef = useRef(0);

  const openUuid = selectedSession?.session.uuid ?? null;

  // Tell the provider which session is open so it subscribes that transcript
  // channel; clear on close/unmount.
  useEffect(() => {
    setOpenSession(openUuid);
    return () => setOpenSession(null);
  }, [openUuid, setOpenSession]);

  // Fetch the LATEST page of the transcript on selection (newest-first window). Older
  // turns are pulled on demand via `loadEarlier` below.
  useEffect(() => {
    if (!openUuid) {
      setDetail(null);
      setTurns([]);
      setDetailError(false);
      setHasMoreEarlier(false);
      return;
    }
    const reqId = ++detailReqRef.current;
    setDetailLoading(true);
    setDetailError(false);
    setHasMoreEarlier(false);
    // Clear the previous session's turns synchronously on switch, so `turns` only ever
    // accumulates the NEW session's live events during the fetch window (the subscribe
    // effect is keyed on the same openUuid). The fetch then MERGES its page with those.
    setTurns([]);
    (async () => {
      try {
        const res = await authFetch(`/api/daemon-sessions/${openUuid}`);
        if (reqId !== detailReqRef.current) return; // superseded
        if (!res.ok) {
          setDetailError(true);
          return;
        }
        const json = await res.json();
        if (reqId !== detailReqRef.current) return;
        if (json.success) {
          const data = json.data as SessionDetailView;
          setDetail(data);
          // MERGE rather than blind-replace: a live turn_created / transcript_appended
          // that arrived after the GET was issued but before it resolved is already in
          // `prev` — replacing would drop it until the next reselect. Union by uuid
          // (the live copy wins, as it may carry a fresher message tail), sorted by seq.
          setTurns((prev) => mergeTurnPage(prev, data.turns ?? []));
          setHasMoreEarlier(Boolean(data.hasMore));
        } else {
          setDetailError(true);
        }
      } catch (error) {
        if (reqId !== detailReqRef.current) return;
        clientLogger.error("Failed to fetch daemon session detail:", error);
        setDetailError(true);
      } finally {
        if (reqId === detailReqRef.current) setDetailLoading(false);
      }
    })();
  }, [openUuid]);

  // Load the page of turns OLDER than the earliest currently-loaded turn (cursor =
  // `turns[0].seq`) and merge it in. `mergeTurnPage` unions by uuid + sorts by seq, so a
  // raced live event, a re-click, or any ordering surprise can't double-insert or break
  // the ascending invariant. Bound to the open session via `reqId` (a selection change
  // supersedes an in-flight earlier-load).
  const loadEarlier = useCallback(async () => {
    if (!openUuid || loadingEarlier || turns.length === 0) return;
    const cursorSeq = turns[0].seq;
    const reqId = detailReqRef.current; // same generation as the open session
    setLoadingEarlier(true);
    try {
      const res = await authFetch(
        `/api/daemon-sessions/${openUuid}?beforeSeq=${cursorSeq}`,
      );
      if (reqId !== detailReqRef.current) return; // selection changed mid-flight
      if (!res.ok) return; // transient — the "load earlier" control stays available
      const json = await res.json();
      if (reqId !== detailReqRef.current) return;
      if (json.success) {
        const data = json.data as SessionDetailView;
        setTurns((prev) => mergeTurnPage(data.turns ?? [], prev));
        setHasMoreEarlier(Boolean(data.hasMore));
      }
    } catch (error) {
      clientLogger.error("Failed to load earlier transcript turns:", error);
    } finally {
      setLoadingEarlier(false);
    }
  }, [openUuid, loadingEarlier, turns]);

  // Subscribe to the open conversation's live transcript events and patch turns.
  // The provider only forwards events for the `?sessionUuid=` it subscribed (the
  // open one), so no per-event session filter is needed here.
  useEffect(() => {
    if (!openUuid) return;
    const unsubscribe = subscribeTranscript((event) => {
      setTurns((prev) => applyTranscriptEvent(prev, event));
    });
    return unsubscribe;
  }, [openUuid, subscribeTranscript]);

  // ===== Origin connection resolution for the open conversation =====
  const originConnection = useMemo(() => {
    const target = detail?.session.originConnectionUuid;
    if (!target) return null;
    return connections.find((c) => c.uuid === target) ?? null;
  }, [detail, connections]);
  const originOnline = originConnection?.effectiveStatus === "online";

  // The agent's online connections — the ad-hoc picker candidates for the send box.
  const selectedAgentOnlineConnections = useMemo(
    () =>
      selectedAgentUuid
        ? connections.filter(
            (c) =>
              c.agentUuid === selectedAgentUuid &&
              c.effectiveStatus === "online",
          )
        : [],
    [connections, selectedAgentUuid],
  );

  // Display name for the selected agent (the new-conversation pane's header).
  const selectedAgentName =
    agents.find((a) => a.agentUuid === selectedAgentUuid)?.agentName ??
    t("roleAgent");

  // The open conversation's OWN live executions — its origin connection's slice,
  // filtered to the executions that belong to THIS conversation (idea:<directIdeaUuid>
  // or daemon_session:<sessionId>). Scoping to the conversation is what keeps the
  // footer's Interrupt/Resume card showing only THIS conversation's in-flight work,
  // not every execution on the connection (which would cram unrelated task cards above
  // the reply box).
  const sessionExecutions = useMemo(() => {
    const s = detail?.session;
    if (!s) return [];
    const slice = executionsByConnection[s.originConnectionUuid] ?? [];
    return executionsForSession(slice, s);
  }, [detail, executionsByConnection]);

  // The session's executions keyed by uuid, so an entity-bearing turn resolves its deep
  // link via the per-turn `executionUuid` back-link.
  const executionsByUuid = useMemo(() => {
    const map = new Map<string, ExecutionView>();
    for (const e of sessionExecutions) map.set(e.uuid, e);
    return map;
  }, [sessionExecutions]);

  // Title for the right pane: the selected row's title when present, else derived
  // from the loaded detail's session (the same naming rule the list row uses).
  const detailTitle = selectedSession
    ? selectedSession.title
    : detail
      ? conversationName(detail.session)
      : "";

  // ===== Mobile drill-down =====
  const [mobileDetailOpen, setMobileDetailOpen] = useState(false);
  useEffect(() => {
    if (
      mobileDetailOpen &&
      selectedSessionUuid &&
      !rows.some((r) => r.session.uuid === selectedSessionUuid)
    ) {
      setMobileDetailOpen(false);
    }
  }, [rows, mobileDetailOpen, selectedSessionUuid]);

  const selectSession = useCallback((uuid: string) => {
    setSelectedSessionUuid(uuid);
  }, []);

  // "New conversation" — clear the selection so the right pane (desktop) / drill-down
  // (mobile) shows the new-conversation composer instead of a transcript.
  const startNewConversation = useCallback(() => {
    setSelectedSessionUuid(null);
    setMobileDetailOpen(true);
  }, []);

  // A freshly-started ad-hoc session: pull it into the list immediately (so it
  // appears without waiting for the 15s poll) and auto-select it, sliding the new
  // conversation's (empty) transcript into view.
  const handleSessionStarted = useCallback(
    (created: SessionView) => {
      const target: SessionTarget = {
        uuid: created.uuid,
        agentUuid: created.agentUuid,
        sessionId: created.sessionId,
        directIdeaUuid: created.directIdeaUuid,
        originConnectionUuid: created.originConnectionUuid,
        status: created.status,
        title: created.title,
        lastTurnAt: created.lastTurnAt,
        // The ad-hoc session is pinned to a connection we just verified online.
        originOnline: true,
        // Naming fields settle on the next fetchSessions() re-sync (the just-sent
        // instruction becomes this conversation's firstInstruction server-side).
        firstInstruction: null,
        ideaTitle: null,
      };
      setSessions((prev) =>
        prev.some((s) => s.uuid === target.uuid)
          ? prev
          : [target, ...prev],
      );
      setSelectedSessionUuid(created.uuid);
      // Re-sync from the server in the background (authoritative ordering + fields).
      fetchSessions();
    },
    [fetchSessions],
  );

  // ===== States =====
  const loading = status === "loading" && listStatus === "loading";
  // A list-load failure with nothing cached → a distinct error card (no silent empty).
  const showListError =
    listStatus === "error" && sessions.length === 0;
  // Genuinely-no-history. We no longer dead-end here: an agent that is connected can
  // start a NEW conversation straight from this state (the right pane / drill-down is
  // the composer). The calm "nothing yet" card is reserved for the case where there
  // is also no agent to talk to at all (no connections AND no history).
  const noConversations =
    listStatus === "ok" && sessions.length === 0;
  const noAgentsAtAll = noConversations && agents.length === 0;

  const transcriptPane = (
    <TranscriptView
      session={detail?.session ?? null}
      turns={turns}
      title={detailTitle}
      loading={detailLoading}
      error={detailError}
      originConnection={originConnection}
      originOnline={originOnline}
      sessionExecutions={sessionExecutions}
      executionsByUuid={executionsByUuid}
      hasMoreEarlier={hasMoreEarlier}
      loadingEarlier={loadingEarlier}
      onLoadEarlier={loadEarlier}
    />
  );

  // The default right pane (nothing selected) — a new-conversation composer, not a
  // passive prompt. Also the mobile drill-down body for "New conversation".
  const newConversationPane = (
    <NewConversationPane
      agentUuid={selectedAgentUuid}
      agentName={selectedAgentName}
      onlineConnections={selectedAgentOnlineConnections}
      onStarted={handleSessionStarted}
    />
  );

  // Mobile drill-down shows EITHER the selected transcript OR (when nothing is
  // selected but the drill-down was opened via "New conversation") the composer.
  const mobileDrillContent = selectedSession ? transcriptPane : newConversationPane;

  return (
    <div className="flex h-full min-h-0 flex-col bg-[#FAF8F4]">
      {/* MOBILE drill-down detail — a full-height flex column so the transcript
          ScrollArea fills the middle and the reply input lands at the very bottom of
          the (fullscreen on mobile) modal, not floating in a fixed-height box with
          dead space below it. The back-button header is a non-shrinking row; the
          content takes the remaining height (`min-h-0 flex-1`) and owns its own
          internal scroll. */}
      {mobileDetailOpen && (
        <div className="flex h-full min-h-0 flex-col lg:hidden">
          <div className="flex shrink-0 items-center gap-1 border-b border-[#EFEBE4] bg-[#FAF8F4] px-3 py-2.5">
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
          <div className="min-h-0 flex-1">{mobileDrillContent}</div>
        </div>
      )}

      <div
        className={`${
          mobileDetailOpen ? "hidden lg:flex" : "flex"
        } h-full min-h-0 flex-col gap-6 overflow-y-auto px-4 py-5 lg:overflow-hidden md:px-8 md:py-6 lg:gap-6 lg:px-8 lg:py-7`}
      >
        {/* Header */}
        <header className="flex flex-col gap-1.5">
          <h2 className="text-[22px] font-semibold text-[#2C2C2C] lg:text-[24px]">
            {t("title")}
          </h2>
          <p className="max-w-[640px] text-[13px] leading-relaxed text-[#6B6B6B]">
            {t("subtitle")}
          </p>
        </header>

        {/* Body */}
        {loading ? (
          <p className="text-sm text-[#6B6B6B]">{t("loading")}</p>
        ) : showListError ? (
          <Card className="items-center gap-3 rounded-2xl border-[#E7D9C9] bg-[#FFF9F3] p-8 text-center shadow-none md:p-12">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-[#D9770615]">
              <WifiOff className="h-6 w-6 text-[#B45309]" />
            </div>
            <h3 className="text-base font-semibold text-[#92400E]">
              {t("loadErrorTitle")}
            </h3>
            <p className="max-w-md text-[13px] leading-relaxed text-[#6B6B6B]">
              {t("loadErrorBody")}
            </p>
          </Card>
        ) : noAgentsAtAll ? (
          // The ONLY remaining dead-end: no agent connected AND no history — there is
          // nothing to talk to, so a calm "connect a daemon" card (no composer).
          <Card className="items-center gap-3 rounded-2xl border-[#E5E0D8] bg-white p-8 text-center shadow-none md:p-12">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-[#C67A5215]">
              <MessagesSquare className="h-6 w-6 text-[#C67A52]" />
            </div>
            <h3 className="text-base font-semibold text-[#2C2C2C]">
              {t("noAgents.title")}
            </h3>
            <p className="max-w-md text-[13px] leading-relaxed text-[#6B6B6B]">
              {t("noAgents.body")}
            </p>
          </Card>
        ) : (
          <>
            {/* MOBILE list (< lg) */}
            <div className="flex flex-col gap-3 lg:hidden">
              <ConversationList
                agents={agents}
                selectedAgentUuid={selectedAgentUuid}
                onSelectAgent={(uuid) => {
                  setPickedAgentUuid(uuid);
                  setSelectedSessionUuid(null);
                }}
                rows={rows}
                selectedSessionUuid={selectedSessionUuid}
                onSelectSession={(uuid) => {
                  selectSession(uuid);
                  setMobileDetailOpen(true);
                }}
                onNewConversation={startNewConversation}
                visibleCount={visibleCount}
                onLoadMore={() => setVisibleCount((n) => n + PAGE_SIZE)}
              />
            </div>

            {/* DESKTOP two-pane (lg+) */}
            <div className="hidden min-h-0 flex-1 gap-5 lg:flex">
              <div className="flex w-[320px] shrink-0 flex-col">
                <ConversationList
                  agents={agents}
                  selectedAgentUuid={selectedAgentUuid}
                  onSelectAgent={(uuid) => {
                    setPickedAgentUuid(uuid);
                    setSelectedSessionUuid(null);
                  }}
                  rows={rows}
                  selectedSessionUuid={selectedSessionUuid}
                  onSelectSession={selectSession}
                  onNewConversation={startNewConversation}
                  visibleCount={visibleCount}
                  onLoadMore={() => setVisibleCount((n) => n + PAGE_SIZE)}
                />
              </div>

              {/* Right pane: the selected transcript, or — when nothing is selected —
                  the new-conversation composer (chat-app default), never a dead end. */}
              <Card className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border-[#E5E0D8] bg-white p-0 shadow-none">
                {selectedSession ? transcriptPane : newConversationPane}
              </Card>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
