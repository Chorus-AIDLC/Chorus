// src/app/api/proposals/[uuid]/revoke/route.ts
// Proposals API - Revoke (reverse an approved Proposal)
// UUID-Based Architecture: All operations use UUIDs

import { NextRequest } from "next/server";
import { withErrorHandler, parseBody } from "@/lib/api-handler";
import { success, errors } from "@/lib/api-response";
import { getAuthContext, isUser } from "@/lib/auth";
import { getProposalByUuid, revokeProposal } from "@/services/proposal.service";
import { createActivity } from "@/services/activity.service";

type RouteContext = { params: Promise<{ uuid: string }> };

// POST /api/proposals/[uuid]/revoke - Revoke an approved Proposal
export const POST = withErrorHandler<{ uuid: string }>(
  async (request: NextRequest, context: RouteContext) => {
    const auth = await getAuthContext(request);
    if (!auth) {
      return errors.unauthorized();
    }

    // Only users can revoke
    if (!isUser(auth)) {
      return errors.forbidden("Only users can revoke proposals");
    }

    const { uuid } = await context.params;

    const proposal = await getProposalByUuid(auth.companyUuid, uuid);
    if (!proposal) {
      return errors.notFound("Proposal");
    }

    // Only approved Proposals can be revoked
    if (proposal.status !== "approved") {
      return errors.badRequest("Can only revoke approved proposals");
    }

    const body = await parseBody<{
      reviewNote?: string;
    }>(request);

    const result = await revokeProposal(
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
      actorType: "user",
      actorUuid: auth.actorUuid,
      action: "revoked",
      value: {
        reviewNote: body.reviewNote,
        closedTaskCount: result.closedTasks.length,
        deletedDocumentCount: result.deletedDocuments.length,
      },
    });

    return success(result);
  }
);
