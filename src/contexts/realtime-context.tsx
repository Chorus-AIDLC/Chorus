"use client";

import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useCallback,
  useMemo,
  type ReactNode,
} from "react";
import { useRouter } from "next/navigation";

type Subscriber = () => void;

interface RealtimeEvent {
  companyUuid: string;
  projectUuid: string;
  entityType: string;
  entityUuid: string;
  action: string;
  actorUuid?: string;
}

type EntitySubscriber = (event: RealtimeEvent) => void;

// Re-export backend PresenceEvent with SSE `type` discriminator
export type { PresenceEvent as PresenceEventBase } from "@/lib/event-bus";
export interface PresenceEvent {
  type: "presence";
  companyUuid: string;
  projectUuid: string;
  entityType: "task" | "idea" | "proposal" | "document";
  entityUuid: string;
  subEntityType?: string;
  subEntityUuid?: string;
  agentUuid: string;
  agentName: string;
  action: "view" | "mutate";
  timestamp: number;
}

type PresenceSubscriber = (event: PresenceEvent) => void;

// Re-export the backend execution-state types so consumers (the Agent
// Connections page) share one source of truth for the row/event shape.
export type {
  ExecutionView,
  ExecutionEvent as ExecutionEventBase,
} from "@/services/daemon-execution.service";
import type { ExecutionEvent as ExecutionEventBase } from "@/services/daemon-execution.service";

// SSE-tagged execution event: the backend ExecutionEvent plus the `type`
// discriminator the SSE route adds so the client can route it. Carries the
// connection's full current active (`running`/`queued`) set so a subscriber
// re-renders directly off the event without a follow-up read.
export interface ExecutionEvent extends ExecutionEventBase {
  type: "execution";
}

type ExecutionSubscriber = (event: ExecutionEvent) => void;

interface RealtimeContextType {
  subscribe: (callback: Subscriber) => () => void;
  subscribeEntity: (callback: EntitySubscriber) => () => void;
  subscribePresence: (callback: PresenceSubscriber) => () => void;
  subscribeExecution: (callback: ExecutionSubscriber) => () => void;
}

const RealtimeContext = createContext<RealtimeContextType | null>(null);

interface RealtimeProviderProps {
  projectUuid?: string | null;
  children: ReactNode;
}

