"use client";

// Agent Presence — the single shell-level data spine for the sidebar presence
// pill, its click popover, and the "View all" modal.
//
// WHY a dedicated, shell-mounted provider (not RealtimeContext):
//   The sidebar renders OUTSIDE any `RealtimeProvider` — `RealtimeProvider` is
//   mounted per-`<main>`, scoped by `projectUuid`, and remounts on navigation;
//   `/settings` mounts none. So the presence pill (which lives in the always-on
//   rail) needs its OWN self-contained spine that wraps the whole dashboard shell
//   and survives route changes. This provider deliberately does NOT depend on or
//   modify `RealtimeContext`; it opens its own company-wide `/api/events`
//   EventSource. The two browser EventSource instances are independent — the
//   server fans out per auth — so a second, shell-level stream coexists with the
//   page-scoped one (and once the standalone page is removed, net per-tab SSE
//   count does not increase).
//
// Data sources (single poll, single SSE — every consumer reads from here, so no
// duplicate requests across the pill and the modal):
//   - Connections + online count — polls `GET /api/agent-connections` every 15s,
//     same cadence/source as the prior page. Online =
//     `effectiveStatus === "online"`.
//   - Execution aggregate — polls `GET /api/daemon/executions` on the SAME 15s
//     cadence (plus an immediate mount fetch and an on-reconnect fetch) for the
//     running/queued (and `interrupted`) set across all connections. The periodic
//     poll is the self-healing spine: the SSE stream's execution channel set is
//     resolved server-side at stream-open, so a daemon that connects AFTER the
//     stream opened emits events on a channel this stream isn't subscribed to —
//     the poll is what surfaces its executions. The poll also recovers from a
//     silently-dropped SSE message (EventSource has no per-message replay).
//   - Execution live updates — its own company-wide `EventSource("/api/events")`
//     (no `projectUuid`) merges `type === "execution"` events by `connectionUuid`
//     into an executions-by-connection map for sub-poll latency. The SSE event
//     carries the connection's FULL current active set, so a merge replaces that
//     connection's slice wholesale (no per-row reconcile). Because the poll and
//     the SSE both write the map, the poll uses a per-connection generation guard
//     so a slow aggregate response cannot clobber a slice an SSE event freshened
//     while the request was in flight (last-WRITE wins, not last-RESPONSE). The
//     stream is reconnected on `visibilitychange` whenever it is not OPEN (a
//     browser auto-reconnect leaves it CONNECTING, never CLOSED), and closed on
//     unmount.
//
// Status surface: `status` is "loading" until the first connections poll
// settles, then "ok" on success or "error" on a failed poll. A failed poll sets
// `status: "error"` and MUST NOT zero the count — failure must be distinguishable
// from a real "0 online" (no silent error). The consumers (pill/popover/modal)
// render the three states; this provider only owns the data + the modal
// open-state so the popover trigger and the modal body coordinate through it
// without a hard inter-task ordering dependency.

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { authFetch } from "@/lib/auth-client";
import { clientLogger } from "@/lib/logger-client";
import type {
  ConnectionView,
  ExecutionView,
} from "@/components/agent-presence";
import type { ExecutionEvent } from "@/contexts/realtime-context";

const POLL_INTERVAL_MS = 15_000;

export type AgentPresenceStatus = "loading" | "ok" | "error";

// Map of connectionUuid → that connection's current displayable executions
// (running/queued/interrupted; consumers filter — the popover drops interrupted,
// the modal keeps it). Wholesale-replaced per connection by each SSE event.
export type ExecutionsByConnection = Record<string, ExecutionView[]>;

export interface AgentPresenceValue {
  status: AgentPresenceStatus;
  connections: ConnectionView[];
  onlineCount: number;
  executionsByConnection: ExecutionsByConnection;
  // Has the first execution-aggregate fetch settled (success OR failure)? Until
  // it has, a connection with an empty slice is "still loading", not "idle" — so
  // the detail pane can show a loading state instead of flashing "Nothing
  // running" in the window where connections have loaded but executions have not.
  executionsLoaded: boolean;
  modalOpen: boolean;
  setModalOpen: (open: boolean) => void;
}

const AgentPresenceContext = createContext<AgentPresenceValue | null>(null);

// ===== Pure helpers (unit-tested independent of React) =====

/**
 * Count the connections that are effectively online. "Online" is the
 * server-derived verdict `effectiveStatus === "online"` (the client never
 * re-derives liveness). Pure: no side effects, safe to call in render/test.
 */
