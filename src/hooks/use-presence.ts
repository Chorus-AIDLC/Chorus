"use client";

import { useSyncExternalStore } from "react";
import { usePresenceSubscription, type PresenceEvent } from "@/contexts/realtime-context";

// Re-export for consumers
export type { PresenceEvent };

export interface PresenceEntry {
  agentUuid: string;
  agentName: string;
  action: "view" | "mutate";
  timestamp: number;
}

const PRESENCE_DURATION_MS = 3000;

// Module-level presence store — shared across all hook instances
const presenceMap = new Map<string, PresenceEntry[]>();
const dedupMap = new Map<string, number>(); // key → last timestamp for dedup
const timers = new Map<string, NodeJS.Timeout>(); // entryKey → cleanup timer
let storeListeners = new Set<() => void>();
let version = 0;

function presenceKey(entityType: string, entityUuid: string, subEntityType?: string, subEntityUuid?: string): string {
  if (subEntityType) {
    return subEntityUuid
      ? `${entityType}:${entityUuid}:${subEntityType}:${subEntityUuid}`
      : `${entityType}:${entityUuid}:${subEntityType}`;
  }
  return `${entityType}:${entityUuid}`;
}

function dedupKeyFor(entityType: string, entityUuid: string, agentUuid: string, subEntityType?: string, subEntityUuid?: string): string {
  const base = presenceKey(entityType, entityUuid, subEntityType, subEntityUuid);
  return `${base}:${agentUuid}`;
}

function notifyListeners() {
  version++;
  storeListeners.forEach((l) => l());
}

function addPresence(event: PresenceEvent) {
  const subType = event.subEntityType;
  const subUuid = event.subEntityUuid;
  const pKey = presenceKey(event.entityType, event.entityUuid, subType, subUuid);
  const dKey = dedupKeyFor(event.entityType, event.entityUuid, event.agentUuid, subType, subUuid);

  // Frontend dedup: same agent+entity within 3s
  const lastTime = dedupMap.get(dKey);
  if (lastTime && Date.now() - lastTime < PRESENCE_DURATION_MS) {
    return;
  }
  dedupMap.set(dKey, Date.now());

  const entry: PresenceEntry = {
    agentUuid: event.agentUuid,
    agentName: event.agentName,
    action: event.action,
    timestamp: Date.now(),
  };

  // Add/replace entry for this agent on this entity
  const entries = presenceMap.get(pKey) ?? [];
  const filtered = entries.filter((e) => e.agentUuid !== event.agentUuid);
  filtered.push(entry);
  presenceMap.set(pKey, filtered);

  // Clear previous timer for this agent+entity
  const existingTimer = timers.get(dKey);
  if (existingTimer) clearTimeout(existingTimer);

  // Auto-clear after 3 seconds
  const timer = setTimeout(() => {
    const current = presenceMap.get(pKey);
    if (current) {
      const remaining = current.filter((e) => e.agentUuid !== event.agentUuid);
      if (remaining.length === 0) {
        presenceMap.delete(pKey);
      } else {
        presenceMap.set(pKey, remaining);
      }
    }
    dedupMap.delete(dKey);
    timers.delete(dKey);
    notifyListeners();
  }, PRESENCE_DURATION_MS);
  timers.set(dKey, timer);

  notifyListeners();
}

function getSnapshot(): number {
  return version;
}

function subscribeStore(callback: () => void): () => void {
  storeListeners.add(callback);
  return () => {
    storeListeners.delete(callback);
  };
}

/** Reset store — for testing */
export function _resetPresenceStore() {
  for (const timer of timers.values()) clearTimeout(timer);
  timers.clear();
  presenceMap.clear();
  dedupMap.clear();
  version = 0;
  storeListeners = new Set();
}

/** Expose addPresence for testing and manual injection */
export const _addPresence = addPresence;

/**
 * Manually inject a presence entry for a sub-entity.
 * Use this when a new sub-item appears and you want to show presence on it.
 */
export function injectPresence(params: {
  entityType: PresenceEvent["entityType"];
  entityUuid: string;
  subEntityType: string;
  subEntityUuid: string;
  agentUuid: string;
  agentName: string;
  action: "view" | "mutate";
}) {
  addPresence({
    type: "presence",
    companyUuid: "",
    projectUuid: "",
    ...params,
    timestamp: Date.now(),
  });
}

/**
 * Hook to subscribe to agent presence events.
 * Returns getPresence to query active presences for a resource, optionally at sub-entity level.
 */
export function usePresence() {
  // Subscribe to store changes for re-render
  useSyncExternalStore(subscribeStore, getSnapshot, getSnapshot);

  // Subscribe to SSE presence events via RealtimeContext
  usePresenceSubscription(addPresence);

  const getPresence = (
    entityType: string,
    entityUuid: string,
    subEntityType?: string,
    subEntityUuid?: string
  ): PresenceEntry[] => {
    // Exact sub-entity query
    if (subEntityType) {
      return presenceMap.get(presenceKey(entityType, entityUuid, subEntityType, subEntityUuid)) ?? [];
    }

    // No sub-entity specified: aggregate all keys prefixed with entityType:entityUuid
    const prefix = `${entityType}:${entityUuid}`;
    const seen = new Map<string, PresenceEntry>();
    for (const [key, entries] of presenceMap) {
      if (key === prefix || key.startsWith(prefix + ":")) {
        for (const e of entries) {
          const existing = seen.get(e.agentUuid);
          if (!existing || e.timestamp > existing.timestamp) {
            seen.set(e.agentUuid, e);
          }
        }
      }
    }
    return [...seen.values()];
  };

  return { getPresence };
}
