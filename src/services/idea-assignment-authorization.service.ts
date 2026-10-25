import { createHash, randomUUID } from "node:crypto";
import { ApiError } from "@/lib/api-handler";
import { computeEffectivePermissions } from "@/lib/authz/permissions";
import { AlreadyClaimedError } from "@/lib/errors";
import type { AuthContext } from "@/types/auth";
import { createActivityInTx } from "./activity.service";
import { computeProjectAccess, levelAtLeast } from "./project-access.service";
import { getProjectAgentTeam, projectTeamTransaction, type ProjectTeamClient } from "./project-agent-team.service";

const digest = (value: string) => createHash("sha256").update(value).digest("hex");
function deny(message: string): never {
  throw new ApiError("FORBIDDEN", message, 403);
}

async function identity(auth: AuthContext, projectUuid: string, client: ProjectTeamClient, selfService = false) {
  let current: AuthContext;
  if (auth.type === "user") {
    const user = await client.user.findFirst({ where: { uuid: auth.actorUuid, companyUuid: auth.companyUuid, status: "active", deletedAt: null } });
    if (!user) deny("An active human identity is required");
    current = { type: "user", actorUuid: auth.actorUuid, companyUuid: auth.companyUuid };
  } else if (auth.type === "agent") {
    const agent = await client.agent.findFirst({ where: { uuid: auth.actorUuid, companyUuid: auth.companyUuid } });
    if (!agent || !computeEffectivePermissions(agent.roles, agent.permissions).has(selfService ? "idea:write" : "idea:admin")) deny("Idea assignment permission required");
    current = { type: "agent", actorUuid: agent.uuid, companyUuid: auth.companyUuid, ownerUuid: agent.ownerUuid ?? undefined };
  } else return deny("Unsupported assignment actor");
  if (!levelAtLeast((await computeProjectAccess(current, projectUuid, client)).level, "editor")) deny("Project editor access required");
  return current;
}

async function sourceComment(companyUuid: string, ideaUuid: string, agentUuid: string, commentUuid: string, client: ProjectTeamClient) {
  const comment = await client.comment.findFirst({ where: { uuid: commentUuid, companyUuid, targetType: "idea", targetUuid: ideaUuid, authorType: "user" } });
  if (!comment || comment.content.trim() !== `chorus:assign ${agentUuid}`) deny("A standalone human chorus:assign command on this Idea is required");
  return comment;
}

export interface IssueIdeaAssignmentAuthorizationInput {
  ideaUuid: string;
  agentUuid: string;
  commentUuid?: string;
  requestUuid?: string;
}

export async function issueIdeaAssignmentAuthorization(auth: AuthContext, input: IssueIdeaAssignmentAuthorizationInput) {
  return projectTeamTransaction(async (client) => {
    const idea = await client.idea.findFirst({ where: { uuid: input.ideaUuid, companyUuid: auth.companyUuid } });
    if (!idea) throw new ApiError("NOT_FOUND", "Idea not found", 404);
    const caller = await identity(auth, idea.projectUuid, client);
    const comment = input.commentUuid ? await sourceComment(auth.companyUuid, idea.uuid, input.agentUuid, input.commentUuid, client) : null;
    if (!comment && caller.type !== "user") deny("Agent assignment requires verifiable human consent");
    const humanUuid = comment?.authorUuid ?? caller.actorUuid;
    await identity({ type: "user", companyUuid: auth.companyUuid, actorUuid: humanUuid }, idea.projectUuid, client);
    const agent = await client.agent.findFirst({ where: { uuid: input.agentUuid, companyUuid: auth.companyUuid, ownerUuid: humanUuid } });
    if (!agent || (caller.type === "agent" ? caller.ownerUuid : caller.actorUuid) !== humanUuid) deny("Only the receiving agent owner can authorize its Team");
    if (comment && comment.createdAt.getTime() <= Math.max(idea.assignedAt?.getTime() ?? 0, idea.teamAssignmentChangedAt?.getTime() ?? 0)) deny("Assignment command predates the current assignment");
    const sourceType = comment ? "comment" : "confirmation";
    const sourceUuid = comment?.uuid ?? input.requestUuid ?? randomUUID();
    const sourceDigest = comment ? digest(`${comment.content}\n${comment.updatedAt.toISOString()}`) : digest(`${humanUuid}:${idea.uuid}:${agent.uuid}:${idea.teamGeneration}`);
    const previous = await client.ideaAssignmentAuthorization.findUnique({ where: { companyUuid_sourceType_sourceUuid: { companyUuid: auth.companyUuid, sourceType, sourceUuid } } });
    if (previous) {
      if (previous.ideaUuid !== idea.uuid || previous.agentUuid !== agent.uuid || previous.humanUuid !== humanUuid || previous.sourceDigest !== sourceDigest || previous.generation !== idea.teamGeneration) deny("Authorization source does not match this assignment");
      return previous;
    }
    return client.ideaAssignmentAuthorization.create({ data: {
      companyUuid: auth.companyUuid, projectUuid: idea.projectUuid, ideaUuid: idea.uuid, agentUuid: agent.uuid, humanUuid,
      generation: idea.teamGeneration, sourceType, sourceUuid, sourceDigest,
      expiresAt: new Date((comment?.createdAt.getTime() ?? Date.now()) + 24 * 60 * 60 * 1000),
    } });
  });
}

