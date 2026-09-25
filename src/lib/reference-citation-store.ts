import type { ReferenceArtifactResponse } from "@/services/reference-artifact.service";

export type CitationState =
  | { status: "loading" | "missing" | "error" }
  | { status: "ready"; reference: ReferenceArtifactResponse };

const loading: CitationState = { status: "loading" };

/** One store per MarkdownContent mount; never shared across pages or sessions. */
export function createCitationStore() {
  const entries = new Map<string, {
    state: CitationState;
    listeners: Set<() => void>;
    pending?: Promise<void>;
  }>();

  function refresh(uuid: string) {
    const entry = entries.get(uuid);
    if (!entry || entry.pending) return;
    entry.pending = (async () => {
      let state: CitationState;
      try {
        const response = await fetch(`/api/references/${uuid}`, {
          credentials: "same-origin",
          cache: "no-store",
        });
        if (response.status === 404) {
          state = { status: "missing" };
        } else {
          if (!response.ok) throw new Error("Reference request failed");
          const body = await response.json();
          if (!body.success || !body.data) throw new Error("Invalid reference response");
          state = { status: "ready", reference: body.data };
        }
      } catch {
        state = { status: "error" };
      }
      // Unsubscribing the last marker invalidates even an in-flight response.
      if (entries.get(uuid) !== entry) return;
      entry.state = state;
      entry.pending = undefined;
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
        if (!entry.listeners.size) entries.delete(uuid);
      };
    },
    refresh,
    refreshAll: () => entries.forEach((_, uuid) => refresh(uuid)),
  };
}

export type CitationStore = ReturnType<typeof createCitationStore>;
