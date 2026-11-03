// Structured Team review requests (chorus_request_review). The ONLY way a wake is
// routed into a purpose-scoped `review:<type>:<uuid>` session: free comment text never
// switches session purpose. The server validates the request, renders the familiar
// human-readable envelope as a normal comment, and threads the review anchor to the
// named reviewer's wake alone.

import { prisma } from "@/lib/prisma";
import { formatSessionAnchor, type SessionAnchorEntityType } from "@/lib/session-anchor";
import { buildMentionMarker } from "@/lib/mention-format";
import * as commentService from "@/services/comment.service";
import * as activityService from "@/services/activity.service";
import { resolveDirectIdeaUuid } from "@/services/lineage.service";
import { resolveAssigneeAgentUuid } from "@/lib/uuid-resolver";
import { getIdeaTeamProductDelegate } from "@/services/idea-team.service";
import { filterRecipientsByProjectAccess } from "@/services/project-access.service";

export type ReviewTargetType = "task" | "proposal" | "idea";

export interface RequestReviewParams {
  companyUuid: string;
  actorUuid: string;
  targetType: ReviewTargetType;
  targetUuid: string;
  reviewerUuid: string;
  round: number;
  note?: string;
}

export class ReviewRequestError extends Error {}

const KIND: Record<ReviewTargetType, string> = { task: "task", proposal: "proposal", idea: "code" };

async function agentName(companyUuid: string, uuid: string | null): Promise<string> {
  if (!uuid) return "unknown";
  return (await prisma.agent.findFirst({ where: { uuid, companyUuid }, select: { name: true } }))?.name ?? "unknown";
}

interface ReviewTarget { projectUuid: string; title: string; assigneeType?: string | null; assigneeUuid?: string | null }

async function targetProject(companyUuid: string, targetType: ReviewTargetType, targetUuid: string): Promise<ReviewTarget | null> {
  const where = { uuid: targetUuid, companyUuid };
  const select = { projectUuid: true, title: true } as const;
  if (targetType === "task") return prisma.task.findFirst({ where, select: { ...select, assigneeType: true, assigneeUuid: true } });
  if (targetType === "proposal") return prisma.proposal.findFirst({ where, select });
  return prisma.idea.findFirst({ where, select });
}

export async function requestReview(params: RequestReviewParams) {
  const { companyUuid, actorUuid, targetType, targetUuid, reviewerUuid, round, note } = params;
  if (!Number.isInteger(round) || round < 1 || round > 3) {
    throw new ReviewRequestError("round must be an integer from 1 to 3");
  }
  if (reviewerUuid === actorUuid) {
    throw new ReviewRequestError("reviewer must be a different agent; review your own work in a fresh sub-agent instead");
  }
  const target = await targetProject(companyUuid, targetType, targetUuid);
  if (!target) throw new ReviewRequestError(`${targetType} ${targetUuid} not found`);
  const directIdeaUuid = await resolveDirectIdeaUuid(companyUuid, targetType, targetUuid);
  if (!directIdeaUuid) throw new ReviewRequestError(`${targetType} ${targetUuid} has no direct Idea; review requests need Idea lineage`);

  const reviewer = await prisma.agent.findFirst({ where: { uuid: reviewerUuid, companyUuid }, select: { uuid: true, name: true } });
  if (!reviewer) throw new ReviewRequestError(`reviewer agent ${reviewerUuid} not found`);
  const allowed = await filterRecipientsByProjectAccess(companyUuid, target.projectUuid, [{ type: "agent", uuid: reviewer.uuid }]);
  if (allowed.length === 0) throw new ReviewRequestError(`reviewer ${reviewer.name} has no access to this project`);

  // Recipients come from authoritative assignments; unresolved ones are a repair
  // problem for the caller, never a fabricated identity.
  const idea = await prisma.idea.findFirst({ where: { uuid: directIdeaUuid, companyUuid }, select: { assigneeType: true, assigneeUuid: true } });
  const orchestratorUuid = await resolveAssigneeAgentUuid(companyUuid, idea?.assigneeType ?? null, idea?.assigneeUuid ?? null);
  if (!orchestratorUuid) throw new ReviewRequestError(`Idea ${directIdeaUuid} has no agent orchestrator to receive the verdict; assign the Idea first`);
  let failUuid = orchestratorUuid;
  let failRole = "the orchestrator";
  if (targetType === "task") {
    const developer = await resolveAssigneeAgentUuid(companyUuid, target.assigneeType ?? null, target.assigneeUuid ?? null);
    if (!developer) throw new ReviewRequestError(`task ${targetUuid} has no agent developer to receive a FAIL; assign the task first`);
    failUuid = developer;
    failRole = "the task developer";
  } else if (targetType === "proposal") {
    const delegate = await getIdeaTeamProductDelegate(companyUuid, directIdeaUuid);
    if (delegate) { failUuid = delegate; failRole = "the product delegate"; }
  }
  const kind = KIND[targetType];
  const content = [
    `Team review request — ${kind}, round ${round}`,
    `Target: ${targetType} ${targetUuid} (${target.title})`,
    `Reviewer protocol: load your host's installed ${kind === "code" ? "code" : kind}-reviewer instructions`,
    `Reviewer: ${buildMentionMarker(reviewer.name, "agent", reviewer.uuid)}`,
    `Expected recipient on PASS / PASS WITH NOTES: ${await agentName(companyUuid, orchestratorUuid)} (agent ${orchestratorUuid}), the orchestrator`,
    `Expected recipient on FAIL: ${await agentName(companyUuid, failUuid)} (agent ${failUuid}), ${failRole}`,
    ...(note?.trim() ? ["", note.trim()] : []),
  ].join("\n");

  const sessionAnchorHint = formatSessionAnchor("review", targetType as SessionAnchorEntityType, targetUuid);
  const comment = await commentService.createComment({
    companyUuid, targetType, targetUuid, content, authorType: "agent", authorUuid: actorUuid,
    reviewAnchor: { agentUuid: reviewer.uuid, sessionAnchorHint },
  });
  if (!comment.reviewDelivered) {
    throw new ReviewRequestError(`request comment ${comment.uuid} was posted but reviewer ${reviewer.name} could not be notified; no review was dispatched`);
  }
  await activityService.createActivity({
    companyUuid, projectUuid: target.projectUuid, targetType, targetUuid,
    actorType: "agent", actorUuid, action: "review_requested",
    value: { kind, round, reviewerUuid: reviewer.uuid, commentUuid: comment.uuid, sessionId: sessionAnchorHint },
  });
  return { commentUuid: comment.uuid, targetType, targetUuid, reviewerUuid: reviewer.uuid, round, sessionId: sessionAnchorHint };
}
