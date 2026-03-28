"use client";

import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  Lightbulb,
  FileText,
  CheckSquare,
  Play,
  ShieldCheck,
  PartyPopper,
  ArrowRight,
} from "lucide-react";
import { motion } from "framer-motion";
import { fadeInUp, staggerContainer, staggerItem } from "@/lib/animation";

interface WelcomeStepProps {
  onNext: () => void;
}

const PIPELINE_STEPS = [
  { icon: Lightbulb, key: "idea" },
  { icon: FileText, key: "proposal" },
  { icon: CheckSquare, key: "task" },
  { icon: Play, key: "execute" },
  { icon: ShieldCheck, key: "verify" },
  { icon: PartyPopper, key: "done" },
] as const;

export function WelcomeStep({ onNext }: WelcomeStepProps) {
  const t = useTranslations("onboarding");

  return (
    <motion.div
      variants={fadeInUp}
      initial="initial"
      animate="animate"
      exit="exit"
      className="flex w-full max-w-lg flex-col items-center gap-8"
    >
      {/* Logo and title */}
      <div className="flex flex-col items-center gap-3 text-center">
        <img src="/chorus-icon.png" alt="Chorus" className="h-16 w-16" />
        <h1 className="text-2xl font-semibold text-foreground">
          {t("welcome.title")}
        </h1>
        <p className="max-w-md text-sm text-muted-foreground">
          {t("welcome.description")}
        </p>
      </div>

      {/* AI-DLC Pipeline visual */}
      <Card className="w-full">
        <CardContent className="p-6">
          <p className="mb-4 text-center text-xs font-medium uppercase tracking-wider text-muted-foreground">
            {t("welcome.pipelineTitle")}
          </p>
          <motion.div
            variants={staggerContainer}
            initial="initial"
            animate="animate"
            className="flex flex-wrap items-center justify-center gap-2"
          >
            {PIPELINE_STEPS.map((step, i) => {
              const Icon = step.icon;
              return (
                <motion.div
                  key={step.key}
                  variants={staggerItem}
                  className="flex items-center gap-2"
                >
                  <div className="flex flex-col items-center gap-1">
                    <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-secondary">
                      <Icon className="h-5 w-5 text-primary" />
                    </div>
                    <span className="text-[10px] font-medium text-muted-foreground">
                      {t(`welcome.pipeline.${step.key}`)}
                    </span>
                  </div>
                  {i < PIPELINE_STEPS.length - 1 && (
                    <ArrowRight className="h-3 w-3 text-muted-foreground" />
                  )}
                </motion.div>
              );
            })}
          </motion.div>
        </CardContent>
      </Card>

      {/* Get Started button */}
      <Button size="lg" onClick={onNext} className="w-full max-w-xs">
        {t("welcome.getStarted")}
      </Button>
    </motion.div>
  );
}
