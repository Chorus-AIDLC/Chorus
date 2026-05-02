// src/app/api/projects/[uuid]/proposals/[proposalUuid]/validate/route.ts
// Proposal Validation API - Run validation checks on a proposal

import { NextRequest } from "next/server";
import { withErrorHandler } from "@/lib/api-handler";
import { success, errors } from "@/lib/api-response";
import { getAuthContext, checkAgentPermission } from "@/lib/auth";
import { validateProposal } from "@/services/proposal.service";

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

    const { proposalUuid } = await context.params;
    const result = await validateProposal(auth.companyUuid, proposalUuid);
    return success(result);
  }
);
