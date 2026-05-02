// src/app/api/proposals/[uuid]/approve/route.ts
// Proposals API - Approve (ARCHITECTURE.md §7.4)
// UUID-Based Architecture: All operations use UUIDs

import { NextRequest } from "next/server";
import { withErrorHandler, parseBody } from "@/lib/api-handler";
import { success, errors } from "@/lib/api-response";
import { getAuthContext, isUser, isAgent, hasPermission } from "@/lib/auth";
import { getProposalByUuid, approveProposal } from "@/services/proposal.service";
import { createActivity } from "@/services/activity.service";

type RouteContext = { params: Promise<{ uuid: string }> };

// POST /api/proposals/[uuid]/approve - Approve Proposal
export const POST = withErrorHandler<{ uuid: string }>(
  async (request: NextRequest, context: RouteContext) => {
    const auth = await getAuthContext(request);
    if (!auth) {
      return errors.unauthorized();
    }

    // Approval requires proposal:admin for agents, or a human user
    if (isAgent(auth)) {
      if (!hasPermission(auth, "proposal:admin")) {
        return errors.forbidden("Missing permission: proposal:admin");
      }
    } else if (!isUser(auth)) {
      return errors.forbidden("Only users or admin agents can approve proposals");
    }

    const { uuid } = await context.params;

    const proposal = await getProposalByUuid(auth.companyUuid, uuid);
    if (!proposal) {
      return errors.notFound("Proposal");
    }

    // Only pending Proposals can be approved
    if (proposal.status !== "pending") {
      return errors.badRequest("Can only approve pending proposals");
    }

    const body = await parseBody<{
      reviewNote?: string;
    }>(request);

    const updated = await approveProposal(
      proposal.uuid,
      auth.companyUuid,
      auth.actorUuid,
      body.reviewNote
    );

    await createActivity({
      companyUuid: auth.companyUuid,
      projectUuid: proposal.projectUuid,
      targetType: "proposal",
      targetUuid: proposal.uuid,
      actorType: auth.type,
      actorUuid: auth.actorUuid,
      action: "approved",
      value: body.reviewNote ? { reviewNote: body.reviewNote } : undefined,
    });

    return success(updated);
  }
);
