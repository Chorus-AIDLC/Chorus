"use client";

import { useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { AnimatePresence } from "framer-motion";
import { StepIndicator } from "./StepIndicator";
import { WelcomeStep } from "./WelcomeStep";
import { CreateAgentStep } from "./CreateAgentStep";
import { CopyKeyStep } from "./CopyKeyStep";
import { InstallGuideStep } from "./InstallGuideStep";
import { TestConnectionStep } from "./TestConnectionStep";
import { CompletionStep } from "./CompletionStep";

const TOTAL_STEPS = 6;

interface CreatedAgent {
  uuid: string;
  name: string;
  roles: string[];
}

export function OnboardingWizard() {
  const router = useRouter();
  const t = useTranslations("onboarding");

  const [currentStep, setCurrentStep] = useState(0);
  const [createdAgent, setCreatedAgent] = useState<CreatedAgent | null>(null);
  const [apiKey, setApiKey] = useState<string | null>(null);
  const [selectedClient, setSelectedClient] = useState<string | null>(null);
  const [connectionVerified, setConnectionVerified] = useState(false);

  const handleNext = useCallback(() => {
    setCurrentStep((prev) => Math.min(prev + 1, TOTAL_STEPS - 1));
  }, []);

  const handleBack = useCallback(() => {
    setCurrentStep((prev) => Math.max(prev - 1, 0));
  }, []);

  const handleSkip = useCallback(() => {
    localStorage.setItem("chorus_onboarding_completed", "skipped");
    router.push("/projects");
  }, [router]);

  // Keep setter available for future steps
  void setSelectedClient;

  const handleAgentCreated = useCallback(
    (agent: CreatedAgent, key: string) => {
      setCreatedAgent(agent);
      setApiKey(key);
    },
    []
  );

  const handleConnectionVerified = useCallback(() => {
    setConnectionVerified(true);
    setCurrentStep(5); // Advance to CompletionStep
  }, []);

  const isCompletionStep = currentStep === TOTAL_STEPS - 1;

  return (
    <div className="flex w-full max-w-2xl flex-col items-center gap-8">
      {/* Step indicator */}
      <StepIndicator currentStep={currentStep} totalSteps={TOTAL_STEPS} />

      {/* Step content */}
      <AnimatePresence mode="wait">
        {currentStep === 0 && <WelcomeStep key="welcome" onNext={handleNext} />}
        {currentStep === 1 && (
          <CreateAgentStep
            key="createAgent"
            onNext={handleNext}
            onAgentCreated={handleAgentCreated}
          />
        )}
        {currentStep === 2 && (
          <CopyKeyStep key="copyKey" onNext={handleNext} apiKey={apiKey} />
        )}
        {currentStep === 3 && (
          <InstallGuideStep key="installGuide" apiKey={apiKey} onNext={handleNext} onBack={handleBack} />
        )}
        {currentStep === 4 && (
          <TestConnectionStep
            key="testConnection"
            onNext={handleNext}
            onBack={handleBack}
            agentUuid={createdAgent?.uuid ?? null}
            agentName={createdAgent?.name ?? null}
            onConnectionVerified={handleConnectionVerified}
          />
        )}
        {currentStep === 5 && (
          <CompletionStep key="completion" createdAgent={createdAgent} />
        )}
      </AnimatePresence>

      {/* Global skip link - visible on all steps except completion */}
      {!isCompletionStep && (
        <Button
          variant="link"
          size="sm"
          onClick={handleSkip}
          className="text-muted-foreground"
        >
          {t("skip")}
        </Button>
      )}
    </div>
  );
}
