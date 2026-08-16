import { prisma } from "@/lib/prisma";
import {
  resolveAssignmentActor,
  type AssignmentActorInfo,
} from "@/lib/uuid-resolver";

export type OrchestratorAttribution = AssignmentActorInfo & { type: "agent" };

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
