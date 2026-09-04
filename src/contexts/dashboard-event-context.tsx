"use client";

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
import type { ExecutionEvent as ExecutionEventBase } from "@/services/daemon-execution.service";

export type DashboardEvent = Record<string, unknown> & { type?: unknown };
export type DashboardEventSubscriber = (event: DashboardEvent) => void;

// Client-synthetic event `type` the transport fans out to subscribers on every
// EventSource `open`, BEFORE any `message` of that connection (the EventSource
// spec guarantees `open` fires first). Domain consumers whose derived state must
// be reset per-connection (e.g. agent-presence session-activity) clear it on this
// in-band event instead of in a passive effect keyed on `openGeneration` — a
// passive effect can run AFTER the connection's replay has already repopulated the
// state and erase it (the wipe-vs-replay race). The server never emits this type.
export const STREAM_RESET_EVENT = "stream_reset";

export interface DashboardExecutionEvent extends ExecutionEventBase {
  type: "execution";
}

interface DashboardEventContextValue {
  subscribe: (callback: DashboardEventSubscriber) => () => void;
  openGeneration: number;
  sessionUuid: string | null;
  setSessionUuid: (sessionUuid: string | null) => void;
}

const DashboardEventContext = createContext<DashboardEventContextValue | null>(null);

export function buildDashboardEventsUrl(sessionUuid: string | null): string {
  if (!sessionUuid) return "/api/events";
  return `/api/events?sessionUuid=${encodeURIComponent(sessionUuid)}`;
}

export function DashboardEventProvider({ children }: { children: ReactNode }) {
  const subscribersRef = useRef<Set<DashboardEventSubscriber>>(new Set());
  const [openGeneration, setOpenGeneration] = useState(0);
  const [sessionUuid, setSessionUuid] = useState<string | null>(null);

  const subscribe = useCallback((callback: DashboardEventSubscriber) => {
    subscribersRef.current.add(callback);
    return () => {
      subscribersRef.current.delete(callback);
    };
  }, []);

  useEffect(() => {
    let eventSource: EventSource | null = null;

    const disconnect = () => {
      if (!eventSource) return;
      eventSource.close();
      eventSource = null;
    };

    const connect = () => {
      disconnect();
      eventSource = new EventSource(buildDashboardEventsUrl(sessionUuid));
      eventSource.onopen = () => {
        setOpenGeneration((generation) => generation + 1);
        // In-band, synchronous connect reset. Dispatched through the SAME
        // subscriber fan-out as messages, so every subscriber receives it BEFORE
        // any replay `onmessage` of this connection (open fires before message).
        // This is the ordering guarantee that lets domain consumers reset
        // per-connection state without racing the server's on-connect replay.
        for (const callback of subscribersRef.current) {
          callback({ type: STREAM_RESET_EVENT });
        }
      };
      eventSource.onmessage = (message) => {
        let parsed: DashboardEvent;
        try {
          parsed = JSON.parse(message.data) as DashboardEvent;
        } catch {
          return;
        }
        for (const callback of subscribersRef.current) callback(parsed);
      };
      eventSource.onerror = () => {
        // Native EventSource reconnects automatically. Its next open increments
        // openGeneration so domain consumers can repair any delivery gap.
      };
    };

    const handleVisibility = () => {
      if (document.visibilityState !== "visible") return;
      const streamHealthy =
        eventSource != null && eventSource.readyState === EventSource.OPEN;
      if (!streamHealthy) connect();
    };

    connect();
    document.addEventListener("visibilitychange", handleVisibility);

    return () => {
      disconnect();
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [sessionUuid]);

  useEffect(
    () => () => {
      subscribersRef.current.clear();
    },
    [],
  );

  const value = useMemo<DashboardEventContextValue>(
    () => ({ subscribe, openGeneration, sessionUuid, setSessionUuid }),
    [subscribe, openGeneration, sessionUuid],
  );

  return (
    <DashboardEventContext.Provider value={value}>
      {children}
    </DashboardEventContext.Provider>
  );
}

export function useDashboardEvents(): DashboardEventContextValue {
  const context = useContext(DashboardEventContext);
  if (!context) {
    throw new Error("useDashboardEvents must be used within DashboardEventProvider");
  }
  return context;
}

export function useDashboardEventsOptional(): DashboardEventContextValue | null {
  return useContext(DashboardEventContext);
}
