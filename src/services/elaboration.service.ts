// src/services/elaboration.service.ts
// Elaboration Service Layer — AI-DLC Stage 3 (Requirements Clarification)

import { prisma } from "@/lib/prisma";
import { eventBus } from "@/lib/event-bus";
import { activityService } from "@/services";
import {
  type QuestionInput,
  type AnswerInput,
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
  if (idea.status !== "elaborating" && idea.status !== "elaborated") {
    throw new Error(
      `Cannot start elaboration from status '${idea.status}'. Idea must be in 'elaborating' or 'elaborated' status (claim it first).`
    );
  }

  // Appended round: the Idea's elaboration was already resolved at call time.
  // Appended rounds are a pure supplement — they must NOT regress the Idea
  // lifecycle (R2 decision): keep status `elaborated` and elaborationStatus
  // `resolved` so an in-flight proposal is never re-blocked.
  const isAppended = idea.status === "elaborated";

  // Determine round number
  const existingRounds = await prisma.elaborationRound.count({
    where: { ideaUuid, companyUuid },
  });
  const roundNumber = existingRounds + 1;

  if (roundNumber > 10) {
    throw new Error("Maximum 10 elaboration rounds per Idea");
  }

  // Create round + questions
  const created = await prisma.elaborationRound.create({
    data: {
      companyUuid,
      ideaUuid,
      roundNumber,
      status: "pending_answers",
      isAppended,
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

  // Update idea status + elaboration fields.
  // For appended rounds, do NOT downgrade idea.status and do NOT overwrite a
  // `resolved` elaborationStatus — only the new round sits at pending_answers.
  if (isAppended) {
    await prisma.idea.update({
      where: { uuid: ideaUuid },
      data: { elaborationDepth: depth },
    });
  } else {
    await prisma.idea.update({
      where: { uuid: ideaUuid },
      data: {
        status: "elaborating",
        elaborationDepth: depth,
        elaborationStatus: "pending_answers",
      },
    });
  }

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
  roundUuid?: string;
  actorUuid: string;
  actorType: string;
  answers: AnswerInput[];
}): Promise<ElaborationRoundResponse> {
  // Resolve the target round. When roundUuid is omitted, auto-locate the
  // Idea's single active (pending_answers) round.
  let resolvedRoundUuid = roundUuid;
  if (!resolvedRoundUuid) {
    const activeRounds = await prisma.elaborationRound.findMany({
      where: { ideaUuid, companyUuid, status: "pending_answers" },
      select: { uuid: true },
    });
    if (activeRounds.length === 0) {
      throw new Error("no active round to answer");
    }
    if (activeRounds.length > 1) {
      throw new Error("multiple active rounds; specify roundUuid");
    }
    resolvedRoundUuid = activeRounds[0].uuid;
  }

  // Load round with questions
  const round = await prisma.elaborationRound.findFirst({
    where: { uuid: resolvedRoundUuid, ideaUuid, companyUuid },
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
    where: { roundUuid: resolvedRoundUuid },
  });
  const allRequiredAnswered = updatedQuestions
    .filter((q) => q.required)
    .every((q) => q.answeredAt !== null);

  // Load idea (needed for project UUID and the resolved-state guard below)
  const idea = await prisma.idea.findFirst({
    where: { uuid: ideaUuid, companyUuid },
  });

  // Update round status if all answered
  if (allRequiredAnswered) {
    await prisma.elaborationRound.update({
      where: { uuid: resolvedRoundUuid },
      data: { status: "answered" },
    });
    // R2 guard: never flip a resolved Idea back to `validating`. Appended
    // rounds keep the Idea at `resolved` so an in-flight proposal is not
    // re-blocked — the round still moves to `answered` above.
    if (idea?.elaborationStatus !== "resolved") {
      await prisma.idea.update({
        where: { uuid: ideaUuid },
        data: { elaborationStatus: "validating" },
      });
    }
  }

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
    where: { uuid: resolvedRoundUuid },
    include: { questions: true },
  });
  return formatRoundResponse(updatedRound!);
}

// ===== Resolve Elaboration =====

