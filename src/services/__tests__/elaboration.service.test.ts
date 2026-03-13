import { describe, it, expect, vi, beforeEach } from "vitest";

// ===== Mocks (hoisted so vi.mock factories can reference them) =====

const { mockPrisma, mockEventBus, mockCreateActivity } = vi.hoisted(() => ({
  mockPrisma: {
    idea: {
      findFirst: vi.fn(),
      update: vi.fn(),
    },
    elaborationRound: {
      count: vi.fn(),
      create: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      findUniqueOrThrow: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
    },
    elaborationQuestion: {
      update: vi.fn(),
      findMany: vi.fn(),
    },
  },
  mockEventBus: { emitChange: vi.fn() },
  mockCreateActivity: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/prisma", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/event-bus", () => ({ eventBus: mockEventBus }));
vi.mock("@/services", () => ({
  activityService: { createActivity: mockCreateActivity },
}));

import {
  startElaboration,
  answerElaboration,
  validateElaboration,
  skipElaboration,
  getElaboration,
} from "@/services/elaboration.service";

// ===== Test Data =====

const COMPANY_UUID = "company-1111-1111-1111-111111111111";
const IDEA_UUID = "idea-2222-2222-2222-222222222222";
const ROUND_UUID = "round-3333-3333-3333-333333333333";
const ACTOR_UUID = "actor-4444-4444-4444-444444444444";
const PROJECT_UUID = "project-5555-5555-5555-555555555555";

const now = new Date("2026-01-15T10:00:00Z");

const validQuestions = [
  {
    id: "q1",
    text: "What is the scope?",
    category: "scope" as const,
    options: [
      { id: "o1", label: "Small" },
      { id: "o2", label: "Large" },
    ],
    required: true,
  },
  {
    id: "q2",
    text: "Target platform?",
    category: "technical_context" as const,
    options: [
      { id: "o1", label: "Web" },
      { id: "o2", label: "Mobile" },
    ],
    required: false,
  },
];

function makeIdea(overrides: Record<string, unknown> = {}) {
  return {
    uuid: IDEA_UUID,
    companyUuid: COMPANY_UUID,
    projectUuid: PROJECT_UUID,
    title: "Test Idea",
    content: "Content",
    status: "elaborating",
    assigneeUuid: ACTOR_UUID,
    assigneeType: "agent",
    elaborationDepth: "standard",
    elaborationStatus: "pending_answers",
    ...overrides,
  };
}

function makeRound(overrides: Record<string, unknown> = {}) {
  return {
    uuid: ROUND_UUID,
    companyUuid: COMPANY_UUID,
    ideaUuid: IDEA_UUID,
    roundNumber: 1,
    status: "pending_answers",
    createdByType: "agent",
    createdByUuid: ACTOR_UUID,
    validatedAt: null,
    createdAt: now,
    questions: [
      {
        uuid: "qrec-1111",
        questionId: "q1",
        text: "What is the scope?",
        category: "scope",
        options: [{ id: "o1", label: "Small" }, { id: "o2", label: "Large" }],
        required: true,
        selectedOptionId: null,
        customText: null,
        answeredAt: null,
        answeredByType: null,
        answeredByUuid: null,
        issueType: null,
        issueDescription: null,
      },
      {
        uuid: "qrec-2222",
        questionId: "q2",
        text: "Target platform?",
        category: "technical_context",
        options: [{ id: "o1", label: "Web" }, { id: "o2", label: "Mobile" }],
        required: false,
        selectedOptionId: null,
        customText: null,
        answeredAt: null,
        answeredByType: null,
        answeredByUuid: null,
        issueType: null,
        issueDescription: null,
      },
    ],
    ...overrides,
  };
}

// ===== Tests =====

beforeEach(() => {
  vi.clearAllMocks();
});

describe("startElaboration", () => {
  it("should create a round with questions and update idea status", async () => {
    const idea = makeIdea();
    const created = { uuid: ROUND_UUID };
    const round = makeRound();

    mockPrisma.idea.findFirst.mockResolvedValue(idea);
    mockPrisma.elaborationRound.count.mockResolvedValue(0);
    mockPrisma.elaborationRound.create.mockResolvedValue(created);
    mockPrisma.elaborationRound.findUniqueOrThrow.mockResolvedValue(round);
    mockPrisma.idea.update.mockResolvedValue(idea);

    const result = await startElaboration({
      companyUuid: COMPANY_UUID,
      ideaUuid: IDEA_UUID,
      actorUuid: ACTOR_UUID,
      actorType: "agent",
      depth: "standard",
      questions: validQuestions,
    });

    expect(mockPrisma.elaborationRound.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          companyUuid: COMPANY_UUID,
          ideaUuid: IDEA_UUID,
          roundNumber: 1,
          status: "pending_answers",
          questions: expect.objectContaining({
            create: expect.arrayContaining([
              expect.objectContaining({ questionId: "q1", required: true }),
              expect.objectContaining({ questionId: "q2", required: false }),
            ]),
          }),
        }),
      })
    );

    expect(mockPrisma.idea.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { uuid: IDEA_UUID },
        data: expect.objectContaining({
          elaborationDepth: "standard",
          elaborationStatus: "pending_answers",
        }),
      })
    );

    expect(mockCreateActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "elaboration_started",
        value: expect.objectContaining({ depth: "standard", questionCount: 2, roundNumber: 1 }),
      })
    );

    expect(mockEventBus.emitChange).toHaveBeenCalled();
    expect(result.uuid).toBe(ROUND_UUID);
    expect(result.roundNumber).toBe(1);
    expect(result.questions).toHaveLength(2);
  });

  it("should throw if idea not found", async () => {
    mockPrisma.idea.findFirst.mockResolvedValue(null);

    await expect(
      startElaboration({
        companyUuid: COMPANY_UUID,
        ideaUuid: IDEA_UUID,
        actorUuid: ACTOR_UUID,
        actorType: "agent",
        depth: "standard",
        questions: validQuestions,
      })
    ).rejects.toThrow("Idea not found");
  });

  it("should throw if actor is not the assignee", async () => {
    mockPrisma.idea.findFirst.mockResolvedValue(
      makeIdea({ assigneeUuid: "other-agent-uuid" })
    );

    await expect(
      startElaboration({
        companyUuid: COMPANY_UUID,
        ideaUuid: IDEA_UUID,
        actorUuid: ACTOR_UUID,
        actorType: "agent",
        depth: "standard",
        questions: validQuestions,
      })
    ).rejects.toThrow("Only the assigned agent can start elaboration");
  });

  it("should throw if idea status is not elaborating", async () => {
    mockPrisma.idea.findFirst.mockResolvedValue(makeIdea({ status: "open" }));

    await expect(
      startElaboration({
        companyUuid: COMPANY_UUID,
        ideaUuid: IDEA_UUID,
        actorUuid: ACTOR_UUID,
        actorType: "agent",
        depth: "standard",
        questions: validQuestions,
      })
    ).rejects.toThrow("Cannot start elaboration from status");
  });

  it("should throw if max 5 rounds exceeded", async () => {
    mockPrisma.idea.findFirst.mockResolvedValue(makeIdea());
    mockPrisma.elaborationRound.count.mockResolvedValue(5);

    await expect(
      startElaboration({
        companyUuid: COMPANY_UUID,
        ideaUuid: IDEA_UUID,
        actorUuid: ACTOR_UUID,
        actorType: "agent",
        depth: "standard",
        questions: validQuestions,
      })
    ).rejects.toThrow("Maximum 5 elaboration rounds per Idea");
  });
});

