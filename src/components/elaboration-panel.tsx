"use client";

import { useState, useCallback, useRef, useEffect } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import {
  ChevronDown,
  ChevronRight,
  ChevronLeft,
  ArrowRight,
  Pencil,
  Loader2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import type {
  ElaborationResponse,
  ElaborationRoundResponse,
  ElaborationQuestionResponse,
  AnswerInput,
} from "@/types/elaboration";
import { submitElaborationAnswersAction } from "@/app/(dashboard)/projects/[uuid]/ideas/[ideaUuid]/elaboration-actions";

// Other option id prefix (when user picks "Other" and provides custom text)
const OTHER_OPTION_ID = "__other__";

// Category i18n key mapping
const categoryI18nKeys: Record<string, string> = {
  functional: "functional",
  non_functional: "nonFunctional",
  business_context: "businessContext",
  technical_context: "technicalContext",
  user_scenario: "userScenario",
  scope: "scope",
};

interface ElaborationPanelProps {
  ideaUuid: string;
  elaboration: ElaborationResponse | null;
  onRefresh?: () => Promise<void> | void;
}

export function ElaborationPanel({
  ideaUuid,
  elaboration,
  onRefresh,
}: ElaborationPanelProps) {
  const t = useTranslations("elaboration");
  const router = useRouter();

  if (!elaboration || elaboration.rounds.length === 0) {
    return null;
  }

  const { summary, rounds } = elaboration;

  return (
    <div className="space-y-3">
      {/* Header row */}
      <div className="flex items-center justify-between">
        <label className="text-[11px] font-medium uppercase tracking-wide text-[#9A9A9A]">
          {t("title")}
        </label>
        <span className="text-xs font-medium text-[#C67A52]">
          {t("answeredCounter", {
            answered: summary.answeredQuestions,
            total: summary.totalQuestions,
          })}
        </span>
      </div>

      {/* Round cards */}
      <div className="space-y-2.5">
        {rounds.map((round) => (
          <RoundCard
            key={round.uuid}
            round={round}
            ideaUuid={ideaUuid}
            onAnswered={async () => {
              await onRefresh?.();
              router.refresh();
            }}
          />
        ))}
      </div>
    </div>
  );
}

// ===== Round Card =====

interface RoundCardProps {
  round: ElaborationRoundResponse;
  ideaUuid: string;
  onAnswered: () => Promise<void> | void;
}

function RoundCard({ round, ideaUuid, onAnswered }: RoundCardProps) {
  const t = useTranslations("elaboration");
  // `needs_followup` means all questions in this round were answered, but
  // validation flagged issues — a new follow-up round handles those.
  // So this round should display as "done" (read-only Q&A view).
  const isPending = round.status === "pending_answers";
  const isDone =
    round.status === "answered" ||
    round.status === "validated" ||
    round.status === "needs_followup";
  const [isOpen, setIsOpen] = useState(isPending);

  return (
    <Collapsible open={isOpen} onOpenChange={setIsOpen}>
      <div
        className="overflow-hidden rounded-xl border border-[#E5E0D8] bg-white"
      >
        {/* Collapsible header */}
        <CollapsibleTrigger asChild>
          <button
            type="button"
            className={`flex w-full items-center justify-between px-4 py-3 text-left transition-colors cursor-pointer hover:bg-[#FAF8F4] ${
              isOpen ? "bg-[#F7F6F3] border-b border-[#E5E0D8]" : ""
            }`}
          >
            <div className="flex items-center gap-2">
              {/* Chevron */}
              {isOpen ? (
                <ChevronDown className="h-4 w-4 text-[#6B6B6B]" />
              ) : (
                <ChevronRight className="h-4 w-4 text-[#6B6B6B]" />
              )}

              {/* Round number badge */}
              <span
                className={`flex h-[22px] w-[22px] shrink-0 items-center justify-center rounded-full text-[11px] font-semibold text-white ${
                  isPending ? "bg-[#C67A52]" : "bg-[#888780]"
                }`}
              >
                {round.roundNumber}
              </span>

              {/* Label */}
              <span className="text-[13px] font-semibold text-[#2C2C2C]">
                {t("roundLabel", { number: round.roundNumber })}
              </span>

              {/* Question count (shown when collapsed) */}
              {!isOpen && (
                <span className="text-xs text-[#9A9A9A]">
                  &middot; {t("questionCount", { count: round.questions.length })}
                </span>
              )}
            </div>

            {/* Status badge */}
            {isDone ? (
              <span className="rounded bg-[#E8F5E9] px-2 py-0.5 text-[10px] font-medium text-[#2E7D32]">
                {t("statusAnswered")}
              </span>
            ) : (
              <span className="rounded bg-[#FFF3E0] px-2 py-0.5 text-[10px] font-medium text-[#E65100]">
                {t("pendingAnswers")}
              </span>
            )}
          </button>
        </CollapsibleTrigger>

        <CollapsibleContent>
          {isPending ? (
            <PendingRoundContent
              round={round}
              ideaUuid={ideaUuid}
              onAnswered={onAnswered}
            />
          ) : (
            <AnsweredRoundContent round={round} />
          )}
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}

// ===== Answered Round Content (Q/A text format) =====

interface AnsweredRoundContentProps {
  round: ElaborationRoundResponse;
}

function AnsweredRoundContent({ round }: AnsweredRoundContentProps) {
  const t = useTranslations("elaboration");

  return (
    <div className="space-y-4 px-4 py-4">
      {round.questions.map((question, index) => {
        const selectedOption = question.answer?.selectedOptionId
          ? question.options.find(
              (o) => o.id === question.answer?.selectedOptionId
            )
          : null;
        const answerText =
          question.answer?.customText ||
          selectedOption?.label ||
          t("noAnswer");
        const categoryKey =
          categoryI18nKeys[question.category] || question.category;

        return (
          <div key={question.uuid}>
            {/* Q row: question text + category right-aligned */}
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs leading-relaxed text-[#6B6B6B]">
                Q: {question.text}
              </span>
              <span className="shrink-0 text-[11px] italic text-[#B0B0B0]">
                {t(`category.${categoryKey}`)}
              </span>
            </div>
            {/* A row */}
            <p className="mt-1 text-xs font-medium leading-relaxed text-[#2C2C2C]">
              A: {answerText}
            </p>
            {/* Divider (not after last) */}
            {index < round.questions.length - 1 && (
              <div className="mt-4 h-px bg-[#F0EEEA]" />
            )}
          </div>
        );
      })}
    </div>
  );
}

// ===== Pending Round Content (carousel/slide UI) =====

interface PendingRoundContentProps {
  round: ElaborationRoundResponse;
  ideaUuid: string;
  onAnswered: () => Promise<void> | void;
}

const SLIDE_ANIMATION_MS = 200;

function PendingRoundContent({
  round,
  ideaUuid,
  onAnswered,
}: PendingRoundContentProps) {
  const t = useTranslations("elaboration");
  const [currentIndex, setCurrentIndex] = useState(0);
  const currentIndexRef = useRef(currentIndex);
  const [enterFrom, setEnterFrom] = useState<"left" | "right">("right");
  const [answers, setAnswers] = useState<Record<string, AnswerInput>>({});
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    currentIndexRef.current = currentIndex;
  }, [currentIndex]);

  const goTo = useCallback(
    (next: number, dir: "left" | "right") => {
      // dir="left" means content moves left → new slide enters from right
      setEnterFrom(dir === "left" ? "right" : "left");
      setCurrentIndex(next);
    },
    []
  );

  const questions = round.questions;
  const question = questions[currentIndex];
  const categoryKey =
    categoryI18nKeys[question.category] || question.category;

  const handleSelectOption = useCallback(
    (questionId: string, optionId: string) => {
      setAnswers((prev) => ({
        ...prev,
        [questionId]: {
          questionId,
          selectedOptionId: optionId === OTHER_OPTION_ID ? null : optionId,
          customText:
            optionId === OTHER_OPTION_ID
              ? prev[questionId]?.customText || ""
              : null,
        },
      }));
      // Auto-advance to next question with slide-left animation
      if (optionId !== OTHER_OPTION_ID) {
        const nextIdx = Math.min(questions.length - 1, currentIndexRef.current + 1);
        if (nextIdx !== currentIndexRef.current) {
          setTimeout(() => goTo(nextIdx, "left"), SLIDE_ANIMATION_MS);
        }
      }
    },
    [questions.length, goTo]
  );

  const handleCustomTextChange = useCallback(
    (questionId: string, text: string) => {
      setAnswers((prev) => ({
        ...prev,
        [questionId]: {
          ...prev[questionId],
          questionId,
          selectedOptionId: null,
          customText: text,
        },
      }));
    },
    []
  );

  const getSelectedOptionId = (questionId: string): string | null => {
    const answer = answers[questionId];
    if (!answer) return null;
    if (
      answer.selectedOptionId === null &&
      answer.customText !== null &&
      answer.customText !== undefined
    ) {
      return OTHER_OPTION_ID;
    }
    return answer.selectedOptionId || null;
  };

  const allRequiredAnswered = questions
    .filter((q) => q.required)
    .every((q) => {
      const answer = answers[q.questionId];
      if (!answer) return false;
      if (answer.selectedOptionId) return true;
      if (answer.customText && answer.customText.trim()) return true;
      return false;
    });

  const handleSubmit = async () => {
    setIsSubmitting(true);
    setError(null);

    const answerList: AnswerInput[] = Object.values(answers);
    const result = await submitElaborationAnswersAction(
      ideaUuid,
      round.uuid,
      answerList
    );

    if (result.success) {
      await onAnswered();
      setIsSubmitting(false);
    } else {
      setIsSubmitting(false);
      setError(result.error || t("submitFailed"));
    }
  };

  const selectedOptionId = getSelectedOptionId(question.questionId);
  const isOtherSelected = selectedOptionId === OTHER_OPTION_ID;

  return (
    <div className="overflow-hidden p-3.5">
      {/* Sliding content wrapper — key change triggers CSS enter animation */}
      <div
        key={currentIndex}
        className={enterFrom === "right" ? "animate-in slide-in-from-right-4 duration-200" : "animate-in slide-in-from-left-4 duration-200"}
      >
      {/* Question text (left) + Nav (right) */}
      <div className="flex items-start justify-between gap-3">
        <div className="flex-1 text-sm text-[#6B6B6B]">{question.text}</div>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="icon"
            onClick={() => goTo(currentIndex - 1, "right")}
            disabled={currentIndex === 0}
            className="h-7 w-7 text-[#6B6B6B] disabled:opacity-30"
          >
            <ChevronLeft className="h-4 w-4" />
          </Button>
          <span className="text-xs text-[#9A9A9A]">
            {t("navCounter", {
              current: currentIndex + 1,
              total: questions.length,
            })}
          </span>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => goTo(currentIndex + 1, "left")}
            disabled={currentIndex === questions.length - 1}
            className="h-7 w-7 text-[#6B6B6B] disabled:opacity-30"
          >
            <ChevronRight className="h-4 w-4" />
          </Button>
        </div>
      </div>

      {/* Options list */}
      <div className="mt-3">
        {question.options.map((option, idx) => {
          const isSelected = selectedOptionId === option.id;
          return (
            <div key={option.id}>
              <Button
                variant="ghost"
                onClick={() =>
                  handleSelectOption(question.questionId, option.id)
                }
                className={`flex w-full items-center justify-between px-3.5 py-3 h-auto text-left transition-colors rounded-none ${
                  isSelected
                    ? "bg-[#F7F6F3]"
                    : "hover:bg-[#FAF8F4]"
                }`}
              >
                <span className="flex items-center gap-2.5">
                  <span
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md bg-[#E5E0D8] text-xs font-medium text-[#5F5E5A]"
                  >
                    {idx + 1}
                  </span>
                  <span className="flex flex-col items-start">
                    <span className="text-[13px] text-[#2C2C2A]">
                      {option.label}
                    </span>
                    {option.description && (
                      <span className="text-[11px] text-[#9A9A9A]">
                        {option.description}
                      </span>
                    )}
                  </span>
                </span>
                {isSelected && (
                  <ArrowRight className="h-4 w-4 text-[#888780]" />
                )}
              </Button>
              {idx < question.options.length - 1 && (
                <div className="h-px bg-[#F0EEEA]" />
              )}
            </div>
          );
        })}

        {/* Divider before Other */}
        <div className="h-px bg-[#F0EEEA]" />

        {/* Something else (Other) option — inline editable */}
        <div
          className={`flex w-full items-center gap-2.5 px-3.5 py-3 transition-colors ${
            isOtherSelected ? "bg-[#F7F6F3]" : "hover:bg-[#FAF8F4]"
          }`}
        >
          <span
            className="flex h-7 w-7 shrink-0 cursor-pointer items-center justify-center rounded-md bg-[#E5E0D8]"
            onClick={() =>
              handleSelectOption(question.questionId, OTHER_OPTION_ID)
            }
          >
            <Pencil className="h-3.5 w-3.5 text-[#B4B2A9]" />
          </span>
          {isOtherSelected ? (
            <Input
              type="text"
              value={answers[question.questionId]?.customText || ""}
              onChange={(e) =>
                handleCustomTextChange(question.questionId, e.target.value)
              }
              placeholder={t("somethingElse")}
              className="flex-1 border-none bg-transparent text-[13px] text-[#2C2C2A] placeholder:italic placeholder:text-[#B4B2A9] shadow-none focus-visible:ring-0"
              autoFocus
            />
          ) : (
            <Button
              variant="ghost"
              onClick={() =>
                handleSelectOption(question.questionId, OTHER_OPTION_ID)
              }
              className="flex-1 justify-start text-left text-[13px] italic text-[#B4B2A9] h-auto p-0 hover:bg-transparent"
            >
              {t("somethingElse")}
            </Button>
          )}
        </div>
      </div>
      </div>

      {/* Error message */}
      {error && (
        <div className="mt-3 rounded-lg bg-destructive/10 p-2.5 text-[12px] text-destructive">
          {error}
        </div>
      )}

      {/* Category (left) + Submit (right) */}
      <div className="mt-3 flex items-center justify-between">
        <span className="flex items-center gap-1.5 text-[11px] text-[#B0B0B0]">
          <span className="inline-block h-1.5 w-1.5 rounded-full bg-[#C67A52]" />
          {t(`category.${categoryKey}`)}
        </span>
        <Button
          onClick={handleSubmit}
          disabled={!allRequiredAnswered || isSubmitting}
          className="bg-[#C67A52] hover:bg-[#B56A42] text-white text-[13px]"
        >
          {isSubmitting ? (
            <>
              <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" />
              {t("submitting")}
            </>
          ) : (
            t("submitAnswers")
          )}
        </Button>
      </div>
    </div>
  );
}
