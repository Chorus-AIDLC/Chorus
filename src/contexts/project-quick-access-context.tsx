"use client";

// Shared project quick-access state — the SINGLE SOURCE OF TRUTH for the
// sidebar's recently-visited + pinned projects.
//
// This provider is mounted ONCE at the dashboard shell level
// (src/app/(dashboard)/layout.tsx), wrapping the whole shell, so every consumer
// reads and writes the SAME { pinned, recent } aggregate:
//   - the persistent sidebar region (sidebar-project-quick-access.tsx),
//   - the visit-recording effect in the layout,
//   - the pin control on the /projects page cards (a later task).
//
// Why a provider and not per-component fetches: the sidebar lives in the
// persistent layout and would otherwise only re-fetch on mount + SSE
// project/project_group events. But a visit POST or a card pin PUT/DELETE emits
// no such SSE event, so on /projects (where the expanded region sits right next
// to the cards) a card pin or a visit would not appear in the sidebar until a
// full reload. Routing every mutation through one shared aggregate closes that
// gap — pin/unpin/recordVisit all replace this state and every consumer
// re-renders immediately, no reload.

import {
  createContext,
  useContext,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { authFetch } from "@/lib/auth-client";
import { useRealtimeEntityTypeEvent } from "@/contexts/realtime-context";
import { clientLogger } from "@/lib/logger-client";

/** A resolved quick-access row: project identity + its group name (null if ungrouped). */
export interface QuickAccessProjectRef {
  uuid: string;
  name: string;
  groupUuid: string | null;
  groupName: string | null;
}

/** The sidebar quick-access aggregate for the signed-in user. */
export interface QuickAccessAggregate {
  pinned: QuickAccessProjectRef[];
  recent: QuickAccessProjectRef[];
}

interface ProjectQuickAccessContextValue {
  pinned: QuickAccessProjectRef[];
  recent: QuickAccessProjectRef[];
  /** True once the initial GET has resolved (success or failure). */
  loaded: boolean;
  /** Pin a project — persists then replaces state with the fresh aggregate. */
  pin: (projectUuid: string) => Promise<void>;
  /** Unpin a project — persists then replaces state with the fresh aggregate. */
  unpin: (projectUuid: string) => Promise<void>;
  /** Record a visit (best-effort) then re-read the aggregate so recent updates live. */
  recordVisit: (projectUuid: string) => Promise<void>;
  /** True when the project is currently in the pinned list. */
  isPinned: (projectUuid: string) => boolean;
}

const EMPTY: QuickAccessAggregate = { pinned: [], recent: [] };

const ProjectQuickAccessContext =
  createContext<ProjectQuickAccessContextValue | null>(null);

export function ProjectQuickAccessProvider({ children }: { children: ReactNode }) {
  const [aggregate, setAggregate] = useState<QuickAccessAggregate>(EMPTY);
  const [loaded, setLoaded] = useState(false);

  // Fetch the current aggregate from the server and replace local state.
  // Best-effort: a failure leaves the last-known state and flips `loaded` so
  // the region can render its empty state rather than hang.
  const refresh = useCallback(async () => {
    try {
      const res = await authFetch("/api/project-visits");
      if (!res.ok) return;
      const json = await res.json();
      if (json?.success && json.data) {
        setAggregate({
          pinned: json.data.pinned ?? [],
          recent: json.data.recent ?? [],
        });
      }
    } catch (error) {
      clientLogger.error("Failed to fetch project quick-access:", error);
    } finally {
      setLoaded(true);
    }
  }, []);

  // Initial load on mount.
  useEffect(() => {
    refresh();
  }, [refresh]);

  // Re-fetch when a project or project group changes elsewhere (create / rename
  // / delete / move). No-ops gracefully when mounted outside a RealtimeProvider
  // (the shell mount point is above the per-route provider) — the shared-state
  // path below keeps the sidebar live for the mutations that emit no SSE event
  // (visit POST, card pin PUT/DELETE), which is the review-blocker fix.
  useRealtimeEntityTypeEvent(["project", "project_group"], () => {
    refresh();
  });

  const pin = useCallback(async (projectUuid: string) => {
    try {
      const res = await authFetch("/api/project-visits/pin", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectUuid }),
      });
      if (!res.ok) return;
      const json = await res.json();
      // The pin endpoint returns the FRESH aggregate — replace state in one
      // round-trip so every consumer reflects the pin immediately.
      if (json?.success && json.data) {
        setAggregate({
          pinned: json.data.pinned ?? [],
          recent: json.data.recent ?? [],
        });
      }
    } catch (error) {
      clientLogger.error("Failed to pin project:", error);
    }
  }, []);

  const unpin = useCallback(async (projectUuid: string) => {
    try {
      const res = await authFetch("/api/project-visits/pin", {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ projectUuid }),
      });
      if (!res.ok) return;
      const json = await res.json();
      if (json?.success && json.data) {
        setAggregate({
          pinned: json.data.pinned ?? [],
          recent: json.data.recent ?? [],
        });
      }
    } catch (error) {
      clientLogger.error("Failed to unpin project:", error);
    }
  }, []);

  const recordVisit = useCallback(
    async (projectUuid: string) => {
      try {
        const res = await authFetch("/api/project-visits/visit", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ projectUuid }),
        });
        // The visit endpoint returns only a minimal ack; re-read the aggregate
        // so the visited project floats to the top of recent in the live
        // sidebar with no reload.
        if (res.ok) {
          await refresh();
        }
      } catch (error) {
        // Best-effort — a failed visit record must never surface or block.
        clientLogger.error("Failed to record project visit:", error);
      }
    },
    [refresh],
  );

  const pinnedUuids = useMemo(
    () => new Set(aggregate.pinned.map((p) => p.uuid)),
    [aggregate.pinned],
  );
  // Keep isPinned referentially stable while reading the latest set via a ref,
  // so consumers that depend on it don't churn.
  const pinnedUuidsRef = useRef(pinnedUuids);
  pinnedUuidsRef.current = pinnedUuids;
  const isPinned = useCallback(
    (projectUuid: string) => pinnedUuidsRef.current.has(projectUuid),
    [],
  );

  const value = useMemo<ProjectQuickAccessContextValue>(
    () => ({
      pinned: aggregate.pinned,
      recent: aggregate.recent,
      loaded,
      pin,
      unpin,
      recordVisit,
      isPinned,
    }),
    [aggregate.pinned, aggregate.recent, loaded, pin, unpin, recordVisit, isPinned],
  );

  return (
    <ProjectQuickAccessContext.Provider value={value}>
      {children}
    </ProjectQuickAccessContext.Provider>
  );
}

/**
 * Read the shared project quick-access state. Must be used within
 * ProjectQuickAccessProvider (mounted at the dashboard shell). Throws if used
 * outside, matching the other shell-level providers — a missing provider is a
 * wiring bug, not a runtime-degradable condition.
 */
export function useProjectQuickAccess(): ProjectQuickAccessContextValue {
  const ctx = useContext(ProjectQuickAccessContext);
  if (!ctx) {
    throw new Error(
      "useProjectQuickAccess must be used within a ProjectQuickAccessProvider",
    );
  }
  return ctx;
}
