"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { CheckCircle2, FolderKanban, Settings } from "lucide-react";
import { motion } from "framer-motion";
import { fadeInUp } from "@/lib/animation";

interface CompletionStepProps {
  createdAgent: { name: string; roles: string[] } | null;
}

export function CompletionStep({ createdAgent }: CompletionStepProps) {
  const router = useRouter();
  const t = useTranslations("onboarding");

  useEffect(() => {
    localStorage.setItem("chorus_onboarding_completed", "done");
  }, []);

  return (
    <motion.div
      variants={fadeInUp}
      initial="initial"
      animate="animate"
      exit="exit"
      className="flex w-full max-w-lg flex-col items-center gap-8"
    >
      {/* Success icon */}
      <div className="flex flex-col items-center gap-3 text-center">
        <div className="flex h-16 w-16 items-center justify-center rounded-full bg-primary/10">
          <CheckCircle2 className="h-10 w-10 text-primary" />
        </div>
        <h1 className="text-2xl font-semibold text-foreground">
          {t("completion.title")}
        </h1>
        <p className="max-w-md text-sm text-muted-foreground">
          {t("completion.description")}
        </p>
      </div>

      {/* Summary card */}
      {createdAgent && (
        <Card className="w-full">
          <CardContent className="p-6">
            <h3 className="mb-3 text-sm font-medium text-foreground">
              {t("completion.summary")}
            </h3>
            <div className="space-y-2 text-sm text-muted-foreground">
              <div className="flex justify-between">
                <span>{t("completion.agentName")}</span>
                <span className="font-medium text-foreground">
                  {createdAgent.name}
                </span>
              </div>
              <div className="flex justify-between">
                <span>{t("completion.agentRoles")}</span>
                <span className="font-medium text-foreground">
                  {createdAgent.roles.join(", ")}
                </span>
              </div>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Action buttons */}
      <div className="flex w-full max-w-xs flex-col gap-3">
        <Button
          size="lg"
          onClick={() => router.push("/projects")}
          className="w-full gap-2"
        >
          <FolderKanban className="h-4 w-4" />
          {t("completion.goToProjects")}
        </Button>
        <Button
          variant="outline"
          size="lg"
          onClick={() => router.push("/settings")}
          className="w-full gap-2"
        >
          <Settings className="h-4 w-4" />
          {t("completion.goToSettings")}
        </Button>
      </div>
    </motion.div>
  );
}