export interface AssignIdeaWithAuthorityInput {
  ideaUuid: string;
  assigneeType: "agent" | "agent_instance" | "user" | null;
  assigneeUuid: string | null;
  instanceUuid?: string | null;
  humanAuthorizationUuid?: string;
  operationUuid: string;
  cwdSource?: string | null;
  cwdHost?: string | null;
  runtimeCwd?: string | null;
  claimOnly?: boolean;
  releaseOwn?: boolean;
  pinOnly?: boolean;
  emitKickoff?: boolean;
}

export async function assignIdeaWithAuthorityInTx(auth: AuthContext, input: AssignIdeaWithAuthorityInput, client: ProjectTeamClient) {
  if (!input.operationUuid || Boolean(input.assigneeType) !== Boolean(input.assigneeUuid)) throw new ApiError("VALIDATION_ERROR", "Assignment target and operation identifier required", 400);
  if (![null, "agent", "agent_instance", "user"].includes(input.assigneeType)) throw new ApiError("VALIDATION_ERROR", "Invalid assignment type", 400);
  const fingerprint = digest(JSON.stringify([input.ideaUuid, input.assigneeType, input.assigneeUuid, input.instanceUuid ?? null, input.humanAuthorizationUuid ?? null, input.cwdSource ?? null, input.cwdHost ?? null, input.runtimeCwd ?? null, input.claimOnly ?? false, input.releaseOwn ?? false, input.pinOnly ?? false, input.emitKickoff ?? true]));
    const idea = await client.idea.findFirst({ where: { uuid: input.ideaUuid, companyUuid: auth.companyUuid } });
    if (!idea) throw new ApiError("NOT_FOUND", "Idea not found", 404);
    const actor = await identity(auth, idea.projectUuid, client, input.claimOnly || input.releaseOwn);
    const operation = await client.ideaAssignmentOperation.findUnique({ where: { uuid: input.operationUuid } });
    if (operation) {
      if (operation.companyUuid !== auth.companyUuid || operation.actorType !== actor.type || operation.actorUuid !== actor.actorUuid || operation.fingerprint !== fingerprint || operation.generation !== idea.teamGeneration) deny("Assignment operation is stale or does not match");
      return { idea, replayed: true, kickoff: false, activityUuid: operation.activityUuid, publish: null };
    }
    let assigneeType = input.assigneeType;
    let assigneeUuid = input.assigneeUuid;
    let agentUuid = assigneeType === "agent" ? assigneeUuid : null;
    if (input.instanceUuid || assigneeType === "agent_instance") {
      if (assigneeType !== "agent" && assigneeType !== "agent_instance") deny("Only agents can be instance pinned");
      const instance = await client.agentInstance.findFirst({ where: { uuid: input.instanceUuid ?? assigneeUuid!, companyUuid: auth.companyUuid } });
      if (!instance || (agentUuid && agentUuid !== instance.agentUuid) || (assigneeType === "agent_instance" && input.instanceUuid && input.instanceUuid !== assigneeUuid)) deny("Instance does not belong to the selected agent");
      agentUuid = instance.agentUuid;
      assigneeType = "agent_instance";
      assigneeUuid = instance.uuid;
    }
    const agent = agentUuid ? await client.agent.findFirst({ where: { uuid: agentUuid, companyUuid: auth.companyUuid } }) : null;
    if (agentUuid && !agent) deny("Agent not found");
    if (assigneeType === "user" && !await client.user.findFirst({ where: { uuid: assigneeUuid!, companyUuid: auth.companyUuid, status: "active", deletedAt: null } })) deny("User not found");
    if (assigneeUuid) {
      const target: AuthContext = agent ? { type: "agent", companyUuid: auth.companyUuid, actorUuid: agent.uuid, ownerUuid: agent.ownerUuid ?? undefined } : { type: "user", companyUuid: auth.companyUuid, actorUuid: assigneeUuid };
      if (!levelAtLeast((await computeProjectAccess(target, idea.projectUuid, client)).level, "editor")) deny("Assignee project editor access required");
    }
    const previousAgentUuid = idea.assigneeType === "agent" ? idea.assigneeUuid : idea.assigneeType === "agent_instance"
      ? (await client.agentInstance.findFirst({ where: { uuid: idea.assigneeUuid!, companyUuid: auth.companyUuid }, select: { agentUuid: true } }))?.agentUuid : null;
    if (input.claimOnly && idea.assigneeUuid) throw new AlreadyClaimedError("Idea");
    if (input.claimOnly && actor.type === "agent" && agentUuid !== actor.actorUuid) deny("Self-claim must target the caller");
    if (input.releaseOwn && (assigneeUuid !== null || actor.type !== "agent" || previousAgentUuid !== actor.actorUuid)) deny("Only the assignee can release its Idea");
    if (input.pinOnly && (!agentUuid || agentUuid !== previousAgentUuid)) deny("Runtime repinning cannot change the responsible agent");
    if (input.humanAuthorizationUuid && (input.claimOnly || input.releaseOwn || input.pinOnly)) deny("Assignment proof requires an explicit assignment");
    let humanUuid = actor.type === "user" && !input.pinOnly ? actor.actorUuid : null;
    if (input.humanAuthorizationUuid) {
      const proof = await client.ideaAssignmentAuthorization.findFirst({ where: { uuid: input.humanAuthorizationUuid, companyUuid: auth.companyUuid, projectUuid: idea.projectUuid, ideaUuid: idea.uuid } });
      if (!proof || proof.agentUuid !== agentUuid || proof.generation !== idea.teamGeneration || proof.consumedOperationUuid || proof.expiresAt.getTime() <= Date.now()) deny("Assignment authorization is invalid, stale or consumed");
      if (actor.type === "agent" && actor.ownerUuid !== proof.humanUuid) deny("Assignment proof is private to its human owner");
      if (actor.type === "user" && actor.actorUuid !== proof.humanUuid) deny("Assignment proof belongs to another human");
      await identity({ type: "user", companyUuid: auth.companyUuid, actorUuid: proof.humanUuid }, idea.projectUuid, client);
      if (!agent || agent.ownerUuid !== proof.humanUuid) deny("Receiving agent ownership changed");
      if (proof.sourceType === "comment") {
        const comment = await sourceComment(auth.companyUuid, idea.uuid, agent.uuid, proof.sourceUuid, client);
        if (comment.authorUuid !== proof.humanUuid || digest(`${comment.content}\n${comment.updatedAt.toISOString()}`) !== proof.sourceDigest) deny("Human assignment source was changed");
      } else if (proof.sourceType !== "confirmation") deny("Unknown assignment authority source");
      humanUuid = proof.humanUuid;
      const used = await client.ideaAssignmentAuthorization.updateMany({ where: { uuid: proof.uuid, consumedOperationUuid: null }, data: { consumedOperationUuid: input.operationUuid } });
      if (used.count !== 1) deny("Assignment authorization was already consumed");
    }
    const changed = agentUuid && previousAgentUuid ? agentUuid !== previousAgentUuid : idea.assigneeType !== assigneeType || idea.assigneeUuid !== assigneeUuid;
    const authorized = humanUuid !== null;
    const generation = idea.teamGeneration + (authorized || changed ? 1 : 0);
    const now = new Date();
    const basicEligibility = humanUuid !== null && agent && agent.ownerUuid === humanUuid && computeEffectivePermissions(agent.roles, agent.permissions).has("idea:write");
    const team = basicEligibility ? await getProjectAgentTeam({ type: "user", actorUuid: humanUuid!, companyUuid: auth.companyUuid }, idea.projectUuid, client) : null;
    const enroll = Boolean(basicEligibility && team);
    const clearing = authorized && !enroll;
    const updated = await client.idea.update({ where: { uuid: idea.uuid, companyUuid: auth.companyUuid, teamGeneration: idea.teamGeneration }, data: {
      assigneeType, assigneeUuid, assignedAt: assigneeUuid ? authorized || changed ? now : idea.assignedAt : null,
      assignedByType: input.pinOnly ? idea.assignedByType : assigneeUuid ? actor.type : null, assignedByUuid: input.pinOnly ? idea.assignedByUuid : assigneeUuid ? actor.actorUuid : null,
      status: !assigneeUuid && idea.status !== "elaborated" ? "open" : assigneeUuid && idea.status === "open" ? "elaborating" : idea.status,
      // Release resets an unfinished elaboration, as before, so the next claimant starts clean.
      ...(!assigneeUuid && idea.status !== "elaborated" ? { elaborationDepth: null, elaborationStatus: null } : {}),
      cwdSource: input.runtimeCwd ? input.cwdSource ?? null : null, cwdHost: input.runtimeCwd ? input.cwdHost ?? null : null, runtimeCwd: input.runtimeCwd ?? null,
      teamGeneration: generation,
      ...(authorized || changed ? { teamAssignmentChangedAt: now } : {}),
      ...(enroll ? { teamEnrollmentVersion: 1, teamOwnerUuid: humanUuid, teamLeadAgentUuid: agentUuid, teamEnrolledByUuid: humanUuid, teamEnrolledAt: now } : {}),
      ...(clearing ? { teamEnrollmentVersion: 1, teamOwnerUuid: null, teamLeadAgentUuid: null, teamEnrolledByUuid: null, teamEnrolledAt: null } : {}),
      ...(!authorized && changed && (idea.teamOwnerUuid || idea.teamLeadAgentUuid) ? { teamEnrollmentVersion: 1, teamEnrolledByUuid: null, teamEnrolledAt: null } : {}),
      ...(authorized || changed ? { teamProductAgentUuid: null } : {}),
    } });
    const proposals = await client.proposal.findMany({ where: { companyUuid: auth.companyUuid, projectUuid: idea.projectUuid, inputType: "idea", inputUuids: { array_contains: [idea.uuid] } }, select: { uuid: true, status: true } });
    const taskStates = proposals.length ? await client.task.findMany({ where: { companyUuid: auth.companyUuid, proposalUuid: { in: proposals.map((proposal) => proposal.uuid) } }, select: { status: true } }) : [];
    const done = taskStates.length > 0 && taskStates.every((task) => task.status === "done" || task.status === "closed") && proposals.every((proposal) => proposal.status === "approved" || proposal.status === "closed");
    // Team enrollment needs owner consent, but any real assignment keeps the legacy wake/notify:
    // the woken agent re-reads Team context and stays fenced when it is not the enrolled orchestrator.
    const kickoff = Boolean(assigneeUuid) && !input.pinOnly && (authorized || changed) && !done && input.emitKickoff !== false;
    const audit = await createActivityInTx(client, { companyUuid: auth.companyUuid, projectUuid: idea.projectUuid, targetType: "idea", targetUuid: idea.uuid,
      actorType: actor.type, actorUuid: actor.actorUuid, action: kickoff ? "assigned" : "assignment_recorded",
      value: { assigneeType: agentUuid ? "agent" : assigneeType, assigneeUuid: agentUuid ?? assigneeUuid, humanAuthorizerUuid: humanUuid, teamGeneration: generation, teamEnrollmentVersion: updated.teamEnrollmentVersion,
        ...(assigneeType === "agent_instance" ? { instanceUuid: assigneeUuid } : {}),
        ...(input.runtimeCwd ? { resolvedCwdSource: input.cwdSource, resolvedCwdHost: input.cwdHost, resolvedRuntimeCwd: input.runtimeCwd } : {}),
      },
    });
    await client.ideaAssignmentOperation.create({ data: { uuid: input.operationUuid, companyUuid: auth.companyUuid, ideaUuid: idea.uuid, actorType: actor.type, actorUuid: actor.actorUuid, fingerprint, generation, activityUuid: audit.activity.uuid } });
    return { idea: updated, replayed: false, kickoff, activityUuid: audit.activity.uuid, publish: audit.publish };
}

export async function assignIdeaWithAuthority(auth: AuthContext, input: AssignIdeaWithAuthorityInput) {
  const committed = await projectTeamTransaction((client) => assignIdeaWithAuthorityInTx(auth, input, client));
  committed.publish?.();
  return { idea: committed.idea, replayed: committed.replayed, kickoff: committed.kickoff, activityUuid: committed.activityUuid };
}
