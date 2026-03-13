// src/services/elaboration.service.ts
// Elaboration Service Layer — AI-DLC Stage 3 (Requirements Clarification)

import { prisma } from "@/lib/prisma";
import { eventBus } from "@/lib/event-bus";
import { activityService } from "@/services";
import {
  type QuestionInput,
  type AnswerInput,
  type ValidationIssueInput,
  type ElaborationDepth,
  type ElaborationResponse,
  type ElaborationRoundResponse,
  type ElaborationQuestionResponse,
  type QuestionOption,
} from "@/types/elaboration";

// ===== Start Elaboration =====

export async function startElaboration({
  companyUuid,
  ideaUuid,
  actorUuid,
  actorType,
  depth,
  questions,
  projectUuid,
}: {
  companyUuid: string;
  ideaUuid: string;
  actorUuid: string;
  actorType: string;
  depth: ElaborationDepth;
  questions: QuestionInput[];
  projectUuid?: string;
}): Promise<ElaborationRoundResponse> {
  // Validate questions format
  validateQuestionsFormat(questions);

  // Load idea and verify ownership + status
  const idea = await prisma.idea.findFirst({
    where: { uuid: ideaUuid, companyUuid },
  });
  if (!idea) throw new Error("Idea not found");
  if (idea.assigneeUuid !== actorUuid) {
    throw new Error("Only the assigned agent can start elaboration");
  }
  if (idea.status !== "elaborating") {
    throw new Error(
      `Cannot start elaboration from status '${idea.status}'. Idea must be in 'elaborating' status (claim it first).`
    );
  }

  // Determine round number
  const existingRounds = await prisma.elaborationRound.count({
    where: { ideaUuid, companyUuid },
  });
  const roundNumber = existingRounds + 1;

  if (roundNumber > 5) {
    throw new Error("Maximum 5 elaboration rounds per Idea");
  }

  // Create round + questions
  const created = await prisma.elaborationRound.create({
    data: {
      companyUuid,
      ideaUuid,
      roundNumber,
      status: "pending_answers",
      createdByType: actorType,
      createdByUuid: actorUuid,
      questions: {
        create: questions.map((q) => ({
          questionId: q.id,
          text: q.text,
          category: q.category,
          options: JSON.parse(JSON.stringify(q.options)),
          required: q.required ?? true,
        })),
      },
    },
  });

  // Reload with questions for response formatting
  const round = await prisma.elaborationRound.findUniqueOrThrow({
    where: { uuid: created.uuid },
    include: { questions: true },
  });

  // Update idea status + elaboration fields
  await prisma.idea.update({
    where: { uuid: ideaUuid },
    data: {
      status: "elaborating",
      elaborationDepth: depth,
      elaborationStatus: "pending_answers",
    },
  });

  // Log activity
  const resolvedProjectUuid = projectUuid || idea.projectUuid;
  await activityService.createActivity({
    companyUuid,
    projectUuid: resolvedProjectUuid,
    targetType: "idea",
    targetUuid: ideaUuid,
    actorType,
    actorUuid,
    action: "elaboration_started",
    value: { depth, questionCount: questions.length, roundNumber },
  });

  eventBus.emitChange({ companyUuid, projectUuid: resolvedProjectUuid, entityType: "idea", entityUuid: ideaUuid, action: "updated" });

  return formatRoundResponse(round);
}

// ===== Answer Elaboration =====

