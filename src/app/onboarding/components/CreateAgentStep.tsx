"use client";

import { useTranslations } from "next-intl";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { motion } from "framer-motion";
import { fadeInUp } from "@/lib/animation";
import { AgentCreateForm } from "@/components/AgentCreateForm";
import { createAgentAndKeyAction } from "@/app/(dashboard)/settings/actions";

interface CreateAgentStepProps {
  onNext: () => void;
  onAgentCreated: (agent: { uuid: string; name: string; roles: string[] }, apiKey: string) => void;
}

export function CreateAgentStep({ onNext, onAgentCreated }: CreateAgentStepProps) {
  const t = useTranslations("onboarding");

  return (
    <motion.div
      variants={fadeInUp}
      initial="initial"
      animate="animate"
      exit="exit"
      className="flex w-full max-w-lg flex-col items-center gap-8"
    >
      <Card className="w-full">
        <CardHeader className="text-center">
          <CardTitle>{t("createAgent.title")}</CardTitle>
          <CardDescription>{t("createAgent.description")}</CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <AgentCreateForm
            createAgentAndKey={createAgentAndKeyAction}
            onAgentCreated={(agent, apiKey) => {
              onAgentCreated(
                { uuid: agent.uuid, name: agent.name, roles: agent.roles },
                apiKey
              );
              onNext();
            }}
          />
        </CardContent>
      </Card>
    </motion.div>
  );
}
