"use client";

import { useTranslations } from "next-intl";
import { Check } from "lucide-react";

interface StepIndicatorProps {
  currentStep: number;
  totalSteps: number;
}

const STEP_KEYS = [
  "welcome",
  "createAgent",
  "copyKey",
  "installGuide",
  "testConnection",
  "completion",
] as const;

export function StepIndicator({ currentStep, totalSteps }: StepIndicatorProps) {
  const t = useTranslations("onboarding");

  return (
    <div className="flex items-start">
      {Array.from({ length: totalSteps }, (_, i) => {
        const isCompleted = i < currentStep;
        const isCurrent = i === currentStep;

        return (
          <div key={i} className="flex flex-col items-center" style={{ minWidth: 56 }}>
            {/* Circle row with connector lines */}
            <div className="flex w-full items-center">
              {/* Left connector */}
              <div
                className={`h-px flex-1 ${
                  i === 0 ? "bg-transparent" : isCompleted ? "bg-primary" : "bg-border"
                }`}
              />
              {/* Circle */}
              <div
                className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-xs font-medium transition-colors ${
                  isCompleted
                    ? "bg-primary text-primary-foreground"
                    : isCurrent
                      ? "border-2 border-primary bg-background text-primary"
                      : "border border-border bg-background text-muted-foreground"
                }`}
              >
                {isCompleted ? <Check className="h-4 w-4" /> : i + 1}
              </div>
              {/* Right connector */}
              <div
                className={`h-px flex-1 ${
                  i === totalSteps - 1
                    ? "bg-transparent"
                    : i < currentStep
                      ? "bg-primary"
                      : "bg-border"
                }`}
              />
            </div>
            {/* Label */}
            <span
              className={`mt-1.5 hidden text-[10px] sm:block ${
                isCurrent
                  ? "font-medium text-foreground"
                  : "text-muted-foreground"
              }`}
            >
              {t(`steps.${STEP_KEYS[i]}`)}
            </span>
          </div>
        );
      })}
    </div>
  );
}
