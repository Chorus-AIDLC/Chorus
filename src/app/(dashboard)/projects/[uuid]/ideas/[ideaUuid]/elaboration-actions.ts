"use server";

import { revalidatePath } from "next/cache";
import { getServerAuthContext } from "@/lib/auth-server";
import {
  getElaboration,
  answerElaboration,
  skipElaboration,
} from "@/services/elaboration.service";
import { prisma } from "@/lib/prisma";
import type {
  ElaborationResponse,
  AnswerInput,
  ElaborationRoundResponse,
} from "@/types/elaboration";
import logger from "@/lib/logger";

export async function getElaborationAction(
  ideaUuid: string
): Promise<{ success: boolean; data?: ElaborationResponse; error?: string }> {
  const auth = await getServerAuthContext();
  if (!auth) {
    return { success: false, error: "Unauthorized" };
  }

  try {
    const data = await getElaboration({
      companyUuid: auth.companyUuid,
      ideaUuid,
    });
    return { success: true, data };
  } catch (error) {
    logger.error({ err: error }, "Failed to get elaboration");
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to get elaboration",
    };
  }
}

export async function submitElaborationAnswersAction(
  ideaUuid: string,
  roundUuid: string,
  answers: AnswerInput[]
): Promise<{ success: boolean; data?: ElaborationRoundResponse; error?: string }> {
  const auth = await getServerAuthContext();
  if (!auth) {
    return { success: false, error: "Unauthorized" };
  }

  try {
    const data = await answerElaboration({
      companyUuid: auth.companyUuid,
      ideaUuid,
      roundUuid,
      actorUuid: auth.actorUuid,
      actorType: auth.type,
      answers,
    });

    // Revalidate the ideas page so the panel refreshes
    const idea = await prisma.idea.findFirst({ where: { uuid: ideaUuid, companyUuid: auth.companyUuid } });
    if (idea) {
      revalidatePath(`/projects/${idea.projectUuid}/ideas/${ideaUuid}`);
      revalidatePath(`/projects/${idea.projectUuid}/ideas`);
    }

    return { success: true, data };
  } catch (error) {
    logger.error({ err: error }, "Failed to submit elaboration answers");
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to submit answers",
    };
  }
}

export async function skipElaborationAction(
  ideaUuid: string,
  reason: string
): Promise<{ success: boolean; error?: string }> {
  const auth = await getServerAuthContext();
  if (!auth) {
    return { success: false, error: "Unauthorized" };
  }

  try {
    await skipElaboration({
      companyUuid: auth.companyUuid,
      ideaUuid,
      actorUuid: auth.actorUuid,
      actorType: auth.type,
      reason,
    });

    // Revalidate the ideas page so the panel refreshes
    const idea = await prisma.idea.findFirst({ where: { uuid: ideaUuid, companyUuid: auth.companyUuid } });
    if (idea) {
      revalidatePath(`/projects/${idea.projectUuid}/ideas/${ideaUuid}`);
      revalidatePath(`/projects/${idea.projectUuid}/ideas`);
    }

    return { success: true };
  } catch (error) {
    logger.error({ err: error }, "Failed to skip elaboration");
    return {
      success: false,
      error: error instanceof Error ? error.message : "Failed to skip elaboration",
    };
  }
}
