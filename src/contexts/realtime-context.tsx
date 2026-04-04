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

        // Entity-specific events: debounced per entity type (300ms)
        if (parsedEvent) {
          debouncedNotifyEntity(parsedEvent);
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
        const connectionLost = !es || es.readyState === EventSource.CLOSED;
        if (connectionLost) {
          // Reconnect and catch up — events were missed while disconnected.
          connect();
          notify();
          for (const entityType of ["task", "idea", "proposal", "document", "project"]) {
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