describe("answerElaboration", () => {
  it("should record answers and update round status when all required answered", async () => {
    const round = makeRound({ status: "pending_answers" });
    const answeredQuestions = round.questions.map((q: Record<string, unknown>) => ({
      ...q,
      answeredAt: now,
      selectedOptionId: "o1",
    }));

    mockPrisma.elaborationRound.findFirst.mockResolvedValue(round);
    mockPrisma.elaborationQuestion.update.mockResolvedValue({});
    mockPrisma.elaborationQuestion.findMany.mockResolvedValue(answeredQuestions);
    mockPrisma.elaborationRound.update.mockResolvedValue({});
    mockPrisma.idea.update.mockResolvedValue({});
    mockPrisma.idea.findFirst.mockResolvedValue(makeIdea());
    mockPrisma.elaborationRound.findUnique.mockResolvedValue(
      makeRound({ status: "answered", questions: answeredQuestions })
    );

    const result = await answerElaboration({
      companyUuid: COMPANY_UUID,
      ideaUuid: IDEA_UUID,
      roundUuid: ROUND_UUID,
      actorUuid: ACTOR_UUID,
      actorType: "user",
      answers: [
        { questionId: "q1", selectedOptionId: "o1", customText: null },
        { questionId: "q2", selectedOptionId: "o2", customText: null },
      ],
    });

    expect(mockPrisma.elaborationQuestion.update).toHaveBeenCalledTimes(2);

    expect(mockPrisma.elaborationRound.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { uuid: ROUND_UUID },
        data: { status: "answered" },
      })
    );

    expect(mockPrisma.idea.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { uuid: IDEA_UUID },
        data: { elaborationStatus: "validating" },
      })
    );

    expect(mockCreateActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "elaboration_answered",
      })
    );

    expect(result.uuid).toBe(ROUND_UUID);
  });

  it("should throw if round not found", async () => {
    mockPrisma.elaborationRound.findFirst.mockResolvedValue(null);

    await expect(
      answerElaboration({
        companyUuid: COMPANY_UUID,
        ideaUuid: IDEA_UUID,
        roundUuid: ROUND_UUID,
        actorUuid: ACTOR_UUID,
        actorType: "user",
        answers: [{ questionId: "q1", selectedOptionId: "o1", customText: null }],
      })
    ).rejects.toThrow("Elaboration round not found");
  });

  it("should throw if round status is not pending_answers", async () => {
    mockPrisma.elaborationRound.findFirst.mockResolvedValue(
      makeRound({ status: "answered" })
    );

    await expect(
      answerElaboration({
        companyUuid: COMPANY_UUID,
        ideaUuid: IDEA_UUID,
        roundUuid: ROUND_UUID,
        actorUuid: ACTOR_UUID,
        actorType: "user",
        answers: [{ questionId: "q1", selectedOptionId: "o1", customText: null }],
      })
    ).rejects.toThrow("expected 'pending_answers'");
  });

  it("should throw for unknown questionId", async () => {
    mockPrisma.elaborationRound.findFirst.mockResolvedValue(makeRound());

    await expect(
      answerElaboration({
        companyUuid: COMPANY_UUID,
        ideaUuid: IDEA_UUID,
        roundUuid: ROUND_UUID,
        actorUuid: ACTOR_UUID,
        actorType: "user",
        answers: [{ questionId: "nonexistent", selectedOptionId: "o1", customText: null }],
      })
    ).rejects.toThrow("Question 'nonexistent' not found in round");
  });

  it("should throw for invalid option selection", async () => {
    mockPrisma.elaborationRound.findFirst.mockResolvedValue(makeRound());

    await expect(
      answerElaboration({
        companyUuid: COMPANY_UUID,
        ideaUuid: IDEA_UUID,
        roundUuid: ROUND_UUID,
        actorUuid: ACTOR_UUID,
        actorType: "user",
        answers: [{ questionId: "q1", selectedOptionId: "invalid-option", customText: null }],
      })
    ).rejects.toThrow("Invalid option 'invalid-option'");
  });

  it("should throw if custom text is empty when no option selected", async () => {
    mockPrisma.elaborationRound.findFirst.mockResolvedValue(makeRound());

    await expect(
      answerElaboration({
        companyUuid: COMPANY_UUID,
        ideaUuid: IDEA_UUID,
        roundUuid: ROUND_UUID,
        actorUuid: ACTOR_UUID,
        actorType: "user",
        answers: [{ questionId: "q1", selectedOptionId: null, customText: "" }],
      })
    ).rejects.toThrow("custom text is required");
  });
});

