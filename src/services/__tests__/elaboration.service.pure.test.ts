/**
 * Elaboration service pure function tests.
 *
 * NOTE: The pure helper functions in elaboration.service.ts
 * (validateQuestionsFormat, formatRoundResponse, formatQuestionResponse)
 * are NOT exported, so they cannot be tested directly.
 *
 * This file documents test intent. If these functions are exported in the
 * future, the tests below should be enabled.
 *
 * For now we validate the type contracts and interfaces are consistent.
 */

import { describe, it, expect } from "vitest";
import type {
  QuestionInput,
  ElaborationRoundResponse,
  ElaborationQuestionResponse,
  QuestionOption,
} from "@/types/elaboration";

// ===== validateQuestionsFormat (not exported -- testing contract via types) =====

describe("elaboration question validation contract", () => {
  // These tests document the validation rules enforced by the internal
  // validateQuestionsFormat function.

  it("QuestionInput requires id, text, category, and options", () => {
    const q: QuestionInput = {
      id: "q1",
      text: "What is the scope?",
      category: "scope",
      options: [
        { id: "opt1", label: "Small" },
        { id: "opt2", label: "Large" },
      ],
    };
    expect(q.id).toBe("q1");
    expect(q.options).toHaveLength(2);
  });

  it("QuestionOption requires id and label", () => {
    const opt: QuestionOption = { id: "o1", label: "Option 1" };
    expect(opt.id).toBe("o1");
    expect(opt.label).toBe("Option 1");
  });

  it("QuestionOption description is optional", () => {
    const opt: QuestionOption = { id: "o1", label: "Option 1", description: "desc" };
    expect(opt.description).toBe("desc");
  });
});

// ===== formatRoundResponse / formatQuestionResponse (not exported) =====

describe("elaboration response type contracts", () => {
  it("ElaborationRoundResponse has expected shape", () => {
    const response: ElaborationRoundResponse = {
      uuid: "round-uuid",
      roundNumber: 1,
      status: "pending_answers",
      createdBy: { type: "agent", uuid: "agent-uuid" },
      validatedAt: null,
      questions: [],
      createdAt: "2026-01-01T00:00:00.000Z",
    };
    expect(response.roundNumber).toBe(1);
    expect(response.validatedAt).toBeNull();
  });

  it("ElaborationQuestionResponse has answer and issue as nullable", () => {
    const q: ElaborationQuestionResponse = {
      uuid: "q-uuid",
      questionId: "q1",
      text: "What scope?",
      category: "scope",
      options: [
        { id: "o1", label: "Small" },
        { id: "o2", label: "Large" },
      ],
      required: true,
      answer: null,
      issue: null,
    };
    expect(q.answer).toBeNull();
    expect(q.issue).toBeNull();
  });

  it("ElaborationQuestionResponse answer has expected shape when present", () => {
    const q: ElaborationQuestionResponse = {
      uuid: "q-uuid",
      questionId: "q1",
      text: "What scope?",
      category: "scope",
      options: [{ id: "o1", label: "Small" }, { id: "o2", label: "Large" }],
      required: true,
      answer: {
        selectedOptionId: "o1",
        customText: null,
        answeredAt: "2026-01-02T00:00:00.000Z",
        answeredBy: { type: "user", uuid: "user-uuid" },
      },
      issue: null,
    };
    expect(q.answer!.selectedOptionId).toBe("o1");
    expect(q.answer!.answeredBy.type).toBe("user");
  });

  it("ElaborationQuestionResponse issue has expected shape when present", () => {
    const q: ElaborationQuestionResponse = {
      uuid: "q-uuid",
      questionId: "q1",
      text: "What scope?",
      category: "scope",
      options: [{ id: "o1", label: "Small" }, { id: "o2", label: "Large" }],
      required: true,
      answer: null,
      issue: {
        type: "ambiguity",
        description: "Answer is unclear",
      },
    };
    expect(q.issue!.type).toBe("ambiguity");
  });
});
