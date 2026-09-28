"use server";

import { getServerAuthContext } from "@/lib/auth-server";
import type { SessionView } from "@/services/daemon-session.service";
import logger from "@/lib/logger";
import { getResearchEligibility } from "@/services/research-eligibility.service";
import { requestResearch, ResearchError, type ResearchErrorCode } from "@/services/research.service";
import { resolveTemporaryRuntimeCwd } from "@/services/project-agent-cwd.service";

export async function researchEligibilityAction(ideaUuid: string) {
  const auth = await getServerAuthContext();
  if (!auth || !["user", "super_admin"].includes(auth.type)) {
    return { eligible: false as const, reason: "unauthorized" as const };
  }
  return getResearchEligibility(auth.companyUuid, ideaUuid);
}

export async function researchIdeaAction(
  ideaUuid: string,
  temporary?: { agentUuid: string; validationRequestUuid: string },
  selection?: { agentUuid: string; instanceUuid?: string },
): Promise<
  { success: true; session: SessionView; sessionUuid: string; turnUuid: string; agentUuid: string } |
  { success: false; errorCode: ResearchErrorCode }
> {
  const auth = await getServerAuthContext();
  if (!auth) return { success: false, errorCode: "unauthorized" };
  if (!["user", "super_admin"].includes(auth.type)) return { success: false, errorCode: "unauthorized" };
  try {
    const temporaryCwd = temporary ? await resolveTemporaryRuntimeCwd({
      companyUuid: auth.companyUuid, userUuid: auth.actorUuid, ...temporary,
    }) : null;
    const result = await requestResearch({
      companyUuid: auth.companyUuid, actorUuid: auth.actorUuid, actorType: auth.type, ideaUuid, temporaryCwd,
      ...(temporary ? { temporaryAgentUuid: temporary.agentUuid } : {}),
      ...(selection ? { selection } : {}),
    });
    return { success: true, ...result };
  } catch (error) {
    if (error instanceof ResearchError) return { success: false, errorCode: error.code };
    logger.error({ err: error, ideaUuid }, "Research dispatch failed");
    return { success: false, errorCode: "unknown" };
  }
}
