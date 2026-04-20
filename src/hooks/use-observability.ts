"use client";

import { useCallback, useEffect, useState } from "react";
import type {
  EntityTokensResult,
  IdeaLifecycleResult,
  ProposalTokensResult,
} from "@/services/observability.service";
import { clientLogger } from "@/lib/logger-client";

// The /entity endpoint returns EntityTokensResult, and additionally { proposal }
// when entityType === "proposal".
export type EntityTokensWithProposal = EntityTokensResult & {
  proposal?: ProposalTokensResult;
};

interface FetchState<T> {
  data: T | null;
  isLoading: boolean;
  error: string | null;
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { cache: "no-store" });
  const body = (await res.json()) as
    | { success: true; data: T }
    | { success: false; error: string };
  if (!res.ok || !body.success) {
    const message = !body.success ? body.error : `Request failed: ${res.status}`;
    throw new Error(message);
  }
  return body.data;
}

export function useIdeaLifecycleTokens(
  projectUuid: string | null | undefined,
  ideaUuid: string | null | undefined
): FetchState<IdeaLifecycleResult> & { refetch: () => void } {
  const [state, setState] = useState<FetchState<IdeaLifecycleResult>>({
    data: null,
    isLoading: Boolean(projectUuid && ideaUuid),
    error: null,
  });

  const refetch = useCallback(() => {
    if (!projectUuid || !ideaUuid) {
      setState({ data: null, isLoading: false, error: null });
      return;
    }
    let cancelled = false;
    setState((s) => ({ ...s, isLoading: true, error: null }));
    fetchJson<IdeaLifecycleResult>(
      `/api/projects/${projectUuid}/observability/idea/${ideaUuid}`
    )
      .then((data) => {
        if (!cancelled) setState({ data, isLoading: false, error: null });
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        const message = e instanceof Error ? e.message : String(e);
        clientLogger.error("useIdeaLifecycleTokens failed:", e);
        setState({ data: null, isLoading: false, error: message });
      });
    return () => {
      cancelled = true;
    };
  }, [projectUuid, ideaUuid]);

  useEffect(() => {
    const cancel = refetch();
    return cancel;
  }, [refetch]);

  return { ...state, refetch };
}

export function useEntityTokens(
  projectUuid: string | null | undefined,
  entityType: "task" | "idea" | "proposal" | "document" | null | undefined,
  entityUuid: string | null | undefined
): FetchState<EntityTokensWithProposal> & { refetch: () => void } {
  const [state, setState] = useState<FetchState<EntityTokensWithProposal>>({
    data: null,
    isLoading: Boolean(projectUuid && entityType && entityUuid),
    error: null,
  });

  const refetch = useCallback(() => {
    if (!projectUuid || !entityType || !entityUuid) {
      setState({ data: null, isLoading: false, error: null });
      return;
    }
    let cancelled = false;
    setState((s) => ({ ...s, isLoading: true, error: null }));
    const url = `/api/projects/${projectUuid}/observability/entity?entityType=${encodeURIComponent(
      entityType
    )}&entityUuid=${encodeURIComponent(entityUuid)}`;
    fetchJson<EntityTokensWithProposal>(url)
      .then((data) => {
        if (!cancelled) setState({ data, isLoading: false, error: null });
      })
      .catch((e: unknown) => {
        if (cancelled) return;
        const message = e instanceof Error ? e.message : String(e);
        clientLogger.error("useEntityTokens failed:", e);
        setState({ data: null, isLoading: false, error: message });
      });
    return () => {
      cancelled = true;
    };
  }, [projectUuid, entityType, entityUuid]);

  useEffect(() => {
    const cancel = refetch();
    return cancel;
  }, [refetch]);

  return { ...state, refetch };
}
