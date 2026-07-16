// src/services/wake-preview.service.ts
// Read-only wake-target preview (Part 1b — pin-cwd-before-wake).
//
// Before a wake-triggering UI action (Verify Elaborate / Start Development / Yolo /
// Proposal approve-reject) fires, the client needs to know whether to PROMPT for a
// cwd, silently PIN a cwd, or wake DIRECTLY. The connection-count part could be
// computed client-side, but the assignee → owning-agent resolution is server-side, so
// this module exposes the whole decision as a read-only, company-scoped preview — a
// pure COMPOSITION of the wake path's own primitives:
//
//   - `resolveAssigneeAgentUuid` (uuid-resolver) — the idea's assignee → owning agent
//   - `listConnectionsForAgent` (daemon-connection.service) — the agent's live registry,
//     from which we take the ONLINE subset as the picker's candidate instances
//
// The three-way outcome (owner choice B, superseding the original Tech Design D1
// session-origin short-circuit):
//
//   if assignee is `agent_instance`            → direct   (already pinned)
//   elif no online connection                  → direct   (nothing to pick; server
//                                                           handles the offline case)
//   elif exactly one online connection          → auto_pin (persist the sole cwd, no prompt)
//   else (bare agent, >=2 online)               → pick     (ALWAYS prompt + persist)
//
// WHY no session-origin short-circuit (owner choice B, live-test decision on idea
// 8380b9ad): the original D1 returned `direct` when the idea already had an ONLINE
// `DaemonSession.originConnectionUuid` (the server upgrade would target that existing
// cwd). But a conversational-entry / already-elaborated idea ALWAYS has a session-origin
// before Yolo/Start-Dev is clicked, so the picker never fired and the idea was never
// durably pinned — it just kept waking the same session cwd without ever becoming an
// `agent_instance` assignee. The owner wants a bare agent with >=2 online to ALWAYS
// prompt and PERSIST the choice (so the pinned cwd shows on the idea's assignee line),
// so this branch now always yields `pick` regardless of session-origin.
//
// READ-ONLY CONTRACT: this NEVER wakes, NEVER mutates the assignee, and NEVER emits an
// activity. It issues only reads (one idea lookup + the connection registry read).
// "Effectively online" reuses the daemon-connection registry's existing status+staleness
// rule verbatim (via the ConnectionView `effectiveStatus` the registry already derives)
// — no new threshold.

import { prisma } from "@/lib/prisma";
import { resolveAssigneeAgentUuid } from "@/lib/uuid-resolver";
import {
  listConnectionsForAgent,
  type ConnectionView,
} from "@/services/daemon-connection.service";
// Type-only import (erased at compile) of the ONE canonical selectable-instance shape,
// so the preview's `onlineInstances` are byte-compatible with what the InstancePicker
// consumes and what a subsequent non-waking reassign persists (via `agentInstanceUuid`).
import type { InstanceCandidate } from "@/components/agent-presence/instance-picker";

/**
 * The three pre-wake outcomes (owner choice B). Exactly one applies per preview:
 *  - `pick`     — bare `agent` with >=2 effectively-online connections. The client ALWAYS
 *                 prompts with `onlineInstances` and persists the choice (regardless of any
 *                 existing session-origin — see the module header for why).
 *  - `auto_pin` — bare `agent` with EXACTLY ONE effectively-online connection. The client
 *                 silently persists that sole instance, then wakes.
 *  - `direct`   — every other case (already `agent_instance`; OR zero online; OR no
 *                 assignee agent). The client wakes as-is, no prompt, no reassign.
 */
export type WakeTargetOutcome = "pick" | "auto_pin" | "direct";

/**
 * The read-only wake-target preview payload.
 *
 * `assigneeAgentUuid` is the idea's assignee resolved to its OWNING agent (an
 * `agent_instance` assignee resolves to its owning agent), or null when the idea has no
 * agent assignee (a `user` assignee, or unassigned) — in which case `outcome` is `direct`
 * and `onlineInstances` is empty (there is no agent to wake or pin).
 *
 * `onlineInstances` is the assignee agent's currently effectively-online `(host, cwd)`
 * candidate instances, each carrying its durable `agentInstanceUuid` so a subsequent pin
 * can persist it. It is the picker's candidate list for the `pick`/`auto_pin` outcomes; it
 * is still populated (harmlessly) for the `direct` already-pinned case.
 */
