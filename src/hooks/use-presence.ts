"use client";

import { useEffect, useSyncExternalStore } from "react";
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

function entityKey(entityType: string, entityUuid: string): string {
  return `${entityType}:${entityUuid}`;
}

function dedupKey(entityType: string, entityUuid: string, agentUuid: string): string {
  return `${entityType}:${entityUuid}:${agentUuid}`;
}

function notifyListeners() {
  version++;
  storeListeners.forEach((l) => l());
}

function addPresence(event: PresenceEvent) {
  const eKey = entityKey(event.entityType, event.entityUuid);
  const dKey = dedupKey(event.entityType, event.entityUuid, event.agentUuid);

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
  const entries = presenceMap.get(eKey) ?? [];
  const filtered = entries.filter((e) => e.agentUuid !== event.agentUuid);
  filtered.push(entry);
  presenceMap.set(eKey, filtered);

  // Clear previous timer for this agent+entity
  const existingTimer = timers.get(dKey);
  if (existingTimer) clearTimeout(existingTimer);

  // Auto-clear after 3 seconds
  const timer = setTimeout(() => {
    const current = presenceMap.get(eKey);
    if (current) {
      const remaining = current.filter((e) => e.agentUuid !== event.agentUuid);
      if (remaining.length === 0) {
        presenceMap.delete(eKey);
      } else {
        presenceMap.set(eKey, remaining);
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

/** Expose addPresence for testing */
export const _addPresence = addPresence;

/**
 * Hook to subscribe to agent presence events.
 * Returns getPresence(entityType, entityUuid) to query active presences for a resource.
 */
export function usePresence() {
  // Subscribe to store changes for re-render
  useSyncExternalStore(subscribeStore, getSnapshot, getSnapshot);

  // Subscribe to SSE presence events via RealtimeContext
  usePresenceSubscription(addPresence);

  const getPresence = (entityType: string, entityUuid: string): PresenceEntry[] => {
    return presenceMap.get(entityKey(entityType, entityUuid)) ?? [];
  };

  return { getPresence };
}