describe("validateElaboration", () => {
  it("should mark round as validated when no issues", async () => {
    const round = makeRound({ status: "answered" });
    const validatedRound = makeRound({ status: "validated", validatedAt: now });

    mockPrisma.elaborationRound.findFirst.mockResolvedValue(round);
    mockPrisma.idea.findFirst.mockResolvedValue(makeIdea());
    mockPrisma.elaborationRound.update.mockResolvedValue({});
    mockPrisma.idea.update.mockResolvedValue({});
    mockPrisma.elaborationRound.findUnique.mockResolvedValue(validatedRound);

    const result = await validateElaboration({
      companyUuid: COMPANY_UUID,
      ideaUuid: IDEA_UUID,
      roundUuid: ROUND_UUID,
      actorUuid: ACTOR_UUID,
      actorType: "agent",
      issues: [],
    });

    expect(mockPrisma.elaborationRound.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { uuid: ROUND_UUID },
        data: expect.objectContaining({ status: "validated" }),
      })
    );

    expect(mockPrisma.idea.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { uuid: IDEA_UUID },
        data: { elaborationStatus: "resolved" },
      })
    );

    expect(mockCreateActivity).toHaveBeenCalledWith(
      expect.objectContaining({ action: "elaboration_resolved" })
    );

    expect(result.validatedRound).toBeDefined();
    expect(result.followUpRound).toBeUndefined();
  });

  it("should create follow-up round when issues with follow-up questions", async () => {
    const round = makeRound({ status: "answered" });
    const idea = makeIdea({ elaborationDepth: "standard" });

    mockPrisma.elaborationRound.findFirst.mockResolvedValue(round);
    mockPrisma.idea.findFirst
      .mockResolvedValueOnce(idea) // validateElaboration call
      .mockResolvedValueOnce(idea); // startElaboration inner call
    mockPrisma.elaborationQuestion.update.mockResolvedValue({});
    mockPrisma.elaborationRound.update.mockResolvedValue({});

    // For startElaboration (follow-up round creation)
    mockPrisma.elaborationRound.count.mockResolvedValue(1);
    const followUpRound = makeRound({
      uuid: "follow-up-round-uuid",
      roundNumber: 2,
    });
    mockPrisma.elaborationRound.create.mockResolvedValue({ uuid: "follow-up-round-uuid" });
    mockPrisma.elaborationRound.findUniqueOrThrow.mockResolvedValue(followUpRound);
    mockPrisma.idea.update.mockResolvedValue({});

    // Final findUnique for validated round
    mockPrisma.elaborationRound.findUnique.mockResolvedValue(
      makeRound({ status: "needs_followup", validatedAt: now })
    );

    const result = await validateElaboration({
      companyUuid: COMPANY_UUID,
      ideaUuid: IDEA_UUID,
      roundUuid: ROUND_UUID,
      actorUuid: ACTOR_UUID,
      actorType: "agent",
      issues: [
        { questionId: "q1", type: "ambiguity", description: "Unclear answer" },
      ],
      followUpQuestions: validQuestions,
    });

    expect(mockPrisma.elaborationRound.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { uuid: ROUND_UUID },
        data: expect.objectContaining({ status: "needs_followup" }),
      })
    );

    expect(mockPrisma.elaborationQuestion.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          issueType: "ambiguity",
          issueDescription: "Unclear answer",
        }),
      })
    );

    expect(result.validatedRound).toBeDefined();
    expect(result.followUpRound).toBeDefined();
  });

  it("should throw if round not in answered status", async () => {
    mockPrisma.elaborationRound.findFirst.mockResolvedValue(
      makeRound({ status: "pending_answers" })
    );

    await expect(
      validateElaboration({
        companyUuid: COMPANY_UUID,
        ideaUuid: IDEA_UUID,
        roundUuid: ROUND_UUID,
        actorUuid: ACTOR_UUID,
        actorType: "agent",
        issues: [],
      })
    ).rejects.toThrow("expected 'answered'");
  });

  it("should throw if actor is not the idea assignee", async () => {
    mockPrisma.elaborationRound.findFirst.mockResolvedValue(
      makeRound({ status: "answered" })
    );
    mockPrisma.idea.findFirst.mockResolvedValue(
      makeIdea({ assigneeUuid: "other-agent" })
    );

    await expect(
      validateElaboration({
        companyUuid: COMPANY_UUID,
        ideaUuid: IDEA_UUID,
        roundUuid: ROUND_UUID,
        actorUuid: ACTOR_UUID,
        actorType: "agent",
        issues: [],
      })
    ).rejects.toThrow("Only the assigned agent can validate elaboration");
  });
});

