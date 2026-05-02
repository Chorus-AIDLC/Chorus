// src/app/api/proposals/[uuid]/close/route.ts
// Proposals API - Close Proposal (terminal state)
// UUID-Based Architecture: All operations use UUIDs

import { NextRequest } from "next/server";
import { withErrorHandler, parseBody } from "@/lib/api-handler";
import { success, errors } from "@/lib/api-response";
import { getAuthContext, isUser, isAgent, hasPermission } from "@/lib/auth";
import { getProposalByUuid, closeProposal } from "@/services/proposal.service";

type RouteContext = { params: Promise<{ uuid: string }> };

// POST /api/proposals/[uuid]/close - Close Proposal
export const POST = withErrorHandler<{ uuid: string }>(
  async (request: NextRequest, context: RouteContext) => {
    const auth = await getAuthContext(request);
    if (!auth) {
      return errors.unauthorized();
    }

    // Close requires proposal:admin for agents, or a human user
    if (isAgent(auth)) {
      if (!hasPermission(auth, "proposal:admin")) {
        return errors.forbidden("Missing permission: proposal:admin");
      }
    } else if (!isUser(auth)) {
      return errors.forbidden("Only users or admin agents can close proposals");
    }

    const { uuid } = await context.params;

    const proposal = await getProposalByUuid(auth.companyUuid, uuid);
    if (!proposal) {
      return errors.notFound("Proposal");
    }

    // Only pending Proposals can be closed
    if (proposal.status !== "pending") {
      return errors.badRequest("Can only close pending proposals");
    }

    const body = await parseBody<{
      reviewNote?: string;
    }>(request);

    // A reason must be provided when closing
    if (!body.reviewNote || body.reviewNote.trim() === "") {
      return errors.validationError({
        reviewNote: "Review note is required when closing",
      });
    }

    const updated = await closeProposal(
      proposal.uuid,
      auth.actorUuid,
      body.reviewNote.trim()
    );

    return success(updated);
  }
);
