// src/app/api/proposals/[uuid]/reject/route.ts
// Proposals API - Reject Proposal (ARCHITECTURE.md §7.4)
// UUID-Based Architecture: All operations use UUIDs

import { NextRequest } from "next/server";
import { withErrorHandler, parseBody } from "@/lib/api-handler";
import { success, errors } from "@/lib/api-response";
import { getAuthContext, isUser, isAgent, hasPermission } from "@/lib/auth";
import { getProposalByUuid, rejectProposal } from "@/services/proposal.service";
import { createActivity } from "@/services/activity.service";

type RouteContext = { params: Promise<{ uuid: string }> };

// POST /api/proposals/[uuid]/reject - Reject Proposal
export const POST = withErrorHandler<{ uuid: string }>(
  async (request: NextRequest, context: RouteContext) => {
    const auth = await getAuthContext(request);
    if (!auth) {
      return errors.unauthorized();
    }

    // Reject requires proposal:write for agents, or a human user
    if (isAgent(auth)) {
      if (!hasPermission(auth, "proposal:write")) {
        return errors.forbidden("Missing permission: proposal:write");
      }
    } else if (!isUser(auth)) {
      return errors.forbidden("Only users or permitted agents can reject proposals");
    }

    const { uuid } = await context.params;

    const proposal = await getProposalByUuid(auth.companyUuid, uuid);
    if (!proposal) {
      return errors.notFound("Proposal");
    }

    // Only pending Proposals can be rejected
    if (proposal.status !== "pending") {
      return errors.badRequest("Can only reject pending proposals");
    }

    const body = await parseBody<{
      reviewNote?: string;
    }>(request);

    // A reason must be provided when rejecting
    if (!body.reviewNote || body.reviewNote.trim() === "") {
      return errors.validationError({
        reviewNote: "Review note is required when rejecting",
      });
    }

    const updated = await rejectProposal(
      proposal.uuid,
      auth.actorUuid,
      body.reviewNote.trim()
    );

    await createActivity({
      companyUuid: auth.companyUuid,
      projectUuid: proposal.projectUuid,
      targetType: "proposal",
      targetUuid: proposal.uuid,
      actorType: auth.type,
      actorUuid: auth.actorUuid,
      action: "rejected_to_draft",
      value: { reviewNote: body.reviewNote.trim() },
    });

    return success(updated);
  }
);