export async function resolveElaboration({
  companyUuid,
  ideaUuid,
  actorUuid,
  actorType,
}: {
  companyUuid: string;
  ideaUuid: string;
  actorUuid: string;
  actorType: string;
}): Promise<ElaborationResponse> {
  // Verify the Idea exists and the actor is its assignee
  const idea = await prisma.idea.findFirst({
    where: { uuid: ideaUuid, companyUuid },
  });
  if (!idea) throw new Error("Idea not found");
  if (idea.assigneeUuid !== actorUuid) {
    throw new Error("Only the assigned agent can resolve elaboration");
  }

  // Resolve operates on the whole Idea (not a single round). Precondition:
  // there is at least one round and every round has been answered. A round
  // counts as answered once it leaves `pending_answers` (legacy `validated`
  // rounds are treated the same as `answered`).
  const rounds = await prisma.elaborationRound.findMany({
    where: { ideaUuid, companyUuid },
  });
  if (rounds.length === 0) {
    throw new Error("Cannot resolve: the Idea has no elaboration rounds");
  }
  const unanswered = rounds.filter((r) => r.status === "pending_answers");
  if (unanswered.length > 0) {
    throw new Error(
      `Cannot resolve: ${unanswered.length} round(s) still have unanswered questions`
    );
  }

  // Mark the whole elaboration resolved (Idea-level; round statuses untouched).
  await prisma.idea.update({
    where: { uuid: ideaUuid },
    data: { status: "elaborated", elaborationStatus: "resolved" },
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
      totalRounds: rounds.length,
    },
  });

  eventBus.emitChange({ companyUuid, projectUuid: idea.projectUuid, entityType: "idea", entityUuid: ideaUuid, action: "updated" });

  return getElaboration({ companyUuid, ideaUuid });
}

// ===== Verify Elaboration (human-callable) =====

/**
 * Human-callable elaboration resolution path. Additive to — and does NOT
 * replace — the agent-only `resolveElaboration` (surfaced as the
 * `chorus_pm_validate_elaboration` MCP tool).
 *
 * Enforces the SAME structural precondition as `resolveElaboration` (the Idea
 * has at least one round and no round is in `pending_answers`) and performs the
 * SAME state transition (`status → elaborated`, `elaborationStatus →
 * resolved`). CRITICAL DIFFERENCE: it does NOT require the actor to be the
 * Idea's assignee — the human verifier is never the assignee (the daemon agent
 * is). The Idea lookup is scoped by `companyUuid`. Logs activity with action
 * `elaboration_verified` (distinct from the agent path's `elaboration_resolved`)
 * so the downstream wake can tell "human verified → write proposal" apart from
 * "agent self-validated."
 */
export async function verifyElaboration({
  companyUuid,
  ideaUuid,
  actorUuid,
  actorType,
}: {
  companyUuid: string;
  ideaUuid: string;
  actorUuid: string;
  actorType: string;
}): Promise<ElaborationResponse> {
  // Scope the Idea by company. Unlike resolveElaboration, the actor is NOT
  // required to be the assignee — the human verifier is a company user, not
  // the assigned daemon agent.
  const idea = await prisma.idea.findFirst({
    where: { uuid: ideaUuid, companyUuid },
  });
  if (!idea) throw new Error("Idea not found");

  // Same structural precondition as resolveElaboration: at least one round and
  // every round answered (a round counts as answered once it leaves
  // `pending_answers`; legacy `validated` rounds count the same as `answered`).
  const rounds = await prisma.elaborationRound.findMany({
    where: { ideaUuid, companyUuid },
  });
  if (rounds.length === 0) {
    throw new Error("Cannot resolve: the Idea has no elaboration rounds");
  }
  const unanswered = rounds.filter((r) => r.status === "pending_answers");
  if (unanswered.length > 0) {
    throw new Error(
      `Cannot resolve: ${unanswered.length} round(s) still have unanswered questions`
    );
  }

  // Same state transition as resolveElaboration (Idea-level; round statuses
  // untouched).
  await prisma.idea.update({
    where: { uuid: ideaUuid },
    data: { status: "elaborated", elaborationStatus: "resolved" },
  });

  await activityService.createActivity({
    companyUuid,
    projectUuid: idea.projectUuid,
    targetType: "idea",
    targetUuid: ideaUuid,
    actorType,
    actorUuid,
    action: "elaboration_verified",
    value: {
      totalRounds: rounds.length,
    },
  });

  eventBus.emitChange({ companyUuid, projectUuid: idea.projectUuid, entityType: "idea", entityUuid: ideaUuid, action: "updated" });

  return getElaboration({ companyUuid, ideaUuid });
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
      status: "elaborated",
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
  // "done" rounds = anything past pending_answers. `validated` is legacy but
  // counts the same as `answered` (see RoundStatus). Field name kept for
  // response-shape stability.
  const validatedRounds = rounds.filter((r) => r.status !== "pending_answers");
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
    isAppended: boolean;
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
    isAppended: round.isAppended,
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
