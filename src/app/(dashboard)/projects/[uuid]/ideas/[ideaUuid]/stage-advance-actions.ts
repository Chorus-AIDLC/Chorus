"use server";

import { revalidatePath } from "next/cache";
import { getServerAuthContext } from "@/lib/auth-server";
import {
  startDevelopment,
  START_DEVELOPMENT_REASONS,
} from "@/services/start-development.service";
import { StageAdvanceError } from "@/services/stage-advance.service";
import { prisma } from "@/lib/prisma";
import logger from "@/lib/logger";

// Machine-readable failure codes surfaced to the client so each maps to a
// distinct i18n message (the raw error prose is never shown to users).
export type StartDevelopmentErrorCode =
  | "unauthorized"
  | "not_human"
  | "idea_not_found"
  | "assignee_not_agent"
  | "no_approved_proposal"
  | "no_unfinished_tasks"
  | "agent_offline"
  | "unknown";

function toErrorCode(error: unknown): StartDevelopmentErrorCode {
  if (error instanceof StageAdvanceError) {
    switch (error.code) {
      case "NOT_HUMAN":
        return "not_human";
      case "IDEA_NOT_FOUND":
        return "idea_not_found";
      case "ASSIGNEE_NOT_AGENT":
        return "assignee_not_agent";
      case "AGENT_OFFLINE":
        return "agent_offline";
      case "PRECONDITION_FAILED":
        if (error.reason === START_DEVELOPMENT_REASONS.NO_APPROVED_PROPOSAL)
          return "no_approved_proposal";
        if (error.reason === START_DEVELOPMENT_REASONS.NO_UNFINISHED_TASKS)
          return "no_unfinished_tasks";
        return "unknown";
    }
  }
  return "unknown";
}

export async function startDevelopmentAction(
  ideaUuid: string
): Promise<{ success: boolean; errorCode?: StartDevelopmentErrorCode }> {
  const auth = await getServerAuthContext();
  if (!auth) {
    return { success: false, errorCode: "unauthorized" };
  }

  // Human-only path: mirrors verifyElaborationAction. Agents drive development
  // through their own task flow, never through this button.
  if (auth.type !== "user" && auth.type !== "super_admin") {
    return { success: false, errorCode: "not_human" };
  }

  try {
    await startDevelopment({
      companyUuid: auth.companyUuid,
      ideaUuid,
      actorUuid: auth.actorUuid,
      actorType: auth.type,
    });

    // Revalidate the ideas page so the panel refreshes
    const idea = await prisma.idea.findFirst({
      where: { uuid: ideaUuid, companyUuid: auth.companyUuid },
    });
    if (idea) {
      revalidatePath(`/projects/${idea.projectUuid}/ideas/${ideaUuid}`);
      revalidatePath(`/projects/${idea.projectUuid}/ideas`);
    }

    return { success: true };
  } catch (error) {
    // Expected, user-visible rejections (offline agent, stale button state)
    // are not errors — keep them at info so error logs stay meaningful.
    if (error instanceof StageAdvanceError) {
      logger.info(
        { code: error.code, reason: error.reason, ideaUuid },
        "Start development rejected"
      );
    } else {
      logger.error({ err: error, ideaUuid }, "Failed to start development");
    }
    return { success: false, errorCode: toErrorCode(error) };
  }
}
