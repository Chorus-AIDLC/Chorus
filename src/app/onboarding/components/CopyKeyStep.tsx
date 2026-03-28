"use client";

import { useState, useEffect, useCallback } from "react";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { motion } from "framer-motion";
import { fadeInUp } from "@/lib/animation";
import { Copy, Check, AlertTriangle } from "lucide-react";

interface CopyKeyStepProps {
  onNext: () => void;
  apiKey: string | null;
}

export function CopyKeyStep({ onNext, apiKey }: CopyKeyStepProps) {
  const t = useTranslations("onboarding");
  const [copied, setCopied] = useState(false);

  // beforeunload warning while on this step
  const handleBeforeUnload = useCallback((e: BeforeUnloadEvent) => {
    e.preventDefault();
  }, []);

  useEffect(() => {
    window.addEventListener("beforeunload", handleBeforeUnload);
    return () => {
      window.removeEventListener("beforeunload", handleBeforeUnload);
    };
  }, [handleBeforeUnload]);

  const copyToClipboard = async () => {
    if (!apiKey) return;
    try {
      await navigator.clipboard.writeText(apiKey);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (error) {
      console.error("Failed to copy to clipboard:", error);
    }
  };

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
          <CardTitle>{t("copyKey.title")}</CardTitle>
          <CardDescription>{t("copyKey.description")}</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-4">
          {/* API Key display */}
          <div className="flex items-center gap-2">
            <code className="flex-1 overflow-x-auto rounded bg-foreground px-3 py-2 font-mono text-sm text-background">
              {apiKey ?? ""}
            </code>
            <Button
              variant="outline"
              size="sm"
              onClick={copyToClipboard}
              className="flex-shrink-0"
            >
              {copied ? (
                <>
                  <Check className="mr-1 h-4 w-4 text-green-500" />
                  {t("copyKey.copied")}
                </>
              ) : (
                <>
                  <Copy className="mr-1 h-4 w-4" />
                  {t("copyKey.copy")}
                </>
              )}
            </Button>
          </div>

          {/* Warning */}
          <div className="flex items-start gap-2 rounded-lg border border-yellow-300 bg-yellow-50 p-3 dark:border-yellow-800 dark:bg-yellow-950">
            <AlertTriangle className="mt-0.5 h-4 w-4 flex-shrink-0 text-yellow-600 dark:text-yellow-400" />
            <p className="text-sm font-medium text-yellow-700 dark:text-yellow-300">
              {t("copyKey.warning")}
            </p>
          </div>

          {/* Next button */}
          <Button onClick={onNext} className="w-full">
            {t("next")}
          </Button>
        </CardContent>
      </Card>
    </motion.div>
  );
}
