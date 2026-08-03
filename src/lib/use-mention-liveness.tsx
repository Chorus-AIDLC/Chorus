"use client";

// React hook over the pure `resolveMentionLiveness` rule — feeds it the live
// `connections` from the shell-level agent-presence spine so a mention badge can
// read its instance-precise (pinned) / agent-overall (non-pinned) online verdict
// without threading props. The matching rule itself lives in `mention-liveness.ts`
// (pure, React-free, unit-tested); this file only wires the data source.
//
// FILE NAME: this hook module is `use-mention-liveness.tsx` (hook naming
// convention) so it does NOT share a basename with the pure `mention-liveness.ts`.
// A same-basename `.ts`/`.tsx` pair makes the extensionless specifier
// `@/lib/mention-liveness` resolve to the `.ts` under `moduleResolution: bundler`,
// which would hide this hook export; the distinct name keeps both reachable and
// the pure module unit-testable without pulling React in.

import { useMemo } from "react";
import { useAgentPresence } from "@/contexts/agent-presence-context";
import {
  resolveMentionLiveness,
  type MentionLiveness,
  type MentionLivenessRef,
} from "@/lib/mention-liveness";

/**
 * Resolve a parsed mention's liveness against the current daemon connections from
 * `useAgentPresence()`. Returns the same `MentionLiveness` the pure rule yields
 * (online verdict + matched instance owner/host/cwd). Recomputes only when the
 * connections list or the ref's identity/pin changes.
 *
 * MUST be called inside an `AgentPresenceProvider` (the hook reads the presence
 * context) — the comment render site is within the shell that mounts it.
 */
export function useMentionLiveness(ref: MentionLivenessRef): MentionLiveness {
  const { connections } = useAgentPresence();
  // Destructure the ref's identity/pin fields so the memo depends on the VALUES
  // (not the ref object, which churns per render from a fresh parse) — keeping the
  // verdict stable across re-parses while satisfying exhaustive-deps. A fresh
  // MentionLivenessRef is rebuilt from these so resolveMentionLiveness sees the
  // same shape (pin keys present iff this is a pinned ref).
  const { uuid, pinnedHost, pinnedCwd, runtimeCwd } = ref;
  const isPinned = "pinnedHost" in ref || "pinnedCwd" in ref;
  return useMemo(() => {
    const stableRef: MentionLivenessRef = isPinned
      ? { uuid, pinnedHost, pinnedCwd, runtimeCwd }
      : { uuid };
    return resolveMentionLiveness(stableRef, connections);
  }, [connections, uuid, pinnedHost, pinnedCwd, runtimeCwd, isPinned]);
}
