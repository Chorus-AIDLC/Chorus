"use client";

import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { motion } from "framer-motion";
import { fadeInUp } from "@/lib/animation";
import { AgentInstallGuide } from "@/components/install-guide/AgentInstallGuide";

interface InstallGuideStepProps {
  apiKey: string | null;
  onNext: () => void;
  onBack?: () => void;
}

export function InstallGuideStep({ apiKey, onNext, onBack }: InstallGuideStepProps) {
  const t = useTranslations("onboarding");

  return (
    <motion.div
      variants={fadeInUp}
      initial="initial"
      animate="animate"
      exit="exit"
      className="flex w-full max-w-2xl flex-col items-center gap-6"
    >
      <div className="text-center">
        <h2 className="text-lg font-semibold text-foreground">
          {t("steps.installGuide")}
        </h2>
        <p className="mt-1 text-sm text-muted-foreground">
          {t("install.description")}
        </p>
      </div>

      <AgentInstallGuide apiKey={apiKey} />

      <div className="flex gap-2">
        {onBack && (
          <Button variant="outline" onClick={onBack}>
            {t("back")}
          </Button>
        )}
        <Button onClick={onNext}>{t("next")}</Button>
      </div>
    </motion.div>
  );
}
