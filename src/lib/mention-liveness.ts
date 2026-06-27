// Pure mention-liveness resolution — the single matching rule the comment
// mention badge uses to turn a parsed mention + the current daemon connections
// into an online verdict (and, when online, the owning instance's identity).
//
// It is intentionally REACT-FREE so it can be unit-tested with plain fixtures;
// the `useMentionLiveness(ref)` hook (use-mention-liveness.tsx) just feeds it
// `useAgentPresence().connections`. The rule mirrors the Tech Design's "Liveness
// resolution" section EXACTLY:
//   - pinned mention    → instance-precise: online iff a connection matches
//                         (agentUuid, host, cwd) AND is effectiveStatus "online".
//   - non-pinned mention → agent-overall: online iff ANY connection for the agent
//                         is effectiveStatus "online".
// "Online" is never re-derived here — it reads the server's `effectiveStatus`
// verdict verbatim (the same source the presence count uses).

import type { ConnectionView } from "@/components/agent-presence/types";

/**
 * The minimal parsed-mention shape this rule needs — a structural subset of
 * `MentionRef` (src/services/mention.service.ts) / `ParsedMentionRef`
 * (mention-renderer.tsx): the agent `uuid` plus the optional pinned-instance
 * `(pinnedHost, pinnedCwd)`. A mention is treated as PINNED iff either pin key is
 * present (even with a null value — `pinnedHost: ""` is the unknown-host pin and
 * `pinnedCwd: null` is the unknown-path pin), matching how the parser attaches
 * the keys only for a pinned token.
 */
export interface MentionLivenessRef {
  uuid: string;
  pinnedHost?: string | null;
  pinnedCwd?: string | null;
}

/**
 * Result of resolving a mention against the current connections.
 *  - `online`      — the verdict (instance-precise for a pinned mention, agent-
 *                    overall for a non-pinned one).
 *  - `ownerUuid`   — the matched connection's owner for a pinned-online mention;
 *                    for a non-pinned mention, the owner of the connection that
 *                    satisfied the online check (or, when offline, any connection
 *                    for that agent if one exists). null when no connection at
 *                    all is known for the agent. Used by the owner gate.
 *  - `host`/`cwd`  — the matched instance's place, present ONLY for a pinned
 *                    mention that resolved to a specific connection (online OR
 *                    the pinned place with a known connection); null for a
 *                    non-pinned mention (no single instance) or when no pinned
 *                    connection exists.
 */
export interface MentionLiveness {
  pinned: boolean;
  online: boolean;
  ownerUuid: string | null;
  host: string | null;
  cwd: string | null;
}

/** A mention is pinned iff either pin key is present on the ref. */
export function isPinnedRef(ref: MentionLivenessRef): boolean {
  return ref.pinnedHost !== undefined || ref.pinnedCwd !== undefined;
}

/**
 * Resolve a parsed mention's liveness against the current daemon connections.
 * Pure: no side effects, safe to call in render/test.
 *
 * Pinned: find the connection for the exact `(agentUuid, host, cwd)` place
 * (`host === pinnedHost && cwd === pinnedCwd`). The mention is online iff that
 * connection exists AND its `effectiveStatus === "online"`. The matched
 * connection's `ownerUuid`/`host`/`cwd` are surfaced so the popover can render
 * the instance and gate the owner-only action. A pinned mention whose place has
 * NO connection at all → offline, with `host`/`cwd` echoed from the ref (the
 * place is still meaningful for display) and `ownerUuid` resolved from any
 * connection of that agent if one is known.
 *
 * Non-pinned: online iff ANY connection for `agentUuid` is `effectiveStatus
 * "online"`. `host`/`cwd` are null (no single instance). `ownerUuid` is taken
 * from an online connection when online, else from any connection of the agent.
 */
export function resolveMentionLiveness(
  ref: MentionLivenessRef,
  connections: ConnectionView[],
): MentionLiveness {
  const pinned = isPinnedRef(ref);
  const agentConnections = connections.filter((c) => c.agentUuid === ref.uuid);

  if (pinned) {
    const pinnedHost = ref.pinnedHost ?? null;
    const pinnedCwd = ref.pinnedCwd ?? null;
    // The exact (host, cwd) place. host is "" for an unknown-host pin and cwd is
    // null for an unknown-path pin — strict equality handles both since the
    // connection projection uses the same sentinels (host: "", cwd: null).
    const match = agentConnections.find(
      (c) => c.host === pinnedHost && c.cwd === pinnedCwd,
    );
    if (match) {
      return {
        pinned: true,
        online: match.effectiveStatus === "online",
        ownerUuid: match.ownerUuid,
        host: match.host,
        cwd: match.cwd,
      };
    }
    // No connection for this exact place → offline. Echo the ref's place for
    // display; borrow ownerUuid from any known connection of the agent.
    return {
      pinned: true,
      online: false,
      ownerUuid: agentConnections[0]?.ownerUuid ?? null,
      host: pinnedHost,
      cwd: pinnedCwd,
    };
  }

  // Non-pinned: agent-overall liveness. Prefer an online connection's owner so
  // the owner gate reads from a live row when the agent is online.
  const onlineConn = agentConnections.find(
    (c) => c.effectiveStatus === "online",
  );
  return {
    pinned: false,
    online: onlineConn !== undefined,
    ownerUuid: (onlineConn ?? agentConnections[0])?.ownerUuid ?? null,
    host: null,
    cwd: null,
  };
}
