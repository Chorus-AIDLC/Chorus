import { prisma } from "@/lib/prisma";
import { getProposalTeamIdeaUuids, resolveIdeaTeamInputs } from "./idea-team.service";

export async function requiresFencedIdeaTeamResume(companyUuid: string, connectionUuid: string, entityType: string, entityUuid: string): Promise<boolean> {
  const businessIdea = await prisma.idea.findFirst({ where: {
    companyUuid, uuid: { in: [...new Set([entityUuid, entityUuid.split("::")[0].toLowerCase()])] }, teamEnrollmentVersion: 1,
    OR: [{ teamOwnerUuid: { not: null } }, { teamLeadAgentUuid: { not: null } }],
  }, select: { uuid: true } });
  if (businessIdea) return true;
  const execution = await prisma.daemonExecution.findFirst({ where: { companyUuid, connectionUuid, entityType, entityUuid }, select: { directIdeaUuid: true } });
  const connection = await prisma.daemonConnection.findFirst({ where: { companyUuid, uuid: connectionUuid }, select: { agentUuid: true } });
  const session = connection ? await prisma.daemonSession.findFirst({ where: {
    companyUuid, agentUuid: connection.agentUuid,
    ...(entityType === "daemon_session" ? { OR: [{ uuid: entityUuid }, { sessionId: entityUuid }] } : { sessionId: execution?.directIdeaUuid ?? entityUuid }),
  }, select: { directIdeaUuid: true, sessionId: true } }) : null;
  const anchors = new Set([execution?.directIdeaUuid, session?.directIdeaUuid, session?.sessionId.split("::")[0].toLowerCase(), entityType === "idea" ? entityUuid : null].filter((uuid): uuid is string => Boolean(uuid)));
  if (entityType === "proposal") {
    for (const uuid of await getProposalTeamIdeaUuids(companyUuid, entityUuid)) anchors.add(uuid);
  } else if (entityType === "document") {
    for (const uuid of await resolveIdeaTeamInputs(companyUuid, "document", [entityUuid])) anchors.add(uuid);
  } else if (entityType === "task") {
    const task = await prisma.task.findFirst({ where: { companyUuid, uuid: entityUuid }, select: { proposalUuid: true } });
    if (task?.proposalUuid) for (const uuid of await getProposalTeamIdeaUuids(companyUuid, task.proposalUuid)) anchors.add(uuid);
  }
  if (!anchors.size) return false;
  return Boolean(await prisma.idea.findFirst({ where: {
    companyUuid, uuid: { in: [...anchors] }, teamEnrollmentVersion: 1,
    OR: [{ teamOwnerUuid: { not: null } }, { teamLeadAgentUuid: { not: null } }],
  }, select: { uuid: true } }));
}
