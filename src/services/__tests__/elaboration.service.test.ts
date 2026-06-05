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
  resolveElaboration,
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
    isAppended: false,
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

  it("should allow starting a 10th round (cap is 10, not 5)", async () => {
    const idea = makeIdea();
    const created = { uuid: ROUND_UUID };
    const round = makeRound({ roundNumber: 10 });

    mockPrisma.idea.findFirst.mockResolvedValue(idea);
    // 9 existing rounds → this is round 10, which is allowed.
    mockPrisma.elaborationRound.count.mockResolvedValue(9);
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
        data: expect.objectContaining({ roundNumber: 10 }),
      })
    );
    expect(result.roundNumber).toBe(10);
  });

  it("should throw if max 10 rounds exceeded (round 11)", async () => {
    mockPrisma.idea.findFirst.mockResolvedValue(makeIdea());
    // 10 existing rounds → this would be round 11, which exceeds the cap.
    mockPrisma.elaborationRound.count.mockResolvedValue(10);

    await expect(
      startElaboration({
        companyUuid: COMPANY_UUID,
        ideaUuid: IDEA_UUID,
        actorUuid: ACTOR_UUID,
        actorType: "agent",
        depth: "standard",
        questions: validQuestions,
      })
    ).rejects.toThrow("Maximum 10 elaboration rounds per Idea");
  });

  it("should create an appended round (isAppended=true) on a resolved Idea, keeping it elaborated/resolved", async () => {
    // Idea already elaborated + resolved → appended round.
    const idea = makeIdea({ status: "elaborated", elaborationStatus: "resolved" });
    const created = { uuid: ROUND_UUID };
    const appendedRound = makeRound({
      roundNumber: 2,
      isAppended: true,
    });

    mockPrisma.idea.findFirst.mockResolvedValue(idea);
    mockPrisma.elaborationRound.count.mockResolvedValue(1);
    mockPrisma.elaborationRound.create.mockResolvedValue(created);
    mockPrisma.elaborationRound.findUniqueOrThrow.mockResolvedValue(appendedRound);
    mockPrisma.idea.update.mockResolvedValue(idea);

    const result = await startElaboration({
      companyUuid: COMPANY_UUID,
      ideaUuid: IDEA_UUID,
      actorUuid: ACTOR_UUID,
      actorType: "agent",
      depth: "standard",
      questions: validQuestions,
    });

    // Round is created with isAppended=true and status pending_answers.
    expect(mockPrisma.elaborationRound.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          isAppended: true,
          status: "pending_answers",
        }),
      })
    );

    // R2 decision: the Idea is NOT regressed — its status/elaborationStatus are
    // left untouched. The update only persists the elaboration depth; it must
    // NOT write status or elaborationStatus.
    expect(mockPrisma.idea.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { uuid: IDEA_UUID },
        data: { elaborationDepth: "standard" },
      })
    );
    const ideaUpdateData = mockPrisma.idea.update.mock.calls[0][0].data;
    expect(ideaUpdateData).not.toHaveProperty("status");
    expect(ideaUpdateData).not.toHaveProperty("elaborationStatus");

    expect(result.isAppended).toBe(true);
  });

  it("should create a non-appended round (isAppended=false) on an elaborating Idea and set elaborationStatus=pending_answers", async () => {
    const idea = makeIdea({ status: "elaborating", elaborationStatus: "pending_answers" });
    const created = { uuid: ROUND_UUID };
    const round = makeRound({ isAppended: false });

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
        data: expect.objectContaining({ isAppended: false }),
      })
    );
    // Normal flow: the Idea is moved to elaborating/pending_answers.
    expect(mockPrisma.idea.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { uuid: IDEA_UUID },
        data: expect.objectContaining({
          status: "elaborating",
          elaborationStatus: "pending_answers",
        }),
      })
    );
    expect(result.isAppended).toBe(false);
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

  it("should auto-locate the single active round when roundUuid is omitted", async () => {
    const round = makeRound({ status: "pending_answers" });
    const answeredQuestions = round.questions.map((q: Record<string, unknown>) => ({
      ...q,
      answeredAt: now,
      selectedOptionId: "o1",
    }));

    // Auto-location: exactly one pending_answers round.
    mockPrisma.elaborationRound.findMany.mockResolvedValue([{ uuid: ROUND_UUID }]);
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
      // no roundUuid
      actorUuid: ACTOR_UUID,
      actorType: "user",
      answers: [
        { questionId: "q1", selectedOptionId: "o1", customText: null },
      ],
    });

    // It must have looked up the active round by status.
    expect(mockPrisma.elaborationRound.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: "pending_answers" }),
      })
    );
    // And applied answers to that auto-located round.
    expect(mockPrisma.elaborationRound.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ uuid: ROUND_UUID }),
      })
    );
    expect(result.uuid).toBe(ROUND_UUID);
  });

  it("should throw 'no active round' when roundUuid omitted and zero active rounds", async () => {
    mockPrisma.elaborationRound.findMany.mockResolvedValue([]);

    await expect(
      answerElaboration({
        companyUuid: COMPANY_UUID,
        ideaUuid: IDEA_UUID,
        actorUuid: ACTOR_UUID,
        actorType: "user",
        answers: [{ questionId: "q1", selectedOptionId: "o1", customText: null }],
      })
    ).rejects.toThrow("no active round to answer");
  });

  it("should throw 'specify roundUuid' when roundUuid omitted and multiple active rounds", async () => {
    mockPrisma.elaborationRound.findMany.mockResolvedValue([
      { uuid: "round-a" },
      { uuid: "round-b" },
    ]);

    await expect(
      answerElaboration({
        companyUuid: COMPANY_UUID,
        ideaUuid: IDEA_UUID,
        actorUuid: ACTOR_UUID,
        actorType: "user",
        answers: [{ questionId: "q1", selectedOptionId: "o1", customText: null }],
      })
    ).rejects.toThrow("multiple active rounds; specify roundUuid");
  });

  it("should mark an appended round answered but keep the Idea's elaborationStatus=resolved", async () => {
    // Appended round on an already-resolved Idea.
    const appendedRound = makeRound({ status: "pending_answers", isAppended: true });
    const answeredQuestions = appendedRound.questions.map(
      (q: Record<string, unknown>) => ({
        ...q,
        answeredAt: now,
        selectedOptionId: "o1",
      })
    );

    mockPrisma.elaborationRound.findFirst.mockResolvedValue(appendedRound);
    mockPrisma.elaborationQuestion.update.mockResolvedValue({});
    mockPrisma.elaborationQuestion.findMany.mockResolvedValue(answeredQuestions);
    mockPrisma.elaborationRound.update.mockResolvedValue({});
    mockPrisma.idea.update.mockResolvedValue({});
    // The Idea is resolved — the R2 guard must prevent flipping to validating.
    mockPrisma.idea.findFirst.mockResolvedValue(
      makeIdea({ status: "elaborated", elaborationStatus: "resolved" })
    );
    mockPrisma.elaborationRound.findUnique.mockResolvedValue(
      makeRound({ status: "answered", isAppended: true, questions: answeredQuestions })
    );

    const result = await answerElaboration({
      companyUuid: COMPANY_UUID,
      ideaUuid: IDEA_UUID,
      roundUuid: ROUND_UUID,
      actorUuid: ACTOR_UUID,
      actorType: "user",
      answers: [
        { questionId: "q1", selectedOptionId: "o1", customText: null },
      ],
    });

    // Round advances to answered.
    expect(mockPrisma.elaborationRound.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { uuid: ROUND_UUID },
        data: { status: "answered" },
      })
    );

    // R2 guard: the Idea's elaborationStatus must NOT be downgraded to validating.
    // The only idea.update calls (if any) must not write elaborationStatus.
    const wroteValidating = mockPrisma.idea.update.mock.calls.some(
      (call) => call[0]?.data?.elaborationStatus === "validating"
    );
    expect(wroteValidating).toBe(false);

    expect(result.status).toBe("answered");
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