export async function answerElaboration({
  companyUuid,
  ideaUuid,
  roundUuid,
  actorUuid,
  actorType,
  answers,
}: {
  companyUuid: string;
  ideaUuid: string;
  roundUuid: string;
  actorUuid: string;
  actorType: string;
  answers: AnswerInput[];
}): Promise<ElaborationRoundResponse> {
  // Load round with questions
  const round = await prisma.elaborationRound.findFirst({
    where: { uuid: roundUuid, ideaUuid, companyUuid },
    include: { questions: true },
  });
  if (!round) throw new Error("Elaboration round not found");
  if (round.status !== "pending_answers") {
    throw new Error(`Round is '${round.status}', expected 'pending_answers'`);
  }

  // Apply answers to questions
  const now = new Date();
  for (const answer of answers) {
    const question = round.questions.find(
      (q) => q.questionId === answer.questionId
    );
    if (!question) {
      throw new Error(`Question '${answer.questionId}' not found in round`);
    }

    // Validate answer: either a valid option or custom text ("Other")
    if (answer.selectedOptionId !== null) {
      const options = question.options as unknown as QuestionOption[];
      const validOption = options.find(
        (o) => o.id === answer.selectedOptionId
      );
      if (!validOption) {
        throw new Error(
          `Invalid option '${answer.selectedOptionId}' for question '${answer.questionId}'`
        );
      }
    } else if (!answer.customText?.trim()) {
      // selectedOptionId is null → this is an "Other" answer, customText is required
      throw new Error(
        `Question '${answer.questionId}': custom text is required when no option is selected`
      );
    }

    await prisma.elaborationQuestion.update({
      where: { uuid: question.uuid },
      data: {
        selectedOptionId: answer.selectedOptionId,
        customText: answer.customText,
        answeredAt: now,
        answeredByType: actorType,
        answeredByUuid: actorUuid,
      },
    });
  }

  // Check if all required questions are answered
  const updatedQuestions = await prisma.elaborationQuestion.findMany({
    where: { roundUuid },
  });
  const allRequiredAnswered = updatedQuestions
    .filter((q) => q.required)
    .every((q) => q.answeredAt !== null);

  // Update round status if all answered
  if (allRequiredAnswered) {
    await prisma.elaborationRound.update({
      where: { uuid: roundUuid },
      data: { status: "answered" },
    });
    await prisma.idea.update({
      where: { uuid: ideaUuid },
      data: { elaborationStatus: "validating" },
    });
  }

  // Load idea for project UUID
  const idea = await prisma.idea.findFirst({
    where: { uuid: ideaUuid, companyUuid },
  });

  // Log activity
  await activityService.createActivity({
    companyUuid,
    projectUuid: idea!.projectUuid,
    targetType: "idea",
    targetUuid: ideaUuid,
    actorType,
    actorUuid,
    action: "elaboration_answered",
    value: {
      roundNumber: round.roundNumber,
      answeredCount: answers.length,
    },
  });

  eventBus.emitChange({ companyUuid, projectUuid: idea!.projectUuid, entityType: "idea", entityUuid: ideaUuid, action: "updated" });

  // Return updated round
  const updatedRound = await prisma.elaborationRound.findUnique({
    where: { uuid: roundUuid },
    include: { questions: true },
  });
  return formatRoundResponse(updatedRound!);
}

// ===== Validate Elaboration =====