export function RealtimeProvider({ projectUuid, children }: RealtimeProviderProps) {
  const subscribersRef = useRef<Set<Subscriber>>(new Set());
  const entitySubscribersRef = useRef<Set<EntitySubscriber>>(new Set());
  const presenceSubscribersRef = useRef<Set<PresenceSubscriber>>(new Set());
  const executionSubscribersRef = useRef<Set<ExecutionSubscriber>>(new Set());

  const notify = useCallback(() => {
    subscribersRef.current.forEach((cb) => cb());
  }, []);

  const notifyEntity = useCallback((event: RealtimeEvent) => {
    entitySubscribersRef.current.forEach((cb) => cb(event));
  }, []);

  useEffect(() => {
    let es: EventSource | null = null;
    let debounceTimer: NodeJS.Timeout;

    let lastNotifyTime = 0;
    const THROTTLE_MS = 3000;  // At most 1 refresh every 3 seconds
    const DEBOUNCE_MS = 1000;  // Wait 1s of silence before refreshing

    // Per-entityType debounce timers for entity subscribers
    const entityDebounceTimers: Record<string, NodeJS.Timeout> = {};
    const ENTITY_DEBOUNCE_MS = 300;

    function debouncedNotifyEntity(event: RealtimeEvent) {
      const key = event.entityType;
      clearTimeout(entityDebounceTimers[key]);
      entityDebounceTimers[key] = setTimeout(() => {
        notifyEntity(event);
      }, ENTITY_DEBOUNCE_MS);
    }

    function connect() {
      // Close any existing connection before opening a new one
      disconnect();
      const url = projectUuid
        ? `/api/events?projectUuid=${projectUuid}`
        : `/api/events`;
      es = new EventSource(url);
      es.onmessage = (msg) => {
        // Parse event data
        let parsed: Record<string, unknown> | null = null;
        try {
          parsed = JSON.parse(msg.data);
        } catch {
          // Non-JSON message (e.g. heartbeat) — ignore
          return;
        }

        if (!parsed) return;

        // Route presence events to dedicated subscribers — skip notify/debouncedNotifyEntity
        if (parsed.type === "presence") {
          presenceSubscribersRef.current.forEach((cb) => cb(parsed as unknown as PresenceEvent));
          return;
        }

        // Route execution-state events to dedicated subscribers. Delivered
        // immediately (no debounce): execution changes are already coalesced
        // server-side into a single per-connection snapshot, and the detail pane
        // must reflect a task starting/finishing without lag.
        if (parsed.type === "execution") {
          executionSubscribersRef.current.forEach((cb) => cb(parsed as unknown as ExecutionEvent));
          return;
        }

        // Existing change event handling (backward compatible)
        const parsedEvent = parsed as unknown as RealtimeEvent;

        clearTimeout(debounceTimer);
        const now = Date.now();
        const elapsed = now - lastNotifyTime;

        if (elapsed >= THROTTLE_MS) {
          lastNotifyTime = now;
          notify();
        } else {
          debounceTimer = setTimeout(() => {
            lastNotifyTime = Date.now();
            notify();
          }, Math.max(DEBOUNCE_MS, THROTTLE_MS - elapsed));
        }

        // Entity-specific events: debounced per entity type (300ms)
        debouncedNotifyEntity(parsedEvent);
      };
      es.onerror = () => {
        // Browser EventSource auto-reconnects on error
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
        const connectionLost = !es || es.readyState === EventSource.CLOSED;
        if (connectionLost) {
          // Reconnect and catch up — events were missed while disconnected.
          connect();
          notify();
          for (const entityType of ["task", "idea", "proposal", "document", "project", "project_group"]) {
            notifyEntity({ companyUuid: "", projectUuid: "", entityType, entityUuid: "", action: "updated" });
          }
        }
      }
    }

    connect();
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      disconnect();
      clearTimeout(debounceTimer);
      for (const key in entityDebounceTimers) clearTimeout(entityDebounceTimers[key]);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [projectUuid, notify, notifyEntity]);

  const subscribe = useCallback((callback: Subscriber) => {
    subscribersRef.current.add(callback);
    return () => {
      subscribersRef.current.delete(callback);
    };
  }, []);

  const subscribeEntity = useCallback((callback: EntitySubscriber) => {
    entitySubscribersRef.current.add(callback);
    return () => {
      entitySubscribersRef.current.delete(callback);
    };
  }, []);

  const subscribePresence = useCallback((callback: PresenceSubscriber) => {
    presenceSubscribersRef.current.add(callback);
    return () => {
      presenceSubscribersRef.current.delete(callback);
    };
  }, []);

  const subscribeExecution = useCallback((callback: ExecutionSubscriber) => {
    executionSubscribersRef.current.add(callback);
    return () => {
      executionSubscribersRef.current.delete(callback);
    };
  }, []);

  // Memoize context value to avoid unnecessary re-renders of consumers
  const contextValue = useMemo(
    () => ({ subscribe, subscribeEntity, subscribePresence, subscribeExecution }),
    [subscribe, subscribeEntity, subscribePresence, subscribeExecution],
  );

  return (
    <RealtimeContext.Provider value={contextValue}>
      {children}
    </RealtimeContext.Provider>
  );
}

/**
 * Subscribe a callback to SSE events. The callback fires on mount (initial)
 * and on every subsequent SSE event from the project stream.
 * No-ops gracefully if called outside RealtimeProvider (e.g. during initial layout render).
 */
export function useRealtimeEvent(callback: () => void) {
  const context = useContext(RealtimeContext);

  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  useEffect(() => {
    if (!context) return;
    const handler = () => callbackRef.current();
    // Fire on mount for initial data fetch
    handler();
    return context.subscribe(handler);
  }, [context]);
}

/**
 * Convenience hook: calls router.refresh() on every SSE event.
 */
export function useRealtimeRefresh() {
  const router = useRouter();
  useRealtimeEvent(() => {
    router.refresh();
  });
}

/**
 * Subscribe to SSE events filtered by one or more entity types.
 * The callback fires only when events match any of the given entityTypes.
 * Does NOT fire on mount — only on matching SSE events.
 * Events are debounced per entity type (300ms) to batch rapid-fire updates.
 */
export function useRealtimeEntityTypeEvent(
  entityTypes: string | string[],
  callback: (event: RealtimeEvent) => void
) {
  const context = useContext(RealtimeContext);
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  const typesRef = useRef(entityTypes);
  typesRef.current = entityTypes;

  useEffect(() => {
    if (!context) return;
    const handler = (event: RealtimeEvent) => {
      const types = typesRef.current;
      const match = Array.isArray(types)
        ? types.includes(event.entityType)
        : event.entityType === types;
      if (match) {
        callbackRef.current(event);
      }
    };
    return context.subscribeEntity(handler);
  }, [context]);
}

/**
 * Subscribe to presence events from the SSE stream.
 * No-ops gracefully outside RealtimeProvider.
 */
export function usePresenceSubscription(callback: (event: PresenceEvent) => void) {
  const context = useContext(RealtimeContext);
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  useEffect(() => {
    if (!context) return;
    const handler = (event: PresenceEvent) => callbackRef.current(event);
    return context.subscribePresence(handler);
  }, [context]);
}

/**
 * Subscribe to daemon execution-state events for a single connection. The
 * callback fires only on `execution` events whose `connectionUuid` matches the
 * given one, carrying that connection's current active (`running`/`queued`) set.
 * Does NOT fire on mount — the caller renders first-paint state from the read API
 * and then lets this hook keep it live. No-ops gracefully outside
 * RealtimeProvider (e.g. during initial layout render).
 *
 * A null/empty `connectionUuid` subscribes to nothing (the page passes null when
 * no connection is selected), so the hook order stays stable across selections.
 */
export function useExecutionSubscription(
  connectionUuid: string | null | undefined,
  callback: (event: ExecutionEvent) => void,
) {
  const context = useContext(RealtimeContext);
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  useEffect(() => {
    if (!context || !connectionUuid) return;
    const handler = (event: ExecutionEvent) => {
      if (event.connectionUuid === connectionUuid) {
        callbackRef.current(event);
      }
    };
    return context.subscribeExecution(handler);
  }, [context, connectionUuid]);
}

/**
 * Subscribe to SSE events for a specific entity. The callback fires only when
 * events match the given entityType and entityUuid. Does NOT fire on mount.
 * No-ops gracefully outside RealtimeProvider.
 */
export function useRealtimeEntityEvent(
  entityType: string,
  entityUuid: string,
  callback: (event: RealtimeEvent) => void
) {
  const context = useContext(RealtimeContext);
  const callbackRef = useRef(callback);
  callbackRef.current = callback;

  useEffect(() => {
    if (!context) return;
    const handler = (event: RealtimeEvent) => {
      if (event.entityType === entityType && event.entityUuid === entityUuid) {
        callbackRef.current(event);
      }
    };
    return context.subscribeEntity(handler);
  }, [context, entityType, entityUuid]);
}
