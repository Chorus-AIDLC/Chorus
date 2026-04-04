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

interface RealtimeContextType {
  subscribe: (callback: Subscriber) => () => void;
  subscribeEntity: (callback: EntitySubscriber) => () => void;
}

const RealtimeContext = createContext<RealtimeContextType | null>(null);

interface RealtimeProviderProps {
  projectUuid: string;
  children: ReactNode;
}

export function RealtimeProvider({ projectUuid, children }: RealtimeProviderProps) {
  const subscribersRef = useRef<Set<Subscriber>>(new Set());
  const entitySubscribersRef = useRef<Set<EntitySubscriber>>(new Set());

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

    function connect() {
      // Close any existing connection before opening a new one
      disconnect();
      es = new EventSource(`/api/events?projectUuid=${projectUuid}`);
      es.onmessage = (msg) => {
        // Parse event data for entity-specific subscribers
        let parsedEvent: RealtimeEvent | null = null;
        try {
          parsedEvent = JSON.parse(msg.data);
        } catch {
          // Non-JSON message (e.g. heartbeat) — ignore for entity subscribers
        }

        clearTimeout(debounceTimer);
        const now = Date.now();
        const elapsed = now - lastNotifyTime;

        if (elapsed >= THROTTLE_MS) {
          // Enough time has passed — refresh immediately
          lastNotifyTime = now;
          notify();
        } else {
          // Too soon — schedule a deferred refresh
          debounceTimer = setTimeout(() => {
            lastNotifyTime = Date.now();
            notify();
          }, Math.max(DEBOUNCE_MS, THROTTLE_MS - elapsed));
        }

        // Entity-specific events fire immediately (no throttle/debounce)
        if (parsedEvent) {
          notifyEntity(parsedEvent);
        }
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
        // If the connection was lost while hidden (e.g. browser suspended it),
        // reconnect and do a catch-up refresh for all subscriber types.
        if (!es || es.readyState === EventSource.CLOSED) {
          connect();
        }
        // Always notify on re-focus — events may have arrived but been throttled,
        // or the connection may have silently dropped.
        notify();
        // Fire a synthetic event for each entity type so entity-type subscribers
        // (kanban, ideas-list, etc.) also catch up on missed changes.
        for (const entityType of ["task", "idea", "proposal", "document", "project"] as const) {
          notifyEntity({ companyUuid: "", projectUuid: "", entityType, entityUuid: "", action: "updated" });
        }
      }
    }

    connect();
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      disconnect();
      clearTimeout(debounceTimer);
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

  // Memoize context value to avoid unnecessary re-renders of consumers
  const contextValue = useMemo(() => ({ subscribe, subscribeEntity }), [subscribe, subscribeEntity]);

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
 * Convenience hook: calls router.refresh() only when SSE events match
 * the given entity type(s). Much cheaper than useRealtimeRefresh() which
 * refreshes on every event regardless of type.
 */
export function useRealtimeEntityTypeRefresh(entityTypes: string | string[]) {
  const router = useRouter();
  useRealtimeEntityTypeEvent(entityTypes, () => {
    router.refresh();
  });
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
