import { describe, it, expect, vi } from "vitest";

// Mock transitive dependencies
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/event-bus", () => ({ eventBus: { emitChange: vi.fn() } }));
vi.mock("@/services/activity.service", () => ({ createActivity: vi.fn() }));
vi.mock("@/lib/uuid-resolver", () => ({}));

import {
  validateQuestionsFormat,
  formatRoundResponse,
  formatQuestionResponse,
} from "@/services/elaboration.service";

// ===== validateQuestionsFormat =====

describe("validateQuestionsFormat", () => {
  const validQuestion = {
    id: "q1",
    text: "What is the scope?",
    category: "scope" as const,
    options: [
      { id: "o1", label: "Small" },
      { id: "o2", label: "Large" },
    ],
  };

  it("should accept valid questions", () => {
    expect(() => validateQuestionsFormat([validQuestion])).not.toThrow();
  });

  it("should throw for empty questions array", () => {
    expect(() => validateQuestionsFormat([])).toThrow("At least 1 question is required");
  });

  it("should throw for more than 15 questions", () => {
    const questions = Array.from({ length: 16 }, (_, i) => ({
      ...validQuestion,
      id: `q${i}`,
    }));
    expect(() => validateQuestionsFormat(questions)).toThrow("Maximum 15 questions per round");
  });

  it("should throw for question with empty text", () => {
    const q = { ...validQuestion, text: "" };
    expect(() => validateQuestionsFormat([q])).toThrow("empty text");
  });

  it("should throw for question with whitespace-only text", () => {
    const q = { ...validQuestion, text: "   " };
    expect(() => validateQuestionsFormat([q])).toThrow("empty text");
  });

  it("should throw for question with less than 2 options", () => {
    const q = { ...validQuestion, options: [{ id: "o1", label: "Only one" }] };
    expect(() => validateQuestionsFormat([q])).toThrow("must have 2-5 options, got 1");
  });

  it("should throw for question with more than 5 options", () => {
    const q = {
      ...validQuestion,
      options: Array.from({ length: 6 }, (_, i) => ({ id: `o${i}`, label: `Opt ${i}` })),
    };
    expect(() => validateQuestionsFormat([q])).toThrow("must have 2-5 options, got 6");
  });

  it("should throw for option missing id", () => {
    const q = {
      ...validQuestion,
      options: [
        { id: "", label: "Valid" },
        { id: "o2", label: "Also valid" },
      ],
    };
    expect(() => validateQuestionsFormat([q])).toThrow("missing id or label");
  });

  it("should throw for option missing label", () => {
    const q = {
      ...validQuestion,
      options: [
        { id: "o1", label: "" },
        { id: "o2", label: "Valid" },
      ],
    };
    expect(() => validateQuestionsFormat([q])).toThrow("missing id or label");
  });

  it("should accept exactly 15 questions", () => {
    const questions = Array.from({ length: 15 }, (_, i) => ({
      ...validQuestion,
      id: `q${i}`,
    }));
    expect(() => validateQuestionsFormat(questions)).not.toThrow();
  });

  it("should accept question with exactly 5 options", () => {
    const q = {
      ...validQuestion,
      options: Array.from({ length: 5 }, (_, i) => ({ id: `o${i}`, label: `Opt ${i}` })),
    };
    expect(() => validateQuestionsFormat([q])).not.toThrow();
  });
});

// ===== formatRoundResponse =====

describe("formatRoundResponse", () => {
  const baseRound = {
    uuid: "round-uuid",
    roundNumber: 1,
    status: "pending_answers",
    createdByType: "agent",
    createdByUuid: "agent-uuid",
    validatedAt: null as Date | null,
    createdAt: new Date("2026-01-01T00:00:00Z"),
    questions: [],
  };

  it("should format round with correct structure", () => {
    const result = formatRoundResponse(baseRound);
    expect(result.uuid).toBe("round-uuid");
    expect(result.roundNumber).toBe(1);
    expect(result.status).toBe("pending_answers");
    expect(result.createdBy).toEqual({ type: "agent", uuid: "agent-uuid" });
    expect(result.validatedAt).toBeNull();
    expect(result.createdAt).toBe("2026-01-01T00:00:00.000Z");
    expect(result.questions).toEqual([]);
  });

  it("should format validatedAt as ISO string when present", () => {
    const round = { ...baseRound, validatedAt: new Date("2026-01-02T12:00:00Z") };
    const result = formatRoundResponse(round);
    expect(result.validatedAt).toBe("2026-01-02T12:00:00.000Z");
  });

  it("should format questions through formatQuestionResponse", () => {
    const round = {
      ...baseRound,
      questions: [{
        uuid: "q-uuid",
        questionId: "q1",
        text: "What scope?",
        category: "scope",
        options: [{ id: "o1", label: "Small" }],
        required: true,
        selectedOptionId: null,
        customText: null,
        answeredAt: null,
        answeredByType: null,
        answeredByUuid: null,
        issueType: null,
        issueDescription: null,
      }],
    };
    const result = formatRoundResponse(round);
    expect(result.questions).toHaveLength(1);
    expect(result.questions[0].questionId).toBe("q1");
    expect(result.questions[0].answer).toBeNull();
    expect(result.questions[0].issue).toBeNull();
  });
});

// ===== formatQuestionResponse =====

describe("formatQuestionResponse", () => {
  const baseQuestion = {
    uuid: "q-uuid",
    questionId: "q1",
    text: "What scope?",
    category: "scope",
    options: [{ id: "o1", label: "Small" }, { id: "o2", label: "Large" }],
    required: true,
    selectedOptionId: null as string | null,
    customText: null as string | null,
    answeredAt: null as Date | null,
    answeredByType: null as string | null,
    answeredByUuid: null as string | null,
    issueType: null as string | null,
    issueDescription: null as string | null,
  };

  it("should format unanswered question with null answer and issue", () => {
    const result = formatQuestionResponse(baseQuestion);
    expect(result.uuid).toBe("q-uuid");
    expect(result.questionId).toBe("q1");
    expect(result.text).toBe("What scope?");
    expect(result.category).toBe("scope");
    expect(result.options).toHaveLength(2);
    expect(result.required).toBe(true);
    expect(result.answer).toBeNull();
    expect(result.issue).toBeNull();
  });

  it("should format answered question with answer object", () => {
    const q = {
      ...baseQuestion,
      selectedOptionId: "o1",
      customText: "Some note",
      answeredAt: new Date("2026-01-02T10:00:00Z"),
      answeredByType: "user",
      answeredByUuid: "user-uuid",
    };
    const result = formatQuestionResponse(q);
    expect(result.answer).toEqual({
      selectedOptionId: "o1",
      customText: "Some note",
      answeredAt: "2026-01-02T10:00:00.000Z",
      answeredBy: { type: "user", uuid: "user-uuid" },
    });
  });

  it("should format question with issue", () => {
    const q = {
      ...baseQuestion,
      issueType: "ambiguity",
      issueDescription: "Answer is unclear",
    };
    const result = formatQuestionResponse(q);
    expect(result.issue).toEqual({
      type: "ambiguity",
      description: "Answer is unclear",
    });
  });

  it("should handle issue with null description", () => {
    const q = {
      ...baseQuestion,
      issueType: "incomplete",
      issueDescription: null,
    };
    const result = formatQuestionResponse(q);
    expect(result.issue).toEqual({
      type: "incomplete",
      description: "",
    });
  });
});
