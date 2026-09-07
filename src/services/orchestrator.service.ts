import { prisma } from "@/lib/prisma";
import {
  resolveAssignmentActor,
  type AssignmentActorInfo,
} from "@/lib/uuid-resolver";
import { listConnectionsForAgent } from "@/services/daemon-connection.service";

export type OrchestratorAttribution = AssignmentActorInfo & { type: "agent" };

/**
 * The waker's live session anchor (wake-carry-waker-session-anchor, T1). A derived,
 * NEVER-persisted pointer telling a woken peer WHERE the waking agent's live conversation
 * is, so a reply on this resource lands back in the waker's existing idea-anchored session
 * instead of scattering into a new one.
 *
 * It is a SIBLING of `OrchestratorAttribution`, not a sub-field: `orchestrator` is
 * ASSIGNMENT-scoped (the resource's `assignedBy*` provenance), whereas this anchor is
 * ACTOR-scoped (the wake's agent actor). Either, both, or neither may be present on a wake,
 * and they may identify different agents.
 *
 *  - `agentUuid` — the waking agent (= the notification's `actorUuid`).
 *  - `agentName` — the waking agent's current display name (= the notification's `actorName`;
 *    sourced here from the live connection registry so the resolver stays self-contained).
 *  - `ideaUuid` — the idea whose session a reply reaches (`DaemonSession.sessionId`).
 */
export interface WakerSessionAnchor {
  agentUuid: string;
  agentName: string;
  ideaUuid: string;
}

/**
 * Resolve the waker's live session anchor for an idea-anchored wake — modeled on
 * `resolveIdeaSessionOriginTarget` (notification-turn.ts): find the waking agent's
 * `DaemonSession` whose business key is the idea (`sessionId === ideaUuid`), and confirm its
 * `originConnectionUuid` maps to a connection whose `effectiveStatus === "online"`. The anchor
 * is returned ONLY when that origin is currently online (the reply has a live place to land);
 * a missing session or an offline origin yields null (notify-only — the accepted V1 boundary).
 *
 * DISCIPLINE (spec `agent-orchestrator-handoff`): resolution reads ONLY the passed idea anchor
 * — the caller supplies the resource's OWN direct idea (an idea entity is its own anchor; a
 * task's anchor is its direct `ideaUuid`). This helper never traverses parent/container idea
 * ancestry, proposals, or documents.
 *
 * Cost: at most one `DaemonSession` lookup plus one connection-registry read per distinct
 * `(agentUuid, ideaUuid)` — the caller batches by that pair, mirroring the orchestrator map.
 * `agentName` is taken from the matched online connection's joined `agentName` (no extra
 * query); it is the same `Agent.name` the notification denormalized as `actorName`.
 */
export async function resolveWakerSessionAnchor(
  companyUuid: string,
  agentUuid: string,
  ideaUuid: string,
): Promise<WakerSessionAnchor | null> {
  const session = await prisma.daemonSession.findFirst({
    where: { companyUuid, agentUuid, sessionId: ideaUuid },
    select: { originConnectionUuid: true },
  });
  if (!session) return null;

  const connections = await listConnectionsForAgent(companyUuid, agentUuid);
  const origin = connections.find(
    (c) =>
      c.uuid === session.originConnectionUuid && c.effectiveStatus === "online",
  );
  if (!origin) return null;

  return { agentUuid, agentName: origin.agentName ?? "", ideaUuid };
}

/**
 * Resolve the latest explicit agent assigner for the directly addressed resource.
 * This intentionally performs no parent, proposal, or Idea-lineage traversal.
 */
export async function resolveResourceOrchestrator(
  companyUuid: string,
  entityType: string,
  entityUuid: string,
): Promise<OrchestratorAttribution | null> {
  let provenance: {
    assignedByType: string | null;
    assignedByUuid: string | null;
  } | null = null;

  if (entityType === "idea") {
    provenance = await prisma.idea.findFirst({
      where: { uuid: entityUuid, companyUuid },
      select: { assignedByType: true, assignedByUuid: true },
    });
  } else if (entityType === "task") {
    provenance = await prisma.task.findFirst({
      where: { uuid: entityUuid, companyUuid },
      select: { assignedByType: true, assignedByUuid: true },
    });
  } else {
    return null;
  }

  if (!provenance?.assignedByUuid || provenance.assignedByType === "user") {
    return null;
  }

  const actor = await resolveAssignmentActor(
    companyUuid,
    provenance.assignedByType,
    provenance.assignedByUuid,
  );
  return actor?.type === "agent"
    ? { type: "agent", uuid: actor.uuid, name: actor.name }
    : null;
}