describe("resolveElaboration", () => {
  it("should mark the most recent answered round validated and resolve the Idea (no roundUuid)", async () => {
    const answeredRound = makeRound({ status: "answered", roundNumber: 2 });
    const validatedRound = makeRound({ status: "validated", validatedAt: now });

    // 1) assignee check, 2) most-recent answered round, ... 3) final reload
    mockPrisma.idea.findFirst.mockResolvedValue(makeIdea());
    mockPrisma.elaborationRound.findFirst.mockResolvedValue(answeredRound);
    mockPrisma.elaborationRound.update.mockResolvedValue({});
    mockPrisma.idea.update.mockResolvedValue({});
    mockPrisma.elaborationRound.findUnique.mockResolvedValue(validatedRound);

    const result = await resolveElaboration({
      companyUuid: COMPANY_UUID,
      ideaUuid: IDEA_UUID,
      actorUuid: ACTOR_UUID,
      actorType: "agent",
    });

    // Defaulted to the most recent answered round via desc ordering.
    expect(mockPrisma.elaborationRound.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { ideaUuid: IDEA_UUID, companyUuid: COMPANY_UUID, status: "answered" },
        orderBy: { roundNumber: "desc" },
      })
    );

    expect(mockPrisma.elaborationRound.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { uuid: ROUND_UUID },
        data: expect.objectContaining({ status: "validated" }),
      })
    );

    expect(mockPrisma.idea.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { uuid: IDEA_UUID },
        data: { status: "elaborated", elaborationStatus: "resolved" },
      })
    );

    expect(mockCreateActivity).toHaveBeenCalledWith(
      expect.objectContaining({ action: "elaboration_resolved" })
    );
    expect(mockEventBus.emitChange).toHaveBeenCalled();
    expect(result).toBeDefined();
  });

  it("should resolve a specific answered round when roundUuid is provided", async () => {
    const answeredRound = makeRound({ status: "answered" });

    mockPrisma.idea.findFirst.mockResolvedValue(makeIdea());
    mockPrisma.elaborationRound.findFirst.mockResolvedValue(answeredRound);
    mockPrisma.elaborationRound.update.mockResolvedValue({});
    mockPrisma.idea.update.mockResolvedValue({});
    mockPrisma.elaborationRound.findUnique.mockResolvedValue(
      makeRound({ status: "validated", validatedAt: now })
    );

    await resolveElaboration({
      companyUuid: COMPANY_UUID,
      ideaUuid: IDEA_UUID,
      roundUuid: ROUND_UUID,
      actorUuid: ACTOR_UUID,
      actorType: "agent",
    });

    // Looked up the explicit round, not the desc-ordered default.
    expect(mockPrisma.elaborationRound.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { uuid: ROUND_UUID, ideaUuid: IDEA_UUID, companyUuid: COMPANY_UUID },
      })
    );
    expect(mockPrisma.idea.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: { status: "elaborated", elaborationStatus: "resolved" },
      })
    );
  });

  it("should throw when there is no answered round to resolve", async () => {
    mockPrisma.idea.findFirst.mockResolvedValue(makeIdea());
    mockPrisma.elaborationRound.findFirst.mockResolvedValue(null);

    await expect(
      resolveElaboration({
        companyUuid: COMPANY_UUID,
        ideaUuid: IDEA_UUID,
        actorUuid: ACTOR_UUID,
        actorType: "agent",
      })
    ).rejects.toThrow("no answered round to resolve");
  });

  it("should throw if an explicit round is not in answered status", async () => {
    mockPrisma.idea.findFirst.mockResolvedValue(makeIdea());
    mockPrisma.elaborationRound.findFirst.mockResolvedValue(
      makeRound({ status: "pending_answers" })
    );

    await expect(
      resolveElaboration({
        companyUuid: COMPANY_UUID,
        ideaUuid: IDEA_UUID,
        roundUuid: ROUND_UUID,
        actorUuid: ACTOR_UUID,
        actorType: "agent",
      })
    ).rejects.toThrow("expected 'answered'");
  });

  it("should throw if actor is not the idea assignee", async () => {
    mockPrisma.idea.findFirst.mockResolvedValue(
      makeIdea({ assigneeUuid: "other-agent" })
    );

    await expect(
      resolveElaboration({
        companyUuid: COMPANY_UUID,
        ideaUuid: IDEA_UUID,
        actorUuid: ACTOR_UUID,
        actorType: "agent",
      })
    ).rejects.toThrow("Only the assigned agent can resolve elaboration");
  });

  it("should throw if the Idea is not found", async () => {
    mockPrisma.idea.findFirst.mockResolvedValue(null);

    await expect(
      resolveElaboration({
        companyUuid: COMPANY_UUID,
        ideaUuid: IDEA_UUID,
        actorUuid: ACTOR_UUID,
        actorType: "agent",
      })
    ).rejects.toThrow("Idea not found");
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
          status: "elaborated",
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