export interface WakeTargetPreview {
  outcome: WakeTargetOutcome;
  assigneeAgentUuid: string | null;
  onlineInstances: InstanceCandidate[];
}

/**
 * Map an ONLINE `ConnectionView` to the canonical `InstanceCandidate` the picker consumes.
 * Identical projection to the assign-modal instance actions (idea/task
 * `getAgentInstancesAction`) so the "" / null sentinels and the durable
 * `agentInstanceUuid` pointer never drift across surfaces.
 */
function toInstanceCandidate(c: ConnectionView): InstanceCandidate {
  return {
    connectionUuid: c.uuid,
    agentInstanceUuid: c.agentInstanceUuid,
    host: c.host,
    cwd: c.cwd,
    effectiveStatus: c.effectiveStatus,
  };
}

/**
 * Compute the read-only wake-target preview for an Idea, company-scoped.
 *
 * Returns null when the idea does not exist in `companyUuid` (the route maps this to a
 * 404 — the same not-found path a cross-company idea takes, so tenant isolation is a
 * plain not-found, never a cross-company disclosure).
 *
 * Side-effect free: only reads (one idea lookup + the connection registry read). NEVER
 * wakes, mutates the assignee, or emits an activity.
 */
export async function previewIdeaWakeTarget(
  companyUuid: string,
  ideaUuid: string,
): Promise<WakeTargetPreview | null> {
  // (1) The idea's assignee — company-scoped. A miss is a not-found (route → 404), NOT a
  // cross-company read: an idea in another tenant simply is not returned.
  const idea = await prisma.idea.findFirst({
    where: { uuid: ideaUuid, companyUuid },
    select: { assigneeType: true, assigneeUuid: true },
  });
  if (!idea) return null;

  // Resolve the assignee to its OWNING agent (an `agent_instance` assignee → its agent).
  // Null when the idea has no agent assignee (user / unassigned): no agent to wake or pin
  // → `direct` with no candidates. The buttons that consult this are only enabled for
  // agent assignees, so this is a defensive, spec-consistent resting value.
  const assigneeAgentUuid = await resolveAssigneeAgentUuid(
    companyUuid,
    idea.assigneeType,
    idea.assigneeUuid,
  );
  if (!assigneeAgentUuid) {
    return { outcome: "direct", assigneeAgentUuid: null, onlineInstances: [] };
  }

  // Already `agent_instance`-pinned → `direct` (the pin fixes the cwd; nothing to prompt).
  // Resolved BEFORE the connection read matters, but we still surface the agent's online
  // instances for completeness (the client ignores them on `direct`).
  const alreadyPinned = idea.assigneeType === "agent_instance";

  // (2) The agent's live registry (online-first sorted; carries effectiveStatus + the
  // durable agentInstanceUuid). Take the ONLINE subset as the picker candidates —
  // "effectively online" is the registry's own verdict, not a new threshold here.
  const connections = await listConnectionsForAgent(companyUuid, assigneeAgentUuid);
  const onlineConnections = connections.filter(
    (c) => c.effectiveStatus === "online",
  );
  const onlineInstances = onlineConnections.map(toInstanceCandidate);

  // (3) The three-way decision tree (Tech Design D1), in exact priority order.
  if (alreadyPinned) {
    // Already pinned to a specific instance → wake as-is.
    return { outcome: "direct", assigneeAgentUuid, onlineInstances };
  }
  if (onlineConnections.length === 0) {
    // Nothing online to pick; the server handles the offline case at wake time.
    return { outcome: "direct", assigneeAgentUuid, onlineInstances };
  }
  if (onlineConnections.length === 1) {
    // Exactly one online cwd → silently persist it (no prompt), then wake.
    return { outcome: "auto_pin", assigneeAgentUuid, onlineInstances };
  }

  // >=2 online, bare agent → ALWAYS prompt + persist (owner choice B). We deliberately do
  // NOT short-circuit to `direct` when the idea has an online session-origin: a
  // conversational-entry / already-elaborated idea always has one before the wake button
  // is clicked, which previously suppressed the picker and left the idea un-pinned forever.
  // See the module header. The chosen cwd is persisted as an `agent_instance` assignee by
  // the client's pin-then-wake flow, so it surfaces on the idea's assignee line.
  return { outcome: "pick", assigneeAgentUuid, onlineInstances };
}