describe("skipElaboration", () => {
  it("should set elaboration to minimal/resolved and log activity", async () => {
    mockPrisma.idea.findFirst.mockResolvedValue(makeIdea());
    mockPrisma.idea.update.mockResolvedValue({});

    await skipElaboration({
      companyUuid: COMPANY_UUID,
      ideaUuid: IDEA_UUID,
      actorUuid: ACTOR_UUID,
      actorType: "agent",
      reason: "Requirements are already clear",
    });

    expect(mockPrisma.idea.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { uuid: IDEA_UUID },
        data: {
          elaborationDepth: "minimal",
          elaborationStatus: "resolved",
        },
      })
    );

    expect(mockCreateActivity).toHaveBeenCalledWith(
      expect.objectContaining({
        action: "elaboration_skipped",
        value: { reason: "Requirements are already clear" },
      })
    );

    expect(mockEventBus.emitChange).toHaveBeenCalled();
  });

  it("should throw if actor is not the assignee", async () => {
    mockPrisma.idea.findFirst.mockResolvedValue(
      makeIdea({ assigneeUuid: "other-agent" })
    );

    await expect(
      skipElaboration({
        companyUuid: COMPANY_UUID,
        ideaUuid: IDEA_UUID,
        actorUuid: ACTOR_UUID,
        actorType: "agent",
        reason: "Clear enough",
      })
    ).rejects.toThrow("Only the assigned agent can skip elaboration");
  });

  it("should throw if idea is not in elaborating status", async () => {
    mockPrisma.idea.findFirst.mockResolvedValue(makeIdea({ status: "open" }));

    await expect(
      skipElaboration({
        companyUuid: COMPANY_UUID,
        ideaUuid: IDEA_UUID,
        actorUuid: ACTOR_UUID,
        actorType: "agent",
        reason: "Clear",
      })
    ).rejects.toThrow("Cannot skip elaboration from status");
  });
});

