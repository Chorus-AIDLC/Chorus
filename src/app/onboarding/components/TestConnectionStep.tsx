"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { motion } from "framer-motion";
import { fadeInUp } from "@/lib/animation";
import { CheckCircle2, Loader2 } from "lucide-react";
import { CodeBlock } from "./CodeBlock";

interface TestConnectionStepProps {
  onNext: () => void;
  onBack?: () => void;
  agentUuid: string | null;
  agentName: string | null;
  onConnectionVerified: () => void;
}

export function TestConnectionStep({
  onNext,
  onBack,
  agentUuid,
  agentName,
  onConnectionVerified,
}: TestConnectionStepProps) {
  const t = useTranslations("onboarding");
  const [status, setStatus] = useState<"waiting" | "connected">("waiting");
  const eventSourceRef = useRef<EventSource | null>(null);

  const cleanup = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
  }, []);

  const startListening = useCallback(() => {
    cleanup();
    setStatus("waiting");

    const es = new EventSource("/api/events/notifications");
    eventSourceRef.current = es;

    es.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        if (
          data.type === "new_notification" &&
          data.action === "agent_checkin" &&
          data.entityUuid === agentUuid
        ) {
          setStatus("connected");
          cleanup();
          onConnectionVerified();
        }
      } catch {
        // Ignore non-JSON messages (heartbeats, etc.)
      }
    };

    es.onerror = () => {
      // EventSource auto-reconnects; no action needed
    };
  }, [agentUuid, cleanup, onConnectionVerified]);

  useEffect(() => {
    startListening();
    return cleanup;
  }, [startListening, cleanup]);

  return (
    <motion.div
      variants={fadeInUp}
      initial="initial"
      animate="animate"
      exit="exit"
      className="flex w-full max-w-lg flex-col items-center gap-8"
    >
      <Card className="w-full">
        <CardContent className="flex flex-col items-center gap-6 p-8">
          <h2 className="text-lg font-semibold text-foreground">
            {t("testConnection.title")}
          </h2>

          {status === "waiting" && (
            <div className="flex w-full flex-col items-center gap-4">
              <div className="relative flex h-16 w-16 items-center justify-center">
                <div className="absolute h-16 w-16 animate-ping rounded-full bg-primary/20" />
                <Loader2 className="h-8 w-8 animate-spin text-primary" />
              </div>
              <p className="text-center text-sm text-muted-foreground">
                {t("testConnection.waiting")}
              </p>
              {agentName && (
                <p className="text-center text-xs text-muted-foreground">
                  {t("testConnection.waitingFor", { name: agentName })}
                </p>
              )}
              <div className="w-full">
                <p className="mb-2 text-center text-xs text-muted-foreground">
                  {t("testConnection.checkinHint")}
                </p>
                <CodeBlock code={t("testConnection.checkinPrompt")} />
              </div>
              {onBack && (
                <Button variant="outline" onClick={onBack}>
                  {t("back")}
                </Button>
              )}
            </div>
          )}

          {status === "connected" && (
            <div className="flex flex-col items-center gap-4">
              <motion.div
                initial={{ scale: 0 }}
                animate={{ scale: 1 }}
                transition={{ type: "spring", stiffness: 300, damping: 20 }}
              >
                <CheckCircle2 className="h-16 w-16 text-green-500" />
              </motion.div>
              <p className="text-center text-sm font-medium text-green-600">
                {t("testConnection.connected")}
              </p>
              <Button onClick={onNext}>{t("next")}</Button>
            </div>
          )}
        </CardContent>
      </Card>
    </motion.div>
  );
}
