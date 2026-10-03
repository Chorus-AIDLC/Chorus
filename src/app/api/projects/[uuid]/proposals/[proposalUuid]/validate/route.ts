// src/app/api/projects/[uuid]/proposals/[proposalUuid]/validate/route.ts
// Proposal Validation API - Run validation checks on a proposal

import { NextRequest } from "next/server";
import { withErrorHandler } from "@/lib/api-handler";
import { success, errors } from "@/lib/api-response";
import { getAuthContext, checkAgentPermission } from "@/lib/auth";
import { validateProposal } from "@/services/proposal.service";
import {
  requireProjectAccess,
  requireProposalInputsAccess,
  resolveEntityProjectUuid,
} from "@/services/project-access.service";

type RouteContext = { params: Promise<{ uuid: string; proposalUuid: string }> };

// GET /api/projects/[uuid]/proposals/[proposalUuid]/validate
export const GET = withErrorHandler<{ uuid: string; proposalUuid: string }>(
  async (request: NextRequest, context: RouteContext) => {
    const auth = await getAuthContext(request);
    if (!auth) {
      return errors.unauthorized();
    }
    const denied = checkAgentPermission(auth, "proposal:read");
    if (denied) return denied;

    const { uuid: projectUuid, proposalUuid } = await context.params;

    // Project access first (404 when not visible), then the proposal must
    // belong to the path project — never validate a proposal from elsewhere.
    await requireProjectAccess(auth, projectUuid, "viewer");
    const proposalProjectUuid = await resolveEntityProjectUuid(
      auth.companyUuid,
      "proposal",
      proposalUuid,
    );
    if (proposalProjectUuid !== projectUuid) {
      return errors.notFound("Proposal");
    }

    // Stored inputs are re-checked on every read: one that became hidden since
    // creation must not leak its title/status through the E5 issue.
    await requireProposalInputsAccess(auth, proposalUuid);

    const result = await validateProposal(auth.companyUuid, proposalUuid);
    return success(result);
  }
);