describe("getElaboration", () => {
  it("should return elaboration history with summary", async () => {
    const idea = makeIdea({
      elaborationDepth: "standard",
      elaborationStatus: "pending_answers",
    });
    const rounds = [makeRound()];

    mockPrisma.idea.findFirst.mockResolvedValue(idea);
    mockPrisma.elaborationRound.findMany.mockResolvedValue(rounds);

    const result = await getElaboration({
      companyUuid: COMPANY_UUID,
      ideaUuid: IDEA_UUID,
    });

    expect(result.ideaUuid).toBe(IDEA_UUID);
    expect(result.depth).toBe("standard");
    expect(result.status).toBe("pending_answers");
    expect(result.rounds).toHaveLength(1);
    expect(result.summary).toEqual({
      totalQuestions: 2,
      answeredQuestions: 0,
      validatedRounds: 0,
      pendingRound: 1,
    });
  });

  it("should throw if idea not found", async () => {
    mockPrisma.idea.findFirst.mockResolvedValue(null);

    await expect(
      getElaboration({ companyUuid: COMPANY_UUID, ideaUuid: IDEA_UUID })
    ).rejects.toThrow("Idea not found");
  });

  it("should correctly compute summary with answered questions and validated rounds", async () => {
    const idea = makeIdea({
      elaborationDepth: "comprehensive",
      elaborationStatus: "resolved",
    });
    const answeredRound = makeRound({
      status: "validated",
      questions: [
        {
          uuid: "qrec-1",
          questionId: "q1",
          text: "Q1",
          category: "scope",
          options: [],
          required: true,
          selectedOptionId: "o1",
          customText: null,
          answeredAt: now,
          answeredByType: "user",
          answeredByUuid: ACTOR_UUID,
          issueType: null,
          issueDescription: null,
        },
      ],
    });

    mockPrisma.idea.findFirst.mockResolvedValue(idea);
    mockPrisma.elaborationRound.findMany.mockResolvedValue([answeredRound]);

    const result = await getElaboration({
      companyUuid: COMPANY_UUID,
      ideaUuid: IDEA_UUID,
    });

    expect(result.summary.totalQuestions).toBe(1);
    expect(result.summary.answeredQuestions).toBe(1);
    expect(result.summary.validatedRounds).toBe(1);
    expect(result.summary.pendingRound).toBeNull();
  });
});
