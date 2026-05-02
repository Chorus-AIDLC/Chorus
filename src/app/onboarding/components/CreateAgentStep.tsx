"use client";

import { useTranslations } from "next-intl";
import { motion } from "framer-motion";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { AgentCreateForm } from "@/components/AgentCreateForm";
import { fadeInUp } from "@/lib/animation";
import { createAgentAndKeyAction } from "@/app/(dashboard)/settings/actions";

interface CreatedAgent {
  uuid: string;
  name: string;
  roles: string[];
  permissions: string[];
}

interface CreateAgentStepProps {
  onNext: () => void;
  onAgentCreated: (agent: CreatedAgent, apiKey: string) => void;
}

export function CreateAgentStep({ onNext, onAgentCreated }: CreateAgentStepProps) {
  const t = useTranslations("onboarding.createAgent");

  return (
    <motion.div
      variants={fadeInUp}
      initial="initial"
      animate="animate"
      exit="exit"
      className="flex w-full max-w-2xl flex-col items-center gap-6"
    >
      <Card className="w-full">
        <CardHeader className="text-center">
          <CardTitle>{t("title")}</CardTitle>
          <CardDescription>{t("description")}</CardDescription>
        </CardHeader>
        <CardContent>
          <AgentCreateForm
            embedded
            createAgentAndKey={createAgentAndKeyAction}
            submitLabel={t("submit")}
            submittingLabel={t("creating")}
            onAgentCreated={(agent, apiKey) => {
              onAgentCreated(agent, apiKey);
              onNext();
            }}
          />
        </CardContent>
      </Card>
    </motion.div>
  );
}
