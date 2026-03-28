"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { motion } from "framer-motion";
import { fadeInUp } from "@/lib/animation";
import { CheckCircle2, Loader2, RefreshCw } from "lucide-react";

interface TestConnectionStepProps {
  onNext: () => void;
  agentUuid: string | null;
  agentName: string | null;
  onConnectionVerified: () => void;
}

const TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export function TestConnectionStep({
  onNext,
  agentUuid,
  agentName,
  onConnectionVerified,
}: TestConnectionStepProps) {
  const t = useTranslations("onboarding");
  const [status, setStatus] = useState<"waiting" | "connected" | "timeout">("waiting");
  const eventSourceRef = useRef<EventSource | null>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cleanup = useCallback(() => {
    if (eventSourceRef.current) {
      eventSourceRef.current.close();
      eventSourceRef.current = null;
    }
    if (timeoutRef.current) {
      clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  const startListening = useCallback(() => {
    cleanup();
    setStatus("waiting");

    const es = new EventSource("/api/events/notifications");
    eventSourceRef.current = es;

    es.onmessage = async (event) => {
      try {
        const data = JSON.parse(event.data);
        // SSE pushes { type: "new_notification", notificationUuid, unreadCount }
        // Fetch recent notifications to check if agent_checkin arrived
        if (data.type === "new_notification" && agentUuid) {
          const res = await fetch("/api/notifications?unreadOnly=true");
          const result = await res.json();
          const notifications = result.success ? result.data?.notifications ?? [] : [];
          const match = notifications.find(
            (n: { action: string; entityUuid: string }) =>
              n.action === "agent_checkin" && n.entityUuid === agentUuid
          );
          if (match) {
            setStatus("connected");
            cleanup();
            onConnectionVerified();
          }
        }
      } catch {
        // Ignore non-JSON messages (heartbeats, etc.)
      }
    };

    es.onerror = () => {
      // EventSource auto-reconnects; no action needed
    };

    timeoutRef.current = setTimeout(() => {
      setStatus("timeout");
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
    }, TIMEOUT_MS);
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
            <div className="flex flex-col items-center gap-4">
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

          {status === "timeout" && (
            <div className="flex flex-col items-center gap-4">
              <p className="text-center text-sm text-muted-foreground">
                {t("testConnection.timeout")}
              </p>
              <Button variant="outline" onClick={startListening}>
                <RefreshCw className="mr-2 h-4 w-4" />
                {t("testConnection.retry")}
              </Button>
              <p className="text-center text-xs text-muted-foreground">
                {t("testConnection.skipHint")}
              </p>
            </div>
          )}
        </CardContent>
      </Card>
    </motion.div>
  );
}
