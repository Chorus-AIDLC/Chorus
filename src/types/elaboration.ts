// src/types/elaboration.ts
// Type definitions for Requirements Elaboration (AI-DLC Stage 3)

export type ElaborationDepth = "minimal" | "standard" | "comprehensive";

export type ElaborationStatus = "pending_answers" | "validating" | "resolved";

export type RoundStatus = "pending_answers" | "answered" | "validated" | "needs_followup";

export type QuestionCategory =
  | "functional"
  | "non_functional"
  | "business_context"
  | "technical_context"
  | "user_scenario"
  | "scope";

export type ValidationIssueType = "contradiction" | "ambiguity" | "incomplete";

export interface QuestionOption {
  id: string;
  label: string;
  description?: string;
}

export interface QuestionInput {
  id: string;
  text: string;
  category: QuestionCategory;
  options: QuestionOption[];
  required?: boolean;
}

export interface AnswerInput {
  questionId: string;
  selectedOptionId: string | null;
  customText: string | null;
}

export interface ValidationIssueInput {
  questionId: string;
  type: ValidationIssueType;
  description: string;
}

// Response types

export interface ElaborationQuestionResponse {
  uuid: string;
  questionId: string;
  text: string;
  category: string;
  options: QuestionOption[];
  required: boolean;
  answer: {
    selectedOptionId: string | null;
    customText: string | null;
    answeredAt: string;
    answeredBy: { type: string; uuid: string };
  } | null;
  issue: {
    type: string;
    description: string;
  } | null;
}

export interface ElaborationRoundResponse {
  uuid: string;
  roundNumber: number;
  status: string;
  isAppended: boolean;
  createdBy: { type: string; uuid: string };
  validatedAt: string | null;
  questions: ElaborationQuestionResponse[];
  createdAt: string;
}

export interface ElaborationResponse {
  ideaUuid: string;
  depth: string | null;
  status: string | null;
  rounds: ElaborationRoundResponse[];
  summary: {
    totalQuestions: number;
    answeredQuestions: number;
    validatedRounds: number;
    pendingRound: number | null;
  };
}
