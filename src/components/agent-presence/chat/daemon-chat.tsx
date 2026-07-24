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
import { rollupDeltaForTurn } from "./live-rollup";
import {
  sessionExecStatusForRow,
  sessionExecutionsForComposer,
} from "./session-execution";
import { DaemonConnectCta } from "../daemon-connect-cta";

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
// appended). The transcript is rendered + paginated assuming ascending seq — the
// transcript header/auto-scroll use `turns[turns.length - 1]` as the newest turn, and
// `loadEarlier` walks back via the server-returned `(oldestTurnSeq, oldestMsgSeq)` cursor
// over this ascending window — so a materialized turn with a lower seq than the loaded
// window must land in order, not at the end. Returns a NEW array.
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
    focusTarget,
    clearChatFocusTarget,
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
        // This conversation's own live status — resolved from the SAME cross-connection
        // match the composer's Interrupt uses (origin slice preferred, all-slice fallback),
        // so the row's dot and the composer's Interrupt button can never disagree after a
        // cwd/agent switch or a session re-point moved the running turn off the origin
        // connection. Matched strictly by this conversation's own idea/session id (no
        // cross-borrow).
        status: sessionExecStatusForRow(executionsByConnection, session),
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
  // Older-page pagination: whether earlier MESSAGES exist before the loaded window, and a
  // mid-flight flag for the "load earlier" fetch (separate from the first-paint load).
  const [hasMoreEarlier, setHasMoreEarlier] = useState(false);
  const [loadingEarlier, setLoadingEarlier] = useState(false);
  // The SERVER-RETURNED composite cursor for the next "load earlier" — the position of the
  // OLDEST slot/message in the currently-loaded window. Tracked in state (NOT derived from
  // `turns[0]`) because the message-level pager gives every turn a `(turn.seq, 0)` slot,
  // and an empty placeholder band (a turn whose messages were all trimmed) has NO rendered
  // message to read a `seq` from — only the server's reported `oldestTurnSeq` / `oldestMsgSeq`
  // accounts for that slot, so it is the authoritative cursor.
  const [oldestCursor, setOldestCursor] = useState<{
    turnSeq: number;
    msgSeq: number;
  } | null>(null);
  // Guard against an out-of-order response overwriting a newer selection.
  const detailReqRef = useRef(0);
  // Turn uuids whose usage is ALREADY reflected in `detail.session`'s scalar rollup
  // (daemon-token-usage). Seeded from the fetched page (the server rollup already counted
  // every terminal turn at fetch time) so a live terminal event for a turn we already
  // fetched can't double-add; a genuinely-new terminal turn's usage is folded in locally
  // and its uuid recorded here. Reset on session switch. This is the "increment the header
  // total locally on the terminal event" path the Tech Design calls for — the SSE event
  // carries only the turn, not the session, so the rollup would otherwise never update live.
  const rolledUpTurnsRef = useRef<Set<string>>(new Set());

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
      setOldestCursor(null);
      rolledUpTurnsRef.current = new Set();
      return;
    }
    const reqId = ++detailReqRef.current;
    // New selection → the fetched rollup is the fresh baseline; forget the prior session's
    // counted-turns set.
    rolledUpTurnsRef.current = new Set();
    setDetailLoading(true);
    setDetailError(false);
    setHasMoreEarlier(false);
    setOldestCursor(null);
    // Clear the previous session's turns synchronously on switch, so `turns` only ever
    // accumulates the NEW session's live events during the fetch window (the subscribe
    // effect is keyed on the same openUuid). The fetch then MERGES its page with those.
    setTurns([]);
    (async () => {
      try {
        // First paint: NO cursor params — the message-level pager returns the newest page.
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
          // The server rollup on `data.session` already accounts for every terminal turn
          // that existed at fetch time — record their uuids so a live terminal event for
          // one of them can't double-count into the local header total (daemon-token-usage).
          for (const tn of data.turns ?? []) {
            if (tn.status === "ended" || tn.status === "interrupted") {
              rolledUpTurnsRef.current.add(tn.uuid);
            }
          }
          // MERGE rather than blind-replace: a live turn_created / transcript_appended
          // that arrived after the GET was issued but before it resolved is already in
          // `prev` — replacing would drop it until the next reselect. Union by uuid
          // (the live copy wins, as it may carry a fresher message tail), sorted by seq.
          setTurns((prev) => mergeTurnPage(prev, data.turns ?? []));
          setHasMoreEarlier(Boolean(data.hasMore));
          // Track the SERVER-RETURNED composite cursor (the page's oldest slot/message)
          // for the next "load earlier". Null when the page is empty (no older fetch).
          setOldestCursor(
            data.oldestTurnSeq !== null && data.oldestMsgSeq !== null
              ? { turnSeq: data.oldestTurnSeq, msgSeq: data.oldestMsgSeq }
              : null,
          );
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

  // Load the page of MESSAGES older than the loaded window and merge it in. The cursor is
  // the SERVER-RETURNED composite `(oldestTurnSeq, oldestMsgSeq)` of the previous page —
  // NOT derived from `turns[0]`, because the page's oldest position may be an empty
  // placeholder band's `(turn.seq, 0)` slot that has no rendered message to read a seq
  // from. Passed as `?beforeTurnSeq=&beforeMsgSeq=`. `mergeTurnPage` unions by uuid + sorts
  // by seq, so a partial-turn band stitches into its prior band, a re-delivered synthetic
  // `seq=0` slot de-dupes by its stable `synthetic:{turnUuid}` uuid, and a raced live event
  // can't double-insert or break the ascending invariant. Bound to the open session via
  // `reqId` (a selection change supersedes an in-flight earlier-load).
  const loadEarlier = useCallback(async () => {
    if (!openUuid || loadingEarlier || !oldestCursor) return;
    const { turnSeq, msgSeq } = oldestCursor;
    const reqId = detailReqRef.current; // same generation as the open session
    setLoadingEarlier(true);
    try {
      const res = await authFetch(
        `/api/daemon-sessions/${openUuid}?beforeTurnSeq=${turnSeq}&beforeMsgSeq=${msgSeq}`,
      );
      if (reqId !== detailReqRef.current) return; // selection changed mid-flight
      if (!res.ok) return; // transient — the "load earlier" control stays available
      const json = await res.json();
      if (reqId !== detailReqRef.current) return;
      if (json.success) {
        const data = json.data as SessionDetailView;
        setTurns((prev) => mergeTurnPage(data.turns ?? [], prev));
        setHasMoreEarlier(Boolean(data.hasMore));
        // Advance the cursor to the newly-loaded page's oldest position. When the page
        // is empty (nothing older), keep the previous cursor untouched (hasMore is false,
        // so the control disappears anyway).
        if (data.oldestTurnSeq !== null && data.oldestMsgSeq !== null) {
          setOldestCursor({
            turnSeq: data.oldestTurnSeq,
            msgSeq: data.oldestMsgSeq,
          });
        }
      }
    } catch (error) {
      clientLogger.error("Failed to load earlier transcript turns:", error);
    } finally {
      setLoadingEarlier(false);
    }
  }, [openUuid, loadingEarlier, oldestCursor]);

  // Subscribe to the open conversation's live transcript events and patch turns.
  // The provider only forwards events for the `?sessionUuid=` it subscribed (the
  // open one), so no per-event session filter is needed here.
  useEffect(() => {
    if (!openUuid) return;
    const unsubscribe = subscribeTranscript((event) => {
      setTurns((prev) => applyTranscriptEvent(prev, event));
      // Live-update the header conversation total (daemon-token-usage). The SSE event
      // carries only the turn (not the session), so the scalar rollup on `detail.session`
      // would otherwise stay frozen until a refetch. On a terminal edge carrying usage,
      // fold its input/output into the local rollup ONCE (deduped by turn uuid against both
      // the fetched baseline and prior live events), mirroring the server's atomic
      // increment. See `rollupDeltaForTurn` for the terminal/usage/dedup/zero rules.
      if (event.trigger === "turn_status_changed") {
        const delta = rollupDeltaForTurn(rolledUpTurnsRef.current, event.turn);
        if (delta) {
          rolledUpTurnsRef.current.add(event.turn.uuid);
          setDetail((prev) =>
            prev
              ? {
                  ...prev,
                  session: {
                    ...prev.session,
                    totalInputTokens: prev.session.totalInputTokens + delta.addInput,
                    totalOutputTokens: prev.session.totalOutputTokens + delta.addOutput,
                  },
                }
              : prev,
          );
        }
      }
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

  // Whether the origin agent currently spans MULTIPLE distinct hosts. The transcript
  // header is path-first (cwd as the instance identity) and de-emphasizes host into the
  // "Connection details" disclosure; host is only worth surfacing inline when it actually
  // disambiguates — i.e. the same agent has connections on >1 host, so a bare path could be
  // ambiguous. Distinct non-empty hosts only (an unknown/"" host can't disambiguate).
  const originCrossHost = useMemo(() => {
    const agentUuid = originConnection?.agentUuid;
    if (!agentUuid) return false;
    const hosts = new Set<string>();
    for (const c of connections) {
      if (c.agentUuid === agentUuid && c.host !== "") hosts.add(c.host);
    }
    return hosts.size > 1;
  }, [originConnection, connections]);

  // The agent's online connections — gates whether the ad-hoc path is offered.
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

  // The OPEN conversation's agent's online connections — the candidate set for the
  // origin-offline "Continue on an online directory" escape hatch (T11 / qr3).
  // Sourced from the origin connection's agent (not the picked agent) so the escape
  // hatch is always pinned to the conversation actually on screen. When the origin
  // is offline but this set is non-empty, the reply box offers starting a NEW
  // conversation on one of these online instances; the original stays read-only.
  const originAgentOnlineConnections = useMemo(() => {
    const agentUuid = originConnection?.agentUuid;
    if (!agentUuid) return [];
    return connections.filter(
      (c) => c.agentUuid === agentUuid && c.effectiveStatus === "online",
    );
  }, [originConnection, connections]);

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
  //
  // Interrupt hardening (fix-daemon-conversation-split-cwd-agent): the origin-connection
  // slice misses the idea's running turn when it lives on a DIFFERENT connection —
  // after a cwd switch (a re-pointed / legacy-residual session) or an agent switch (the
  // running turn is on another agent's `(agentUuid, idea)` row). When the origin slice has
  // NO matching execution, fall back to searching ALL connection slices for THIS idea's
  // execution, so the composer's Interrupt control reaches the running turn from any
  // thread. The InterruptButton targets the matched exec's own connectionUuid/entityType/
  // entityUuid, so a cross-connection match still stops the correct subprocess. Matched
  // strictly by the direct idea (never the root idea).
  const sessionExecutions = useMemo(() => {
    const s = detail?.session;
    if (!s) return [];
    return sessionExecutionsForComposer(executionsByConnection, s);
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

  // A freshly-started ad-hoc session OR a RE-POINTED existing conversation (T12): pull/patch
  // it into the list immediately (so it appears / flips online without waiting for the 15s
  // poll) and (re)select it.
  //  - Ad-hoc start: a brand-new uuid → prepend it as a new online row, sliding the new
  //    conversation's (empty) transcript into view.
  //  - Re-point: the SAME uuid already in the list → patch its origin (the chosen online
  //    connection) + `originOnline: true` IN PLACE so the SAME conversation stays selected
  //    and flips read-only → live immediately (no switch to a different session).
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
        // The session is pinned to a connection we just verified online (ad-hoc start) or
        // re-pointed to one (T12 re-point) — either way its origin is online right now.
        originOnline: true,
        // Naming fields settle on the next fetchSessions() re-sync (the just-sent
        // instruction becomes this conversation's firstInstruction server-side).
        firstInstruction: null,
        ideaTitle: null,
      };
      setSessions((prev) => {
        const idx = prev.findIndex((s) => s.uuid === target.uuid);
        if (idx === -1) {
          // New conversation (ad-hoc) — prepend.
          return [target, ...prev];
        }
        // Re-pointed existing conversation — patch its origin + online flag in place,
        // preserving the naming fields the list already resolved.
        const next = [...prev];
        next[idx] = {
          ...next[idx],
          originConnectionUuid: created.originConnectionUuid,
          originOnline: true,
          status: created.status,
          lastTurnAt: created.lastTurnAt,
        };
        return next;
      });
      // If the re-pointed conversation is the one currently OPEN, patch the loaded detail's
      // origin in place too — `originConnection` (and thus the reply box's online gate) is
      // derived from `detail.session.originConnectionUuid`, so without this the open pane
      // would keep reading the OLD offline origin until the next reselect. This is what
      // flips the open transcript read-only → live on the new origin immediately.
      setDetail((prev) =>
        prev && prev.session.uuid === created.uuid
          ? {
              ...prev,
              session: {
                ...prev.session,
                originConnectionUuid: created.originConnectionUuid,
                status: created.status,
                lastTurnAt: created.lastTurnAt,
              },
            }
          : prev,
      );
      setSelectedSessionUuid(created.uuid);
      // Re-sync from the server in the background (authoritative ordering + fields).
      fetchSessions();
    },
    [fetchSessions],
  );

  // Consume a one-shot chat focus target: pin the left rail to the focused agent,
  // then either land on that agent's conversation list / composer (agent-only
  // target, seeded by `openChatForAgent` — e.g. the comment mention badge's "Open
  // conversation" action; per the q3 contract, focusing the agent is sufficient and
  // precise past-session auto-selection is intentionally not done) or — when the
  // target carries a session (seeded by `openChatForSession`, e.g. the
  // conversational create-idea entry right after dispatching) — select THAT
  // conversation and slide its live transcript into view. The session path routes
  // through `handleSessionStarted` with the target's seeded SessionView, so a
  // session created moments ago (not yet in the fetched list) is prepended and
  // selectable immediately, and selection drives `setOpenSession` as usual. The
  // target is consumed (cleared) so a later manual modal open is not re-hijacked.
  useEffect(() => {
    if (!focusTarget) return;
    setPickedAgentUuid(focusTarget.agentUuid);
    if (focusTarget.sessionSeed) {
      handleSessionStarted(focusTarget.sessionSeed);
      // The seeded conversation must also open on the MOBILE breakpoint, where a
      // selection only shows once the drill-down is open.
      setMobileDetailOpen(true);
    } else if (focusTarget.sessionUuid) {
      // Session focus without a seed — select it if/when the list has it.
      setSelectedSessionUuid(focusTarget.sessionUuid);
      setMobileDetailOpen(true);
    } else {
      setSelectedSessionUuid(null);
    }
    clearChatFocusTarget();
  }, [focusTarget, clearChatFocusTarget, handleSessionStarted]);

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

  // The transcript pane is reused on both breakpoints, differing ONLY in the reply
  // composer's action-row geometry: desktop two-pane keeps it inline (actions on the
  // footer line), mobile drill-down stacks it beneath the textarea (`footerLayout`).
  // Everything else is identical, so it's a thin factory over the shared prop set.
  const renderTranscript = (footerLayout: "inline" | "stacked") => (
    <TranscriptView
      session={detail?.session ?? null}
      turns={turns}
      title={detailTitle}
      loading={detailLoading}
      error={detailError}
      originConnection={originConnection}
      originOnline={originOnline}
      originCrossHost={originCrossHost}
      sessionExecutions={sessionExecutions}
      executionsByUuid={executionsByUuid}
      footerLayout={footerLayout}
      hasMoreEarlier={hasMoreEarlier}
      loadingEarlier={loadingEarlier}
      onLoadEarlier={loadEarlier}
      originAgentOnlineConnections={originAgentOnlineConnections}
      onSessionStarted={handleSessionStarted}
    />
  );
  const transcriptPane = renderTranscript("inline");

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
  // The mobile transcript stacks its reply action row beneath the textarea (the
  // narrow drill-down has no room for an inline footer line), per Q4=mobile-syncs.
  const mobileDrillContent = selectedSession
    ? renderTranscript("stacked")
    : newConversationPane;

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      {/* MOBILE drill-down detail — a full-height flex column so the transcript
          ScrollArea fills the middle and the reply input lands at the very bottom of
          the (fullscreen on mobile) modal, not floating in a fixed-height box with
          dead space below it. The back-button header is a non-shrinking row; the
          content takes the remaining height (`min-h-0 flex-1`) and owns its own
          internal scroll. */}
      {mobileDetailOpen && (
        <div className="flex h-full min-h-0 flex-col lg:hidden">
          <div className="flex shrink-0 items-center gap-1 border-b border-[#EFEBE4] dark:border-[#2a2a2e] bg-background px-3 py-2.5">
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
          <div className="min-h-0 flex-1">{mobileDrillContent}</div>
        </div>
      )}

      <div
        className={`${
          mobileDetailOpen ? "hidden lg:flex" : "flex"
        } h-full min-h-0 flex-col gap-3 overflow-y-auto px-4 py-3 lg:overflow-hidden md:px-8 md:py-4 lg:gap-3 lg:px-8 lg:py-4`}
      >
        {/* Header — title only. The descriptive subtitle is intentionally dropped
            from the VISIBLE chrome to reclaim vertical space so the two-pane content
            top-aligns near the modal top; the `daemonChat.subtitle` key is retained
            and still feeds the hidden DialogDescription in connections-modal.tsx for
            the Radix dialog's accessibility description. */}
        <header className="flex flex-col">
          <h2 className="text-[22px] font-semibold text-foreground lg:text-[24px]">
            {t("title")}
          </h2>
        </header>

        {/* Body */}
        {loading ? (
          <p className="text-sm text-muted-foreground">{t("loading")}</p>
        ) : showListError ? (
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
        ) : noAgentsAtAll ? (
          // The ONLY remaining dead-end: no agent connected AND no history — there is
          // nothing to talk to, so a calm "connect a daemon" card (no composer).
          <Card className="items-center gap-4 rounded-2xl border-border bg-card p-8 text-center shadow-none md:p-12">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary/[0.08]">
              <MessagesSquare className="h-6 w-6 text-primary" />
            </div>
            <h3 className="text-base font-semibold text-foreground">
              {t("noAgents.title")}
            </h3>
            <p className="max-w-md text-[13px] leading-relaxed text-muted-foreground">
              {t("noAgents.body")}
            </p>
            {/* Actionable CTA for the only remaining dead-end (no connected agent
                AND no history): the shared daemon-connect block, consistent with
                the pill popover + onboarding completion screen. */}
            <div className="w-full max-w-md text-left">
              <DaemonConnectCta variant="prominent" />
            </div>
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
              <Card className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-2xl border-border bg-card p-0 shadow-none">
                {selectedSession ? transcriptPane : newConversationPane}
              </Card>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