export function computeOnlineCount(connections: ConnectionView[]): number {
  return connections.filter((c) => c.effectiveStatus === "online").length;
}

/**
 * Group a flat list of execution views into an executions-by-connection map.
 * Used for the first-paint aggregate from `GET /api/daemon/executions`. Pure.
 */
export function groupExecutionsByConnection(
  executions: ExecutionView[],
): ExecutionsByConnection {
  const map: ExecutionsByConnection = {};
  for (const exec of executions) {
    (map[exec.connectionUuid] ??= []).push(exec);
  }
  return map;
}

/**
 * Merge one `execution` SSE event into the executions-by-connection map. The
 * event carries the connection's FULL current active set, so the connection's
 * slice is replaced wholesale (no per-row reconcile). An empty `executions`
 * array (e.g. the connection went offline / finished everything) clears that
 * connection's key entirely rather than leaving a stale `[]`, so a consumer
 * iterating the map sees no empty slot. Returns a NEW map (never mutates the
 * input) so React state updates are detected. Pure.
 */
export function mergeExecutionEvent(
  prev: ExecutionsByConnection,
  event: { connectionUuid: string; executions: ExecutionView[] },
): ExecutionsByConnection {
  const next = { ...prev };
  if (event.executions.length === 0) {
    delete next[event.connectionUuid];
  } else {
    next[event.connectionUuid] = event.executions;
  }
  return next;
}

// ===== Provider =====