export async function validateElaboration({
  companyUuid,
  ideaUuid,
  roundUuid,
  actorUuid,
  actorType,
  issues,
  followUpQuestions,
}: {
  companyUuid: string;
  ideaUuid: string;
  roundUuid: string;
  actorUuid: string;
  actorType: string;
  issues: ValidationIssueInput[];
  followUpQuestions?: QuestionInput[];
}): Promise<{
  validatedRound: ElaborationRoundResponse;
  followUpRound?: ElaborationRoundResponse;
}> {
  // Load round
  const round = await prisma.elaborationRound.findFirst({
    where: { uuid: roundUuid, ideaUuid, companyUuid },
    include: { questions: true },
  });
  if (!round) throw new Error("Elaboration round not found");
  if (round.status !== "answered") {
    throw new Error(`Round is '${round.status}', expected 'answered'`);
  }

  // Verify actor is the idea assignee
  const idea = await prisma.idea.findFirst({
    where: { uuid: ideaUuid, companyUuid },
  });
  if (!idea) throw new Error("Idea not found");
  if (idea.assigneeUuid !== actorUuid) {
    throw new Error("Only the assigned agent can validate elaboration");
  }

  const noIssues = issues.length === 0;

  if (noIssues) {
    // All clear — mark round as validated, elaboration as resolved
    await prisma.elaborationRound.update({
      where: { uuid: roundUuid },
      data: { status: "validated", validatedAt: new Date() },
    });
    await prisma.idea.update({
      where: { uuid: ideaUuid },
      data: { elaborationStatus: "resolved" },
    });

    await activityService.createActivity({
      companyUuid,
      projectUuid: idea.projectUuid,
      targetType: "idea",
      targetUuid: ideaUuid,
      actorType,
      actorUuid,
      action: "elaboration_resolved",
      value: {
        totalRounds: round.roundNumber,
        totalQuestions: round.questions.length,
      },
    });

    eventBus.emitChange({ companyUuid, projectUuid: idea.projectUuid, entityType: "idea", entityUuid: ideaUuid, action: "updated" });

    const updated = await prisma.elaborationRound.findUnique({
      where: { uuid: roundUuid },
      include: { questions: true },
    });
    return { validatedRound: formatRoundResponse(updated!) };
  }

  // Issues found — mark issues on questions, create follow-up round
  for (const issue of issues) {
    const question = round.questions.find(
      (q) => q.questionId === issue.questionId
    );
    if (question) {
      await prisma.elaborationQuestion.update({
        where: { uuid: question.uuid },
        data: {
          issueType: issue.type,
          issueDescription: issue.description,
        },
      });
    }
  }

  await prisma.elaborationRound.update({
    where: { uuid: roundUuid },
    data: { status: "needs_followup", validatedAt: new Date() },
  });

  let followUpRound: ElaborationRoundResponse | undefined;

  if (followUpQuestions && followUpQuestions.length > 0) {
    followUpRound = await startElaboration({
      companyUuid,
      ideaUuid,
      actorUuid,
      actorType,
      depth: (idea.elaborationDepth as ElaborationDepth) || "standard",
      questions: followUpQuestions,
      projectUuid: idea.projectUuid,
    });
  } else {
    // Just mark as needs_followup, keep elaboration pending
    await prisma.idea.update({
      where: { uuid: ideaUuid },
      data: { elaborationStatus: "pending_answers" },
    });
  }

  await activityService.createActivity({
    companyUuid,
    projectUuid: idea.projectUuid,
    targetType: "idea",
    targetUuid: ideaUuid,
    actorType,
    actorUuid,
    action: "elaboration_followup",
    value: {
      roundNumber: round.roundNumber,
      issueCount: issues.length,
      followUpQuestionCount: followUpQuestions?.length || 0,
    },
  });

  eventBus.emitChange({ companyUuid, projectUuid: idea.projectUuid, entityType: "idea", entityUuid: ideaUuid, action: "updated" });

  const updatedRound = await prisma.elaborationRound.findUnique({
    where: { uuid: roundUuid },
    include: { questions: true },
  });
  return { validatedRound: formatRoundResponse(updatedRound!), followUpRound };
}

// ===== Skip Elaboration =====

export async function skipElaboration({
  companyUuid,
  ideaUuid,
  actorUuid,
  actorType,
  reason,
}: {
  companyUuid: string;
  ideaUuid: string;
  actorUuid: string;
  actorType: string;
  reason: string;
}): Promise<void> {
  const idea = await prisma.idea.findFirst({
    where: { uuid: ideaUuid, companyUuid },
  });
  if (!idea) throw new Error("Idea not found");
  if (idea.assigneeUuid !== actorUuid) {
    throw new Error("Only the assigned agent can skip elaboration");
  }
  if (idea.status !== "elaborating") {
    throw new Error(
      `Cannot skip elaboration from status '${idea.status}'`
    );
  }

  await prisma.idea.update({
    where: { uuid: ideaUuid },
    data: {
      elaborationDepth: "minimal",
      elaborationStatus: "resolved",
    },
  });

  await activityService.createActivity({
    companyUuid,
    projectUuid: idea.projectUuid,
    targetType: "idea",
    targetUuid: ideaUuid,
    actorType,
    actorUuid,
    action: "elaboration_skipped",
    value: { reason },
  });

  eventBus.emitChange({ companyUuid, projectUuid: idea.projectUuid, entityType: "idea", entityUuid: ideaUuid, action: "updated" });
}

