"use server";

import { getServerAuthContext } from "@/lib/auth-server";
import { getProposalByUuid } from "@/services/proposal.service";
import { getIdeaByUuid } from "@/services/idea.service";
import logger from "@/lib/logger";
import { denyUnlessEntityAccess } from "@/lib/project-access-action";

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
  if (await denyUnlessEntityAccess(auth, "proposal", proposalUuid, "viewer")) {
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

export interface IdeaSource {
  uuid: string;
  title: string;
}

// Source link for a Quick Task directly linked to an Idea (Task.ideaUuid).
// A missing or inaccessible idea resolves to null — the panel hides the link.
export async function getTaskIdeaSourceAction(
  ideaUuid: string
): Promise<IdeaSource | null> {
  const auth = await getServerAuthContext();
  if (!auth) {
    return null;
  }
  if (await denyUnlessEntityAccess(auth, "idea", ideaUuid, "viewer")) {
    return null;
  }

  try {
    const idea = await getIdeaByUuid(auth.companyUuid, ideaUuid);
    if (!idea) {
      return null;
    }
    return { uuid: idea.uuid, title: idea.title };
  } catch (error) {
    logger.error({ err: error }, "Failed to get task idea source");
    return null;
  }
}