export function AgentPresenceProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<AgentPresenceStatus>("loading");
  const [connections, setConnections] = useState<ConnectionView[]>([]);
  const [executionsByConnection, setExecutionsByConnection] =
    useState<ExecutionsByConnection>({});
  const [executionsLoaded, setExecutionsLoaded] = useState(false);
  const [modalOpen, setModalOpen] = useState(false);

  // Per-connection write generation. Every SSE merge bumps a connection's
  // generation; the aggregate poll captures the generation map BEFORE it issues
  // the request and, when it returns, keeps a freshly-merged slice (one whose
  // generation advanced while the request was in flight) instead of overwriting
  // it with the older snapshot. This makes the map last-WRITE-wins rather than
  // last-RESPONSE-wins, closing the reconnect/poll-vs-SSE race.
  const connGenRef = useRef<Record<string, number>>({});

  // 15s connection poll. On success: store the list + status "ok". On ANY
  // failure (network reject OR a non-2xx OR a non-success envelope): set status
  // "error" and LEAVE the existing connections/count untouched — a failed poll
  // must never masquerade as a real "0 online" (no silent error).
  const fetchConnections = useCallback(async () => {
    try {
      const res = await authFetch("/api/agent-connections");
      if (!res.ok) {
        setStatus("error");
        return;
      }
      const json = await res.json();
      if (json.success) {
        setConnections(json.data.connections ?? []);
        setStatus("ok");
      } else {
        setStatus("error");
      }
    } catch (error) {
      clientLogger.error("Failed to fetch agent connections:", error);
      setStatus("error");
    }
  }, []);

  // Aggregate of executions across all visible connections. Runs on mount, on
  // every 15s poll tick, and on each SSE reconnect so the surface re-syncs after
  // a gap (and picks up connections that came online after the SSE stream's
  // channel set was resolved server-side). A failure here does NOT flip the
  // overall status (the connection poll owns status); it leaves the execution
  // map as-is and logs. Either way the first settle marks `executionsLoaded` so
  // the detail pane can stop showing its loading state.
  //
  // Race guard: snapshot each connection's write-generation BEFORE the request,
  // then on response keep any slice whose generation advanced in the meantime
  // (an SSE event merged a fresher set while we were fetching) rather than
  // overwriting it with the older aggregate.
  const fetchExecutions = useCallback(async () => {
    const genAtRequest = { ...connGenRef.current };
    try {
      const res = await authFetch("/api/daemon/executions");
      if (!res.ok) return;
      const json = await res.json();
      if (json.success) {
        const grouped = groupExecutionsByConnection(json.data.executions ?? []);
        setExecutionsByConnection((prev) => {
          const next = { ...grouped };
          // For any connection whose slice was freshened by an SSE event while
          // this aggregate was in flight, keep the SSE slice (it is newer).
          for (const uuid of Object.keys(connGenRef.current)) {
            if (connGenRef.current[uuid] !== genAtRequest[uuid]) {
              if (prev[uuid] === undefined) {
                delete next[uuid];
              } else {
                next[uuid] = prev[uuid];
              }
            }
          }
          return next;
        });
      }
    } catch (error) {
      clientLogger.error("Failed to fetch daemon executions:", error);
    } finally {
      setExecutionsLoaded(true);
    }
  }, []);

  // Poll loop — fires immediately then every 15s. Polls BOTH the connection list
  // (owns status + online count) and the execution aggregate (self-heals the
  // execution map for connections the SSE stream didn't subscribe to at open and
  // for any silently-dropped event). Clears on unmount.
  useEffect(() => {
    fetchConnections();
    fetchExecutions();
    const id = setInterval(() => {
      fetchConnections();
      fetchExecutions();
    }, POLL_INTERVAL_MS);
    return () => clearInterval(id);
  }, [fetchConnections, fetchExecutions]);

  // SSE spine — one company-wide `/api/events` stream that merges `execution`
  // events into the map. The aggregate first-paint + periodic re-sync is owned by
  // the poll loop above; this effect additionally re-pulls the aggregate on a
  // reconnect so the surface catches up immediately rather than waiting for the
  // next poll tick. Reconnect on `visibilitychange` whenever the stream is not
  // OPEN, and close on unmount. Held in a stable effect so the stream is NOT torn
  // down per navigation (the provider lives at the shell, above route changes).
  useEffect(() => {
    let es: EventSource | null = null;

    function connect() {
      disconnect();
      // No `projectUuid` — this is the company-wide stream that forwards every
      // visible connection's `execution:{connectionUuid}` events.
      es = new EventSource("/api/events");
      es.onmessage = (msg) => {
        let parsed: Record<string, unknown> | null = null;
        try {
          parsed = JSON.parse(msg.data);
        } catch {
          // Non-JSON message (e.g. heartbeat) — ignore.
          return;
        }
        if (!parsed) return;
        // Only execution events are of interest here; everything else (change /
        // presence) is the page-scoped provider's concern.
        if (parsed.type === "execution") {
          const event = parsed as unknown as ExecutionEvent;
          // Bump this connection's write generation so an aggregate poll that is
          // in flight knows this slice was freshened and must not be clobbered.
          connGenRef.current[event.connectionUuid] =
            (connGenRef.current[event.connectionUuid] ?? 0) + 1;
          setExecutionsByConnection((prev) => mergeExecutionEvent(prev, event));
        }
      };
      es.onerror = () => {
        // Browser EventSource auto-reconnects on error; nothing to do here.
      };
    }

    function disconnect() {
      if (es) {
        es.close();
        es = null;
      }
    }

    function handleVisibility() {
      if (document.visibilityState === "visible") {
        // A live stream is OPEN (readyState 1). A browser auto-reconnect after a
        // transient error leaves it CONNECTING (0), and an explicit close leaves
        // it CLOSED (2) — in BOTH cases events may have been missed and the stream
        // may be stuck, so anything other than OPEN forces a clean reconnect.
        // (Checking only === CLOSED never fires for the common auto-reconnect.)
        const streamHealthy = !!es && es.readyState === EventSource.OPEN;
        if (!streamHealthy) {
          // Reconnect and re-fetch the aggregate — execution events were missed
          // while the tab was hidden / the stream was down.
          connect();
          fetchExecutions();
        }
      }
    }

    // First paint: open the stream. The aggregate first fetch is owned by the
    // poll loop above (mount fetch), so we don't double-fetch it here.
    connect();
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      disconnect();
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [fetchExecutions]);

  const onlineCount = useMemo(
    () => computeOnlineCount(connections),
    [connections],
  );

  const value = useMemo<AgentPresenceValue>(
    () => ({
      status,
      connections,
      onlineCount,
      executionsByConnection,
      executionsLoaded,
      modalOpen,
      setModalOpen,
    }),
    [
      status,
      connections,
      onlineCount,
      executionsByConnection,
      executionsLoaded,
      modalOpen,
    ],
  );

  return (
    <AgentPresenceContext.Provider value={value}>
      {children}
    </AgentPresenceContext.Provider>
  );
}

/**
 * Read the shell-level agent-presence spine. Consumers (the pill, the popover,
 * the modal) all read from this one provider so there is a single poll + single
 * SSE stream and zero duplicate requests.
 *
 * Throws when used outside `AgentPresenceProvider` rather than silently no-oping:
 * the pill/popover/modal are always rendered inside the shell that mounts the
 * provider, so a missing provider is a wiring bug we want surfaced, not hidden.
 */
export function useAgentPresence(): AgentPresenceValue {
  const ctx = useContext(AgentPresenceContext);
  if (!ctx) {
    throw new Error(
      "useAgentPresence must be used within an AgentPresenceProvider",
    );
  }
  return ctx;
}
