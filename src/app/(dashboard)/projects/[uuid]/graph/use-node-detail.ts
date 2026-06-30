"use client";

// Fetch-on-hover node-detail hook for the resource-graph tooltip (desktop).
//
// Per design.md D3: when a node is hovered the tooltip needs the one thing the
// graph itself can't show — its lifecycle status (or, for a Document, its
// document type). That detail is NOT carried in the lean aggregation payload,
// so it's fetched per entity on demand from the existing per-entity REST read
// endpoints. To keep a fast hover sweep from firing a request burst the fetch
// is debounced ~200ms after `hoverId` settles, the in-flight request is aborted
// when the hover moves on (so a slower earlier response can't clobber a newer
// id's detail), and every resolved detail is cached per-uuid for the hook's
// lifetime so re-hovering is instant.
//
// This hook is intentionally framework-light and unit-testable: no canvas, no
// DOM, no UI. The tooltip overlay + canvas wiring is a separate task.

import { useEffect, useRef, useState } from "react";
import type { ResourceGraphNodeType } from "@/services/resource-graph.service";
import { clientLogger } from "@/lib/logger-client";

export type NodeType = ResourceGraphNodeType;

// What the tooltip badge needs. The title already comes from the node payload,
// so the hook only resolves the badge dimension: a lifecycle `status` for
// idea/proposal/task, or `docType` for a Document (which has no status).
export type NodeDetail = {
  uuid: string;
  status?: string;
  docType?: string;
};

// Map each node type to its existing per-entity REST read endpoint. Note the
// pluralized path segments (idea → /api/ideas/...).
const ENDPOINT: Record<NodeType, string> = {
  idea: "/api/ideas",
  proposal: "/api/proposals",
  task: "/api/tasks",
  document: "/api/documents",
};

// Debounce window after `hoverId` settles before a fetch fires (ms). A hoverId
// change inside this window cancels the pending fetch.
const DEBOUNCE_MS = 200;

type DetailEnvelope = {
  success: boolean;
  data?: { status?: string; type?: string };
  error?: string;
};

export function useNodeDetail(
  hoverId: string | null,
  type: NodeType | null,
): { detail: NodeDetail | null; loading: boolean } {
  const [detail, setDetail] = useState<NodeDetail | null>(null);
  const [loading, setLoading] = useState(false);

  // Per-uuid cache for the lifetime of the hook. A cache hit returns instantly
  // with no refetch and no loading flash.
  const cacheRef = useRef<Map<string, NodeDetail>>(new Map());

  useEffect(() => {
    // No hover (or no type) → nothing to show, nothing in flight.
    if (!hoverId || !type) {
      setDetail(null);
      setLoading(false);
      return;
    }

    // Cache hit → show immediately, no fetch, no loading.
    const cached = cacheRef.current.get(hoverId);
    if (cached) {
      setDetail(cached);
      setLoading(false);
      return;
    }

    // Cache miss → debounce, then fetch. The cleanup clears the pending timer
    // (so a fast sweep fires no request for ids merely passed over) and aborts
    // the in-flight request (so a slower earlier response can't overwrite the
    // newer hovered id's detail). Mirror the document-fetch AbortController
    // idiom in resource-graph.tsx.
    setDetail(null);
    setLoading(true);

    const ac = new AbortController();
    const timer = setTimeout(() => {
      (async () => {
        try {
          const res = await fetch(`${ENDPOINT[type]}/${hoverId}`, {
            signal: ac.signal,
          });
          const json: DetailEnvelope = await res.json();
          if (ac.signal.aborted) return;
          if (!res.ok || !json.success || !json.data) {
            clientLogger.error(
              "Failed to load node detail for graph tooltip:",
              json.error,
            );
            setLoading(false);
            return;
          }
          // Document has no lifecycle status — surface its type as docType.
          const next: NodeDetail =
            type === "document"
              ? { uuid: hoverId, docType: json.data.type }
              : { uuid: hoverId, status: json.data.status };
          cacheRef.current.set(hoverId, next);
          setDetail(next);
          setLoading(false);
        } catch (err) {
          if (ac.signal.aborted) return;
          clientLogger.error(
            "Failed to load node detail for graph tooltip:",
            err,
          );
          setLoading(false);
        }
      })();
    }, DEBOUNCE_MS);

    return () => {
      clearTimeout(timer);
      ac.abort();
    };
  }, [hoverId, type]);

  return { detail, loading };
}
