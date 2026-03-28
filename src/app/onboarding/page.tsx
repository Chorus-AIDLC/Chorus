"use client";

import { OnboardingWizard } from "./components/OnboardingWizard";

export default function OnboardingPage() {
  return (
    <div className="flex min-h-screen items-center justify-center bg-background p-4">
      <OnboardingWizard />
    </div>
  );
}
