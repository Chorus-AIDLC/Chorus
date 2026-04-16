"use server";

import { getServerAuthContext } from "@/lib/auth-server";
import { getProposalByUuid } from "@/services/proposal.service";
import logger from "@/lib/logger";

export interface ProposalSource {
  uuid: string;
  title: string;
}

export async function getTaskSourceAction(
  proposalUuid: string
): Promise<ProposalSource | null> {
  const auth = await getServerAuthContext();
  if (!auth) {
    return null;
  }

  try {
    const proposal = await getProposalByUuid(auth.companyUuid, proposalUuid);
    if (!proposal) {
      return null;
    }

    return {
      uuid: proposal.uuid,
      title: proposal.title,
    };
  } catch (error) {
    logger.error({ err: error }, "Failed to get task source");
    return null;
  }
}