// ===== Get Elaboration =====

export async function getElaboration({
  companyUuid,
  ideaUuid,
}: {
  companyUuid: string;
  ideaUuid: string;
}): Promise<ElaborationResponse> {
  const idea = await prisma.idea.findFirst({
    where: { uuid: ideaUuid, companyUuid },
  });
  if (!idea) throw new Error("Idea not found");

  const rounds = await prisma.elaborationRound.findMany({
    where: { ideaUuid, companyUuid },
    include: { questions: true },
    orderBy: { roundNumber: "asc" },
  });

  const allQuestions = rounds.flatMap((r) => r.questions);
  const answeredQuestions = allQuestions.filter((q) => q.answeredAt !== null);
  const validatedRounds = rounds.filter((r) => r.status === "validated");
  const pendingRound = rounds.find((r) => r.status === "pending_answers");

  return {
    ideaUuid,
    depth: idea.elaborationDepth,
    status: idea.elaborationStatus,
    rounds: rounds.map(formatRoundResponse),
    summary: {
      totalQuestions: allQuestions.length,
      answeredQuestions: answeredQuestions.length,
      validatedRounds: validatedRounds.length,
      pendingRound: pendingRound?.roundNumber || null,
    },
  };
}

// ===== Helpers =====

export function validateQuestionsFormat(questions: QuestionInput[]): void {
  if (questions.length === 0) {
    throw new Error("At least 1 question is required");
  }
  if (questions.length > 15) {
    throw new Error("Maximum 15 questions per round");
  }
  for (const q of questions) {
    if (!q.text || q.text.trim().length === 0) {
      throw new Error(`Question '${q.id}' has empty text`);
    }
    if (!q.options || q.options.length < 2 || q.options.length > 5) {
      throw new Error(
        `Question '${q.id}' must have 2-5 options, got ${q.options?.length || 0}`
      );
    }
    for (const opt of q.options) {
      if (!opt.id || !opt.label) {
        throw new Error(
          `Question '${q.id}' has an option with missing id or label`
        );
      }
    }
  }
}

export function formatRoundResponse(
  round: {
    uuid: string;
    roundNumber: number;
    status: string;
    createdByType: string;
    createdByUuid: string;
    validatedAt: Date | null;
    createdAt: Date;
    questions: Array<{
      uuid: string;
      questionId: string;
      text: string;
      category: string;
      options: unknown;
      required: boolean;
      selectedOptionId: string | null;
      customText: string | null;
      answeredAt: Date | null;
      answeredByType: string | null;
      answeredByUuid: string | null;
      issueType: string | null;
      issueDescription: string | null;
    }>;
  },
): ElaborationRoundResponse {
  return {
    uuid: round.uuid,
    roundNumber: round.roundNumber,
    status: round.status,
    createdBy: {
      type: round.createdByType,
      uuid: round.createdByUuid,
    },
    validatedAt: round.validatedAt?.toISOString() || null,
    createdAt: round.createdAt.toISOString(),
    questions: round.questions.map(formatQuestionResponse),
  };
}

export function formatQuestionResponse(
  q: {
    uuid: string;
    questionId: string;
    text: string;
    category: string;
    options: unknown;
    required: boolean;
    selectedOptionId: string | null;
    customText: string | null;
    answeredAt: Date | null;
    answeredByType: string | null;
    answeredByUuid: string | null;
    issueType: string | null;
    issueDescription: string | null;
  },
): ElaborationQuestionResponse {
  return {
    uuid: q.uuid,
    questionId: q.questionId,
    text: q.text,
    category: q.category,
    options: q.options as QuestionOption[],
    required: q.required,
    answer: q.answeredAt
      ? {
          selectedOptionId: q.selectedOptionId,
          customText: q.customText,
          answeredAt: q.answeredAt.toISOString(),
          answeredBy: {
            type: q.answeredByType!,
            uuid: q.answeredByUuid!,
          },
        }
      : null,
    issue: q.issueType
      ? {
          type: q.issueType,
          description: q.issueDescription || "",
        }
      : null,
  };
}
