import type { ReferenceArtifactResponse } from "@/services/reference-artifact.service";

export type CitationState =
  | { status: "loading" | "missing" | "error" }
  | { status: "ready"; reference: ReferenceArtifactResponse; refreshError?: boolean };

const loading: CitationState = { status: "loading" };

export const CITATION_REQUEST_TIMEOUT_MS = 10_000;

// Share only live requests across Markdown mounts, never resolved evidence.
// The last consumer cancels its request, including across page/session changes.
const requests = new Map<string, {
  promise: Promise<CitationState>;
  controller: AbortController;
  consumers: number;
}>();

function acquireRequest(uuid: string) {
  let request = requests.get(uuid);
  if (!request) {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let onAbort: () => void;
    const timeout = new Promise<never>((_, reject) => {
      onAbort = () => reject(new Error("Reference request canceled"));
      controller.signal.addEventListener("abort", onAbort, { once: true });
      timer = setTimeout(() => {
        reject(new Error("Reference request timed out"));
        controller.abort();
      }, CITATION_REQUEST_TIMEOUT_MS);
    });
    const lookup = (async (): Promise<CitationState> => {
      const response = await fetch(`/api/references/${uuid}`, {
        credentials: "same-origin", cache: "no-store", signal: controller.signal,
      });
      if (response.status === 404) return { status: "missing" };
      if (!response.ok) throw new Error("Reference request failed");
      const body = await response.json();
      if (!body.success || !body.data) throw new Error("Invalid reference response");
      return { status: "ready", reference: body.data };
    })();
    request = {
      controller, consumers: 0,
      promise: Promise.race([lookup, timeout]).finally(() => {
        clearTimeout(timer);
        controller.signal.removeEventListener("abort", onAbort);
        if (requests.get(uuid) === request) requests.delete(uuid);
      }),
    };
    requests.set(uuid, request);
  }
  request.consumers++;
  const acquired = request;
  return {
    promise: acquired.promise,
    release: () => {
      if (--acquired.consumers === 0) {
        acquired.controller.abort();
        if (requests.get(uuid) === acquired) requests.delete(uuid);
      }
    },
  };
}

/** One store per MarkdownContent mount; never shared across pages or sessions. */
export function createCitationStore() {
  const entries = new Map<string, {
    state: CitationState;
    listeners: Set<() => void>;
    pending?: Promise<void>;
    cancel?: () => void;
  }>();

  function refresh(uuid: string) {
    const entry = entries.get(uuid);
    if (!entry || entry.pending) return;
    const request = acquireRequest(uuid);
    let released = false;
    const release = () => {
      if (!released) request.release();
      released = true;
    };
    entry.cancel = release;
    entry.pending = (async () => {
      let state: CitationState;
      try {
        state = await request.promise;
      } catch {
        state = entry.state.status === "ready"
          ? { ...entry.state, refreshError: true }
          : { status: "error" };
      } finally {
        release();
      }
      // Unsubscribing the last marker invalidates even an in-flight response.
      if (entries.get(uuid) !== entry) return;
      entry.state = state;
      entry.pending = undefined;
      entry.cancel = undefined;
      entry.listeners.forEach((notify) => notify());
    })();
  }

  return {
    snapshot: (uuid: string) => entries.get(uuid)?.state ?? loading,
    serverSnapshot: () => loading,
    subscribe(uuid: string, notify: () => void) {
      let entry = entries.get(uuid);
      if (!entry) {
        entry = { state: loading, listeners: new Set() };
        entries.set(uuid, entry);
      }
      entry.listeners.add(notify);
      refresh(uuid);
      return () => {
        entry.listeners.delete(notify);
        if (!entry.listeners.size) {
          entry.cancel?.();
          entries.delete(uuid);
        }
      };
    },
    refresh,
    refreshAll: () => entries.forEach((_, uuid) => refresh(uuid)),
  };
}

export type CitationStore = ReturnType<typeof createCitationStore>;
